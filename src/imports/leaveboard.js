// LeaveBoard exports → staged vendor snapshots (and, only where explicitly
// requested, opening balances / dated requests). Reports supported:
//   general_situation  – aggregate per person; totals row = checksum; ZERO ledger writes
//   annual_situation   – Used / Available / Allowance per category; candidate balances
//   attendance         – daily codes for a month; preserved verbatim; ZERO ledger writes
//   leaves             – dated requests with status/ID (format to be confirmed with a real export)
import { tx, uid, now, J, P, audit, bad, forbid } from '../db.js';
import { isOps } from '../domain/authz.js';
import { toX100, fmtX100 } from '../domain/decimal.js';
import { addDays, isISODate } from '../domain/dates.js';
import { chargeableDays, holidaysFor, activePolicy, postLedger, balance } from '../domain/leave.js';
import { currentEmployment } from '../domain/authz.js';
import { readWorkbook, sha256, str, val, parseVendorDate } from './xlsx.js';
import { saveBatch, findExisting, matchPerson, markApplied, requirePreviewed, getBatch } from './batch.js';

const AMMAN_OFFSET_H = 3; // Asia/Amman is UTC+3 all year since 2022

export function detectReport(sheets) {
  const data = sheets.find((s) => s.name === 'Data') || sheets[0];
  const h = (data.rows[0] || []).map(str);
  // real LeaveBoard Reports → Leaves: Employee | Leave | Range | Days | Status | Approver | Comment | Approver's comment | Registered on
  if (h[0] === 'Employee' && h.includes('Leave') && h.includes('Range') && h.includes('Status')) return 'leaves';
  if (h.some((x) => /leave type/i.test(x)) && h.some((x) => /status/i.test(x)) && h.some((x) => /^employee$/i.test(x))) return 'leaves';
  if (h[0] !== 'Employee') return null;
  if (h[1] === 'Year' && h.some((x) => / - Used$/.test(x))) return 'annual_situation';
  if (h[1] === 'Working' && h[2] === 'Worked') return 'general_situation';
  if (/^[A-Z][a-z] \d{1,2}$/.test(h[1] || '')) return 'attendance';
  if (h.some((x) => /leave type/i.test(x)) && h.some((x) => /status/i.test(x))) return 'leaves';
  return null;
}

function details(sheets) {
  const d = sheets.find((s) => s.name === 'Details');
  let generatedUtc = null;
  for (const r of d?.rows || []) {
    const m = /generated\.on\s*:\s*(\S+)/.exec(str(r[0]));
    if (m) generatedUtc = m[1];
  }
  let generatedAmman = null;
  if (generatedUtc) {
    const t = new Date(generatedUtc);
    if (!Number.isNaN(t.getTime())) generatedAmman = new Date(t.getTime() + AMMAN_OFFSET_H * 3600e3).toISOString().replace('Z', '+03:00').slice(0, 19) + '+03:00';
  }
  return { generatedUtc, generatedAmman };
}

/** Preview any LeaveBoard export. Opts: { reportingFrom, reportingTo, filtersNote, dateFormat } */
export async function previewLeaveboard(db, actor, { filename, buffer, reportingFrom, reportingTo, filtersNote, dateFormat = 'MM/DD/YYYY' }) {
  if (!isOps(actor)) throw forbid();
  const sha = sha256(buffer);
  const sheets = await readWorkbook(buffer);
  const kind = detectReport(sheets);
  if (!kind) throw bad('Not a recognised LeaveBoard export (expected a Data sheet starting with "Employee")');
  const existing = findExisting(db, actor.tenantId, `leaveboard_${kind}`, sha);
  if (existing) return { ...getBatch(db, actor, existing.id), duplicateOf: existing.id };
  const det = details(sheets);
  const data = sheets.find((s) => s.name === 'Data') || sheets[0];
  const parsed = { general_situation: parseGeneral, annual_situation: parseAnnual, attendance: parseAttendance, leaves: parseLeaves }[kind](db, actor, data, { det, dateFormat });
  if (kind !== 'attendance' && (reportingFrom || reportingTo)) {
    parsed.summary.reporting_range = { from: reportingFrom ?? null, to: reportingTo ?? null, source: 'entered by importer' };
  }
  parsed.summary.generated = det;
  parsed.summary.kind = kind;
  return saveBatch(db, actor, { kind: `leaveboard_${kind}`, filename, sha, vendor: 'LeaveBoard', generatedAt: det.generatedUtc,
    reportingFrom: parsed.reportingFrom ?? reportingFrom, reportingTo: parsed.reportingTo ?? reportingTo, filtersNote, summary: parsed.summary, rows: parsed.rows });
}

function match(db, actor, name) { return matchPerson(db, actor.tenantId, { name, source: 'leaveboard' }); }

// ------------------------------------------------------- General Situation --
function parseGeneral(db, actor, sheet) {
  const header = sheet.rows[0].map(str);
  const cols = header.slice(1).filter(Boolean);
  const rows = []; const sums = Object.fromEntries(cols.map((c) => [c, 0])); let totals = null; const blocking = []; const warnings = [];
  sheet.rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2;
    const name = str(r[0]);
    const values = {}; const raw = {}; const issues = [];
    cols.forEach((c, j) => {
      const cell = r[j + 1];
      raw[c] = val(cell);
      if (cell?.error) issues.push(`${c}: formula error ${cell.error}`);
      try { values[c] = toX100(val(cell)); } catch (e) { issues.push(`${c}: ${e.message}`); }
    });
    if (!name && cols.every((c) => values[c] === null)) return; // blank
    if (!name) { totals = { rowNo, values, raw }; rows.push({ sheet: sheet.name, rowNo, sourceKey: 'TOTALS', raw, matchStatus: 'n/a', issues: ['Unlabeled totals row used as checksum'], action: 'skip' }); return; }
    for (const c of cols) if (values[c] !== null) sums[c] += values[c];
    const m = match(db, actor, name);
    const ident = (values.Working ?? 0) - (values.Worked ?? 0) - ((values['Sick leave'] ?? 0) + (values['Compensation of Overtime'] ?? 0) + (values['Wedding Leave'] ?? 0));
    if (ident !== 0) issues.push(`Working − Worked ≠ Sick + COO + Wedding (difference ${fmtX100(ident)}) — semantics to confirm`);
    if (m.matchStatus !== 'alias' && m.matchStatus !== 'email') issues.push(`Person not matched (${m.matchStatus}) — confirm in roster before linking`);
    rows.push({ sheet: sheet.name, rowNo, sourceKey: `name:${name}`, raw: { Employee: name, ...raw }, userId: m.userId, matchStatus: m.matchStatus, issues, action: issues.some((x) => /formula error|decimal/.test(x)) ? 'reject' : m.userId ? 'insert' : 'review' });
  });
  const checksum = {};
  if (!totals) blocking.push('No totals row found to reconcile against');
  else for (const c of cols) {
    checksum[c] = { rows: fmtX100(sums[c]), source_total: fmtX100(totals.values[c]), ok: sums[c] === totals.values[c] };
    if (!checksum[c].ok) blocking.push(`${c}: named rows sum to ${fmtX100(sums[c])} but totals row says ${fmtX100(totals.values[c])}`);
  }
  warnings.push('No report start/end date in file — record the selected date range separately', 'Units per category unconfirmed (days vs hours) — values kept as vendor figures', 'This report never creates ledger entries');
  return { summary: { named_rows: rows.filter((r) => r.sourceKey !== 'TOTALS').length, columns: cols, checksum, blocking, warnings, ledger_entries_planned: 0 }, rows };
}

// -------------------------------------------------------- Annual Situation --
function parseAnnual(db, actor, sheet) {
  const header = sheet.rows[0].map(str);
  const cats = [...new Set(header.filter((h) => / - (Used|Available|Allowance)$/.test(h)).map((h) => h.replace(/ - (Used|Available|Allowance)$/, '')))];
  const rows = []; const blocking = []; const totals = {};
  sheet.rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2; const name = str(r[0]);
    if (!name) return;
    const year = Number(val(r[1]));
    const raw = { Employee: name, Year: val(r[1]) }; const issues = []; const values = {};
    for (const c of cats) {
      for (const metric of ['Used', 'Available', 'Allowance']) {
        const idx = header.indexOf(`${c} - ${metric}`);
        raw[`${c} - ${metric}`] = val(r[idx]);
        try { values[`${c}|${metric}`] = toX100(val(r[idx])); } catch (e) { issues.push(e.message); }
      }
      const [u, a, al] = ['Used', 'Available', 'Allowance'].map((m) => values[`${c}|${m}`]);
      if (u === null || a === null || al === null) issues.push(`${c}: missing value`);
      else if (u + a !== al) issues.push(`${c}: Used + Available (${fmtX100(u + a)}) ≠ Allowance (${fmtX100(al)})`);
      if (a !== null && a < 0) issues.push(`${c}: negative available balance ${fmtX100(a)} in source — confirm policy`);
      totals[c] = totals[c] || { Used: 0, Available: 0, Allowance: 0 };
      for (const m of ['Used', 'Available', 'Allowance']) totals[c][m] += values[`${c}|${m}`] ?? 0;
    }
    if (!Number.isInteger(year)) issues.push('Year missing');
    const m = match(db, actor, name);
    const hard = issues.some((x) => /≠|missing|decimal/.test(x));
    rows.push({ sheet: sheet.name, rowNo, sourceKey: `name:${name}:${year}`, raw, userId: m.userId, matchStatus: m.matchStatus, issues, action: hard ? 'reject' : m.userId ? 'insert' : 'review' });
  });
  const sum = Object.fromEntries(Object.entries(totals).map(([c, t]) => [c, Object.fromEntries(Object.entries(t).map(([k, v]) => [k, fmtX100(v)]))]));
  return { summary: { named_rows: rows.length, categories: cats, totals: sum, identity_rows_checked: rows.length * cats.length,
    identity_failures: rows.flatMap((r) => r.issues.filter((x) => x.includes('≠'))).length, blocking,
    warnings: ['Candidate balance snapshot only — opening balances are posted separately at the agreed cutover', 'WFH treated as off-site usage; relation of annual allowance to the monthly rule is unconfirmed'] }, rows };
}

// -------------------------------------------------------------- Attendance --
function parseAttendance(db, actor, sheet, { det, dateFormat }) {
  const header = sheet.rows[0].map(str);
  const dayCols = header.map((h, i) => ({ h, i, d: /^[A-Z][a-z] (\d{1,2})$/.exec(h) })).filter((x) => x.d);
  const summaryCols = header.map((h, i) => ({ h, i })).filter((x) => x.i > 0 && !/^[A-Z][a-z] \d{1,2}$/.test(x.h) && x.h);
  let range = null; const rows = []; const blocking = []; const codes = new Set();
  for (const r of sheet.rows) {
    const m = /Attendance for (\S+) - (\S+)/.exec(str(r[0]));
    if (m) range = { from: parseVendorDate(m[1], dateFormat), to: parseVendorDate(m[2], dateFormat), raw: str(r[0]) };
  }
  if (!range?.from || !range?.to) blocking.push('Date-range footer not found or not parseable — cannot date the daily cells');
  const generatedDay = det.generatedAmman ? det.generatedAmman.slice(0, 10) : null;
  sheet.rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2; const name = str(r[0]);
    if (!name || /^Attendance for /.test(name)) return;
    const issues = []; const days = [];
    for (const c of dayCols) {
      const date = range?.from ? addDays(range.from, Number(c.d[1]) - 1) : null;
      if (date && range.to && date > range.to) issues.push(`Column ${c.h} is outside the footer range`);
      const p = parseAttendanceCell(val(r[c.i]));
      if (p.unparsed) issues.push(`Unrecognised value "${val(r[c.i])}" on ${c.h}`);
      if (p.code) codes.add(p.code);
      days.push({ col: c.h, date, raw: val(r[c.i]), ...p, is_future: !!(date && generatedDay && date > generatedDay) });
    }
    const raw = { Employee: name, summary: Object.fromEntries(summaryCols.map((c) => [c.h, val(r[c.i])])), days };
    const m = match(db, actor, name);
    rows.push({ sheet: sheet.name, rowNo, sourceKey: `name:${name}:${range?.from}`, raw, userId: m.userId, matchStatus: m.matchStatus, issues, action: m.userId ? 'insert' : 'review' });
  });
  const futureDays = generatedDay && range ? Math.max(0, Math.round((Date.parse(range.to) - Date.parse(generatedDay)) / 864e5)) : null;
  return { reportingFrom: range?.from, reportingTo: range?.to,
    summary: { named_rows: rows.length, range, codes_seen: [...codes].sort(), future_days_after_generation: futureDays, blocking,
      warnings: ['Codes preserved verbatim; meanings (e.g. 4/SL, COO) to be validated against dated requests', 'Attendance cells never approve leave or create ledger entries', 'Hours are vendor-reported calendar figures'] }, rows };
}

export function parseAttendanceCell(v) {
  if (v === null || v === undefined || v === '') return { hours_x100: null, code: null };
  if (typeof v === 'number') return { hours_x100: toX100(v), code: null };
  const s = String(v).trim();
  const m = /^(\d+(?:\.\d+)?)?\s*\/?\s*([A-Z]{1,4})?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return { hours_x100: null, code: null, unparsed: true };
  // "4/SL" = 4 vendor hours alongside code SL; "8WFH" = 8 hours coded WFH; "SL" = code only
  return { hours_x100: m[1] ? toX100(m[1]) : null, code: m[2] || null, slash: s.includes('/') };
}

// ------------------------------------------------- Leaves (dated requests) --
// Expected columns (to verify against a real Reports → Leaves export):
// ID, Employee, Email, Leave type, Start date, End date, Start portion, End portion, Duration, Status
function parseLeaves(db, actor, sheet, opts) {
  const header = sheet.rows[0].map(str);
  if (header.includes('Range')) return parseLeavesGrouped(db, actor, sheet, opts);
  return parseLeavesFlat(db, actor, sheet, opts);
}

/**
 * The real export (checked against Leaves-2026-11-24): one row with the person's name, then one row per
 * request with the name blank. No ID column, so a stable key is built from person, type, range and the
 * "Registered on" time. Range is "MM/DD/YYYY" or "MM/DD/YYYY - MM/DD/YYYY"; Days can be 0.5.
 * The export does not say which half of a day was taken, so half days are recorded as a morning.
 */
function parseLeavesGrouped(db, actor, sheet, { dateFormat }) {
  const header = sheet.rows[0].map(str);
  const col = (name) => header.indexOf(name);
  const ix = { name: col('Employee'), type: col('Leave'), range: col('Range'), days: col('Days'), status: col('Status'), approver: col('Approver'), comment: col('Comment'), registered: col('Registered on') };
  const types = Object.fromEntries(db.prepare('SELECT * FROM leave_types WHERE tenant_id = ?').all(actor.tenantId).map((t) => [t.vendor_label || t.name, t]));
  const rows = []; let person = null;
  sheet.rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2;
    if (str(r[ix.name])) { person = str(r[ix.name]); return; }
    const type = str(r[ix.type]); if (!type) return;
    const issues = [];
    if (!person) issues.push('Request row before any employee name');
    const range = str(r[ix.range]);
    const [a, b] = range.split(/\s+-\s+/);
    const pd = (x) => { const v = (x || '').trim(); return isISODate(v) ? v : parseVendorDate(v, dateFormat); };
    const start = pd(a); const end = b ? pd(b) : start;
    if (!start || !end) issues.push(`Unparseable range "${range}"`);
    if (!types[type]) issues.push(`Leave type "${type}" not mapped`);
    const status = str(r[ix.status]).toLowerCase();
    const state = { approved: 'approved', pending: 'submitted', 'awaiting approval': 'submitted', declined: 'declined', rejected: 'declined', canceled: 'cancelled', cancelled: 'cancelled' }[status];
    if (!state) issues.push(`Unknown status "${status}"`);
    let durX100 = null; try { durX100 = toX100(val(r[ix.days])); } catch (e) { issues.push(e.message); }
    const half = durX100 !== null && durX100 % 100 === 50;
    const registered = ix.registered >= 0 ? str(r[ix.registered]) : '';
    const id = `lbk:${sha256(Buffer.from([person, type, range, registered].join('|'))).slice(0, 24)}`;
    const m = matchPerson(db, actor.tenantId, { name: person, source: 'leaveboard' });
    const raw = { id, name: person, type, start, end, range, start_portion: half && start === end ? 'am' : 'full', end_portion: half && start !== end ? 'am' : 'full',
      duration_x100: durX100, status, state, approver: ix.approver >= 0 ? str(r[ix.approver]) : null, registered, half_day_unknown: half || undefined };
    const existing = db.prepare("SELECT id, state FROM leave_requests WHERE tenant_id = ? AND source = 'leaveboard' AND source_ref = ?").get(actor.tenantId, id);
    rows.push({ sheet: sheet.name, rowNo, sourceKey: id, raw, userId: m.userId, matchStatus: m.matchStatus, issues,
      action: issues.length ? 'reject' : !m.userId ? 'review' : existing ? (existing.state === state ? 'unchanged' : 'update') : 'insert' });
  });
  const people = new Set(rows.map((r) => r.raw.name)).size;
  return { summary: { named_rows: rows.length, people, blocking: [], by_action: countBy(rows, 'action'), by_state: countBy(rows.map((r) => r.raw), 'state'), by_type: countBy(rows.map((r) => r.raw), 'type'),
    warnings: ['Approved requests are already counted in the LeaveBoard Annual Situation balances, so they are recorded as history and never deducted again',
      'The export has no request ID; re-importing the same file changes nothing, but an edited request in LeaveBoard would arrive as a new row',
      ...(rows.some((r) => r.raw.half_day_unknown) ? ['Half days: the export does not say morning or afternoon; recorded as a morning'] : [])] }, rows };
}

function parseLeavesFlat(db, actor, sheet, { dateFormat }) {
  const header = sheet.rows[0].map(str);
  const col = (re) => header.findIndex((h) => re.test(h));
  const ix = { id: col(/^id$/i), name: col(/^employee$/i), email: col(/e-?mail/i), type: col(/leave type/i), start: col(/^(start|from)/i), end: col(/^(end|to)\b/i),
    sp: col(/start portion|start part/i), ep: col(/end portion|end part/i), dur: col(/duration|days/i), status: col(/status/i) };
  const rows = []; const blocking = [];
  if (ix.id < 0) blocking.push('No ID column — cannot de-duplicate requests across re-imports');
  for (const k of ['name', 'type', 'start', 'end', 'status']) if (ix[k] < 0) blocking.push(`Missing column: ${k}`);
  const types = Object.fromEntries(db.prepare('SELECT * FROM leave_types WHERE tenant_id = ?').all(actor.tenantId).map((t) => [t.vendor_label || t.name, t]));
  sheet.rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2; const name = str(r[ix.name]);
    if (!name) return;
    const issues = [];
    const d = (c) => { const x = val(r[c]); if (x instanceof Date) return x.toISOString().slice(0, 10); if (isISODate(String(x))) return String(x); return parseVendorDate(String(x ?? ''), dateFormat); };
    const start = d(ix.start); const end = d(ix.end);
    if (!start || !end) issues.push('Unparseable date');
    const t = types[str(r[ix.type])];
    if (!t) issues.push(`Leave type "${str(r[ix.type])}" not mapped`);
    const status = str(r[ix.status]).toLowerCase();
    const state = { approved: 'approved', pending: 'submitted', 'awaiting approval': 'submitted', declined: 'declined', rejected: 'declined', canceled: 'cancelled', cancelled: 'cancelled' }[status];
    if (!state) issues.push(`Unknown status "${status}"`);
    let durX100 = null; try { durX100 = toX100(val(r[ix.dur])); } catch (e) { issues.push(e.message); }
    const m = matchPerson(db, actor.tenantId, { email: ix.email >= 0 ? str(r[ix.email]) : null, name, source: 'leaveboard' });
    const raw = { id: str(r[ix.id]), name, email: ix.email >= 0 ? str(r[ix.email]) : null, type: str(r[ix.type]), start, end,
      start_portion: ix.sp >= 0 ? str(r[ix.sp]).toLowerCase() || 'full' : 'full', end_portion: ix.ep >= 0 ? str(r[ix.ep]).toLowerCase() || 'full' : 'full', duration_x100: durX100, status, state };
    const existing = raw.id && db.prepare("SELECT id, state FROM leave_requests WHERE tenant_id = ? AND source = 'leaveboard' AND source_ref = ?").get(actor.tenantId, raw.id);
    rows.push({ sheet: sheet.name, rowNo, sourceKey: `lb:${raw.id}`, raw, userId: m.userId, matchStatus: m.matchStatus, issues,
      action: issues.length ? 'reject' : !m.userId ? 'review' : existing ? (existing.state === state ? 'unchanged' : 'update') : 'insert' });
  });
  return { summary: { named_rows: rows.length, blocking, by_action: countBy(rows, 'action'), by_state: countBy(rows.map((r) => r.raw), 'state'),
    warnings: ['Column layout assumed — confirm against a real Reports → Leaves export', 'Approved history up to cutover and approved future bookings are treated as already reflected in the opening balance (confirm)'] }, rows };
}
const countBy = (arr, k) => arr.reduce((a, x) => ((a[x[k]] = (a[x[k]] || 0) + 1), a), {});

// ------------------------------------------------------------------ apply --
export function applyLeaveboard(db, actor, batchId, opts = {}) {
  if (!isOps(actor)) throw forbid();
  return tx(db, () => {
    const b = getBatch(db, actor, batchId);
    requirePreviewed(b);
    const kind = b.kind.replace('leaveboard_', '');
    const result = { kind, snapshot_values: 0, attendance_days: 0, ledger_entries: 0, requests: 0, skipped_for_review: 0 };
    const ins = db.prepare('INSERT OR IGNORE INTO vendor_snapshot_values (tenant_id, batch_id, report, vendor_name, user_id, period, category, metric, raw_value, value_x100) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const r of b.rows) {
      if (r.action === 'skip' || r.action === 'reject') continue;
      if (kind === 'general_situation') {
        for (const [k, v] of Object.entries(r.raw)) if (k !== 'Employee') { ins.run(actor.tenantId, b.id, kind, r.raw.Employee, r.match_user_id, b.reporting_from && b.reporting_to ? `${b.reporting_from}..${b.reporting_to}` : null, k, 'value', v === null ? null : String(v), toX100(v)); result.snapshot_values++; }
      } else if (kind === 'annual_situation') {
        for (const [k, v] of Object.entries(r.raw)) {
          const m = / - (Used|Available|Allowance)$/.exec(k); if (!m) continue;
          ins.run(actor.tenantId, b.id, kind, r.raw.Employee, r.match_user_id, String(r.raw.Year), k.replace(m[0], ''), m[1], v === null ? null : String(v), toX100(v)); result.snapshot_values++;
        }
      } else if (kind === 'attendance') {
        const ia = db.prepare('INSERT OR IGNORE INTO attendance_days (tenant_id, batch_id, vendor_name, user_id, date, raw_value, hours_x100, code, code_hours_x100, is_future) VALUES (?,?,?,?,?,?,?,?,?,?)');
        for (const d of r.raw.days) { ia.run(actor.tenantId, b.id, r.raw.Employee, r.match_user_id, d.date, d.raw === null ? null : String(d.raw), d.code ? null : d.hours_x100, d.code, d.code ? d.hours_x100 : null, d.is_future ? 1 : 0); result.attendance_days++; }
      } else if (kind === 'leaves') {
        if (!r.match_user_id) { result.skipped_for_review++; continue; }
        result.requests += applyLeaveRow(db, actor, b, r, opts, result);
      }
    }
    markApplied(db, actor, b);
    return result;
  });
}

function applyLeaveRow(db, actor, b, r, { cutover }, result) {
  const x = r.raw;
  if (r.action === 'unchanged') return 0;
  const t = db.prepare('SELECT * FROM leave_types WHERE tenant_id = ? AND (vendor_label = ? OR name = ?)').get(actor.tenantId, x.type, x.type);
  const emp = currentEmployment(db, r.match_user_id, x.start) || currentEmployment(db, r.match_user_id);
  const pol = activePolicy(db, actor.tenantId, x.start).settings;
  const calc = chargeableDays({ start: x.start, end: x.end, startPortion: x.start_portion, endPortion: x.end_portion, workweek: pol.workweek, holidays: holidaysFor(db, actor.tenantId, emp?.country || 'JO', x.start, x.end) });
  if (x.duration_x100 !== null && x.duration_x100 !== calc.total_x100) calc.vendor_duration_mismatch = { vendor: fmtX100(x.duration_x100), prism: fmtX100(calc.total_x100) };
  // approved items are already inside the LeaveBoard opening snapshot → never deduct again
  const reflected = x.state === 'approved';
  const existing = db.prepare("SELECT * FROM leave_requests WHERE tenant_id = ? AND source = 'leaveboard' AND source_ref = ?").get(actor.tenantId, x.id);
  const id = existing?.id || uid('lr_');
  if (!existing) {
    db.prepare(`INSERT INTO leave_requests (id, tenant_id, user_id, type_id, start_date, end_date, start_portion, end_portion, chargeable_x100, breakdown_json, state, approver_id, warnings_json, exception_json, source, source_ref, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'leaveboard',?,?)`).run(id, actor.tenantId, r.match_user_id, t.id, x.start, x.end, x.start_portion, x.end_portion,
      x.duration_x100 ?? calc.total_x100, J(calc), x.state, emp?.manager_id ?? null, J([]), J({ imported_batch: b.id, reflected_in_opening: reflected, cutover: cutover ?? null }), x.id, now());
  } else {
    db.prepare('UPDATE leave_requests SET state = ?, row_version = row_version + 1 WHERE id = ?').run(x.state, id);
  }
  if (t.tracks_balance && t.category !== 'offsite') {
    for (const [y, amt] of Object.entries(calc.byYear)) {
      if (x.state === 'submitted') { if (postLedger(db, { tenantId: actor.tenantId, userId: r.match_user_id, typeId: t.id, year: Number(y), kind: 'reservation', amount: -amt, date: x.start, requestId: id, actorId: actor.id, key: `res:${id}:${y}`, batchId: b.id, note: 'Pending in LeaveBoard at cutover' })) result.ledger_entries++; }
      if (existing && existing.state === 'submitted' && x.state !== 'submitted') { if (postLedger(db, { tenantId: actor.tenantId, userId: r.match_user_id, typeId: t.id, year: Number(y), kind: 'reservation_release', amount: amt, date: x.start, requestId: id, actorId: actor.id, key: `rel:${id}:${y}`, batchId: b.id })) result.ledger_entries++; }
      if (existing && existing.state === 'submitted' && x.state === 'approved') { if (postLedger(db, { tenantId: actor.tenantId, userId: r.match_user_id, typeId: t.id, year: Number(y), kind: 'usage', amount: -amt, date: x.start, requestId: id, actorId: actor.id, key: `use:${id}:${y}`, batchId: b.id, note: 'Approved in LeaveBoard after cutover' })) result.ledger_entries++; }
    }
  }
  return 1;
}

/**
 * Post opening balances from an applied Annual Situation batch at the agreed
 * cutover. opening = vendor "Available" (already net of used and of approved
 * future bookings). Keyed per user/type/year so a second run is a no-op and a
 * different snapshot is reported as a difference instead of being added.
 */
export function postOpeningBalances(db, actor, { batchId, cutover }) {
  if (!isOps(actor)) throw forbid();
  if (!isISODate(cutover)) throw bad('Cutover date required (yyyy-mm-dd)');
  return tx(db, () => {
    const b = db.prepare("SELECT * FROM import_batches WHERE id = ? AND tenant_id = ? AND kind = 'leaveboard_annual_situation' AND status = 'applied'").get(batchId, actor.tenantId);
    if (!b) throw bad('Apply an Annual Situation batch first');
    const types = db.prepare('SELECT * FROM leave_types WHERE tenant_id = ?').all(actor.tenantId);
    const byLabel = Object.fromEntries(types.map((t) => [t.vendor_label || t.name, t]));
    const vals = db.prepare("SELECT * FROM vendor_snapshot_values WHERE batch_id = ? AND metric = 'Available' AND user_id IS NOT NULL").all(batchId);
    const out = { posted: 0, already: 0, differences: [], unmapped: new Set() };
    for (const v of vals) {
      const t = byLabel[v.category];
      if (!t) { out.unmapped.add(v.category); continue; }
      if (!t.tracks_balance) continue;
      const key = `open:${v.user_id}:${t.id}:${v.period}`;
      const ex = db.prepare('SELECT * FROM leave_ledger WHERE tenant_id = ? AND entry_key = ?').get(actor.tenantId, key);
      if (ex) { if (ex.amount_x100 !== v.value_x100) out.differences.push({ user_id: v.user_id, type: t.code, existing: fmtX100(ex.amount_x100), snapshot: fmtX100(v.value_x100), existing_batch: ex.batch_id }); else out.already++; continue; }
      postLedger(db, { tenantId: actor.tenantId, userId: v.user_id, typeId: t.id, year: Number(v.period), kind: 'opening', amount: v.value_x100, date: cutover, actorId: actor.id, key, batchId, note: `LeaveBoard Annual Situation available at cutover ${cutover}` });
      out.posted++;
    }
    out.unmapped = [...out.unmapped];
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'balance.opening', entity: 'import_batch', entityId: batchId, reason: `Cutover ${cutover}`, after: { posted: out.posted, already: out.already, differences: out.differences.length } });
    return out;
  });
}

/** Compare Prism ledger with a vendor Annual Situation snapshot, per person and category. */
export function reconcile(db, actor, { batchId }) {
  if (!isOps(actor)) throw forbid();
  const b = db.prepare('SELECT * FROM import_batches WHERE id = ? AND tenant_id = ?').get(batchId, actor.tenantId);
  if (!b) throw bad('Unknown batch');
  const types = db.prepare('SELECT * FROM leave_types WHERE tenant_id = ?').all(actor.tenantId);
  const byLabel = Object.fromEntries(types.map((t) => [t.vendor_label || t.name, t]));
  const vals = db.prepare("SELECT v.*, u.name FROM vendor_snapshot_values v LEFT JOIN users u ON u.id = v.user_id WHERE v.batch_id = ? AND v.metric = 'Available'").all(batchId);
  return vals.map((v) => {
    const t = byLabel[v.category];
    if (!v.user_id) return { vendor_name: v.vendor_name, category: v.category, status: 'unmatched_person' };
    if (!t || !t.tracks_balance) return { vendor_name: v.vendor_name, name: v.name, category: v.category, status: 'not_tracked_in_prism' };
    const bal = balance(db, actor.tenantId, v.user_id, t.id, Number(v.period));
    // pending reservations exist in Prism but LeaveBoard "Available" may not include them — show both
    const diff = bal.posted_x100 - v.value_x100;
    return { vendor_name: v.vendor_name, name: v.name, category: v.category, vendor_available: fmtX100(v.value_x100), prism_posted: fmtX100(bal.posted_x100), prism_pending: fmtX100(bal.pending_x100), difference: fmtX100(diff), status: diff === 0 ? 'match' : 'difference' };
  });
}

/** Cross-report comparison (e.g. General vs Annual Situation) — reports differences, never infers causes. */
export function compareSnapshots(db, actor, { batchA, batchB }) {
  if (!isOps(actor)) throw forbid();
  const get = (id, metric) => db.prepare('SELECT vendor_name, category, value_x100 FROM vendor_snapshot_values WHERE batch_id = ? AND metric = ?').all(id, metric);
  const a = get(batchA, 'value'); const bUsed = get(batchB, 'Used');
  const mapB = new Map(bUsed.map((r) => [`${r.vendor_name}|${r.category}`, r.value_x100]));
  const cats = [...new Set(bUsed.map((r) => r.category))];
  const rows = []; const totals = {};
  for (const r of a) {
    if (!cats.includes(r.category)) continue;
    const other = mapB.get(`${r.vendor_name}|${r.category}`);
    totals[r.category] = totals[r.category] || { general: 0, annual_used: 0 };
    totals[r.category].general += r.value_x100 ?? 0; totals[r.category].annual_used += other ?? 0;
    if (other !== r.value_x100) rows.push({ vendor_name: r.vendor_name, category: r.category, general: fmtX100(r.value_x100), annual_used: fmtX100(other) });
  }
  return { differences: rows, totals: Object.fromEntries(Object.entries(totals).map(([c, t]) => [c, { general: fmtX100(t.general), annual_used: fmtX100(t.annual_used), match: t.general === t.annual_used }])),
    note: 'Differences are reported only; reconcile from dated leave requests before activation. Report dates/filters may differ.' };
}
