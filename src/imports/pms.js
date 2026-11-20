// PMS imports.
//  (a) plans      – one row per plan item (normalised template, see docs/IMPORT_FORMATS.md)
//  (b) history    – team summary like "GB Team 2025 PMS" (PMS tab): dimension
//                   columns with weights in the header, total and rationale.
// Field allowlist: payroll / personal columns are detected and never read
// beyond their header. Sheets named like "Salaries" are refused outright.
import { tx, uid, now, J, P, audit, bad, forbid, conflict } from '../db.js';
import { isOps } from '../domain/authz.js';
import { validateWeights, round } from '../domain/scoring.js';
import { insertItem } from '../domain/performance.js';
import { readWorkbook, sha256, str, val, EXCLUDED_HEADER } from './xlsx.js';
import { saveBatch, findExisting, matchPerson, markApplied, requirePreviewed, getBatch } from './batch.js';

const FORBIDDEN_SHEET = /salar|payroll|bonus|compensation/i;
const CAT = { objective: 'objective', objectives: 'objective', competency: 'competency', competencies: 'competency', initiative: 'initiative', initiatives: 'initiative', 'internal initiatives': 'initiative' };
const LOCKED = new Set(['partner_calibration', 'released', 'acknowledged', 'closed']);

function pickSheet(sheets, sheetName) {
  if (sheetName && FORBIDDEN_SHEET.test(sheetName)) throw bad(`Sheet "${sheetName}" looks like payroll data and cannot be imported`);
  const s = sheetName ? sheets.find((x) => x.name === sheetName) : sheets.find((x) => !FORBIDDEN_SHEET.test(x.name));
  if (!s) throw bad('Sheet not found');
  return s;
}

function headerMap(sheet) {
  const header = (sheet.rows[0] || []).map(str);
  const excluded = header.filter((h) => h && EXCLUDED_HEADER.test(h));
  return { header, excluded, allowed: header.map((h) => (h && !EXCLUDED_HEADER.test(h) ? h : null)) };
}

// ------------------------------------------------------------------ plans --
export async function previewPlans(db, actor, { filename, buffer, sheetName, cycleId }) {
  if (!isOps(actor)) throw forbid();
  const sha = sha256(buffer);
  const ex = findExisting(db, actor.tenantId, 'pms_plans', sha);
  if (ex) return { ...getBatch(db, actor, ex.id), duplicateOf: ex.id };
  const cycle = db.prepare('SELECT * FROM cycles WHERE id = ? AND tenant_id = ?').get(cycleId, actor.tenantId);
  if (!cycle) throw bad('Choose the target cycle');
  const sheet = pickSheet(await readWorkbook(buffer), sheetName);
  const { header, excluded, allowed } = headerMap(sheet);
  const col = (re) => allowed.findIndex((h) => h && re.test(h));
  const ix = { email: col(/e-?mail/i), empId: col(/employee id/i), cycle: col(/^cycle|year/i), category: col(/^category$/i), catWeight: col(/category weight/i),
    item: col(/^(item|objective|competency|title)/i), kpi: col(/kpi|measure/i), target: col(/target/i), weight: col(/^(item )?weight/i),
    proficiency: col(/expected proficiency/i), status: col(/plan status/i), evidence: col(/evidence/i), approvedBy: col(/approved by/i) };
  const blocking = [];
  if (ix.email < 0 && ix.empId < 0) blocking.push('Need a verified work email or employee ID column');
  for (const k of ['category', 'item', 'weight']) if (ix[k] < 0) blocking.push(`Missing column: ${k}`);
  const rows = []; const byPerson = new Map(); const seenKeys = new Set();
  sheet.rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2; const issues = [];
    const cells = allowed.map((h, j) => (h ? r[j] : undefined));
    if (cells.every((c) => !c || c.v === null || c.v === '')) return;
    for (const [j, c] of cells.entries()) if (c?.error) issues.push(`${header[j]}: formula error ${c.error}`);
    for (const [j, c] of cells.entries()) if (c?.cachedMissing) issues.push(`${header[j]}: formula without cached value`);
    const email = ix.email >= 0 ? str(r[ix.email]) : '';
    const cat = CAT[str(r[ix.category]).toLowerCase()];
    if (!cat) issues.push(`Unknown category "${str(r[ix.category])}"`);
    const title = str(r[ix.item]);
    if (!title) issues.push('Item title blank');
    const wRaw = val(r[ix.weight]);
    const weight = wRaw === null || wRaw === '' ? null : normPct(wRaw);
    if (weight === null) issues.push('Weight blank');
    const cyc = ix.cycle >= 0 ? str(r[ix.cycle]) : String(cycle.year);
    if (cyc && cyc !== String(cycle.year)) issues.push(`Row cycle ${cyc} ≠ target cycle ${cycle.year}`);
    const m = matchPerson(db, actor.tenantId, { email, source: 'pms' });
    if (!m.userId) issues.push(`Employee not matched (${email || 'no email'})`);
    const key = `${email.toLowerCase()}|${cycle.year}|${cat}|${title.toLowerCase()}`;
    if (seenKeys.has(key)) issues.push('Duplicate item for this employee'); seenKeys.add(key);
    const raw = { email, category: cat, title, kpi: ix.kpi >= 0 ? str(r[ix.kpi]) : null, target: ix.target >= 0 ? str(r[ix.target]) : null, weight,
      category_weight: ix.catWeight >= 0 && val(r[ix.catWeight]) !== null ? normPct(val(r[ix.catWeight])) : null,
      expected_proficiency: ix.proficiency >= 0 ? Number(val(r[ix.proficiency])) || null : null,
      plan_status: ix.status >= 0 ? str(r[ix.status]).toLowerCase() : '', approved_by: ix.approvedBy >= 0 ? str(r[ix.approvedBy]) : '', evidence: ix.evidence >= 0 ? str(r[ix.evidence]) : null };
    const row = { sheet: sheet.name, rowNo, sourceKey: key, raw, userId: m.userId, matchStatus: m.matchStatus, issues, action: issues.length ? 'reject' : 'insert' };
    rows.push(row);
    if (m.userId) { if (!byPerson.has(m.userId)) byPerson.set(m.userId, []); byPerson.get(m.userId).push(row); }
  });
  // per-person validation (weights) and lock check
  const plans = [];
  for (const [userId, rs] of byPerson) {
    const items = rs.filter((r) => r.action !== 'reject').map((r) => ({ category: r.raw.category, weight: r.raw.weight, title: r.raw.title }));
    const cw = {};
    for (const r of rs) if (r.raw.category_weight !== null) {
      if (cw[r.raw.category] !== undefined && cw[r.raw.category] !== r.raw.category_weight) r.issues.push('Inconsistent category weight for this employee');
      cw[r.raw.category] = r.raw.category_weight;
    }
    const errs = validateWeights(cw, items).map((e) => e.message);
    const existing = db.prepare('SELECT * FROM plans WHERE cycle_id = ? AND user_id = ?').get(cycleId, userId);
    if (existing && LOCKED.has(existing.state)) errs.push(`Existing plan is ${existing.state} — import blocked`);
    if (existing && !LOCKED.has(existing.state) && !String(existing.source_ref || '').includes(':')) errs.push('Existing plan was created in Prism — import would overwrite it');
    const approved = rs.every((r) => r.raw.plan_status === 'approved' && r.raw.approved_by);
    for (const r of rs) {
      if (errs.length) { r.issues.push(...errs); r.action = 'reject'; }
      else if (existing && r.action === 'insert') r.action = 'update';
    }
    plans.push({ userId, items: items.length, category_weights: cw, errors: errs, approved_in_source: approved, existing_state: existing?.state ?? null });
  }
  const summary = { cycle: { id: cycle.id, year: cycle.year }, excluded_columns: excluded, plans, blocking,
    rows_by_action: rows.reduce((a, r) => ((a[r.action] = (a[r.action] || 0) + 1), a), {}),
    warnings: ['Plans import as "Plan in draft" unless every row says Approved with an approver — approval is still re-confirmed by the line manager in Prism'] };
  return saveBatch(db, actor, { kind: 'pms_plans', filename, sha, summary, rows });
}

export function applyPlans(db, actor, batchId, { reviewers = {} } = {}) {
  if (!isOps(actor)) throw forbid();
  return tx(db, () => {
    const b = getBatch(db, actor, batchId);
    requirePreviewed(b);
    const cycleId = b.summary.cycle.id;
    const out = { plans_created: 0, plans_updated: 0, items: 0, rejected_rows: b.rows.filter((r) => r.action === 'reject').length };
    const groups = new Map();
    for (const r of b.rows) if (r.action === 'insert' || r.action === 'update') { if (!groups.has(r.match_user_id)) groups.set(r.match_user_id, []); groups.get(r.match_user_id).push(r); }
    for (const [userId, rs] of groups) {
      const meta = b.summary.plans.find((p) => p.userId === userId);
      let plan = db.prepare('SELECT * FROM plans WHERE cycle_id = ? AND user_id = ?').get(cycleId, userId);
      if (plan && LOCKED.has(plan.state)) throw conflict('A plan became locked after preview — re-run the preview');
      const emp = db.prepare('SELECT * FROM employments WHERE user_id = ? AND effective_to IS NULL').get(userId);
      if (!plan) {
        const id = uid('plan_');
        db.prepare(`INSERT INTO plans (id, tenant_id, cycle_id, user_id, reviewer_id, partner_id, role_title, category_weights_json, basis_status, source_ref, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, actor.tenantId, cycleId, userId, reviewers[userId]?.reviewerId ?? emp?.manager_id ?? null, reviewers[userId]?.partnerId ?? null,
          emp?.title ?? null, J(meta.category_weights), 'unverified', `${b.id}:${userId}`, now());
        plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id); out.plans_created++;
      } else {
        db.prepare('DELETE FROM plan_items WHERE plan_id = ? AND source_ref LIKE ?').run(plan.id, 'imp_%');
        db.prepare('UPDATE plans SET category_weights_json = ?, source_ref = ?, row_version = row_version + 1 WHERE id = ?').run(J(meta.category_weights), `${b.id}:${userId}`, plan.id);
        out.plans_updated++;
      }
      rs.forEach((r, i) => { insertItem(db, actor.tenantId, plan.id, { ...r.raw, anchors: null, position: i, source_ref: `${b.id}:${r.row_no}` }); out.items++; });
      if (meta.approved_in_source) db.prepare("UPDATE plans SET basis_note = ? WHERE id = ?").run(`Source marks plan approved by ${rs[0].raw.approved_by}; manager to confirm in Prism`, plan.id);
    }
    markApplied(db, actor, b);
    return out;
  });
}

// ---------------------------------------------------------------- history --
/** Team summary (e.g. 2025 PMS tab). Header cells like "Delivery Quality (25%)". */
export async function previewHistory(db, actor, { filename, buffer, sheetName = 'PMS', year, precision = 1 }) {
  if (!isOps(actor)) throw forbid();
  const sha = sha256(buffer);
  const ex = findExisting(db, actor.tenantId, 'pms_history', sha);
  if (ex) return { ...getBatch(db, actor, ex.id), duplicateOf: ex.id };
  const sheet = pickSheet(await readWorkbook(buffer), sheetName);
  return previewHistoryRows(db, actor, { filename, sha, sheetName: sheet.name, rows: sheet.rows.map((r) => r.map((c) => c)), year, precision });
}

export function previewHistoryRows(db, actor, { filename, sha, sheetName, rows: sheetRows, year, precision = 1 }) {
  const header = sheetRows[0].map(str);
  const excluded = header.filter((h) => h && EXCLUDED_HEADER.test(h));
  const dims = header.map((h, i) => ({ h, i, m: /^(.*)\((\d+(?:\.\d+)?)%\)\s*$/.exec(h) })).filter((d) => d.m).map((d) => ({ name: d.m[1].trim(), weight: Number(d.m[2]), i: d.i }));
  const iName = header.findIndex((h) => /^employee/i.test(h)); const iTitle = header.findIndex((h) => /title/i.test(h));
  const iTotal = header.findIndex((h) => /total/i.test(h)); const iWhy = header.findIndex((h) => /rationale|comment/i.test(h));
  const blocking = [];
  const wsum = dims.reduce((a, d) => a + d.weight, 0);
  if (Math.abs(wsum - 100) > 1e-9) blocking.push(`Dimension weights total ${wsum}%`);
  if (iName < 0) blocking.push('No Employee column');
  const rows = []; const names = new Map(); const rationales = new Map();
  sheetRows.slice(1).forEach((r, k) => {
    const name = str(r[iName]); if (!name) return;
    const issues = [];
    const ratings = {};
    for (const d of dims) {
      const c = r[d.i]; if (c?.error) issues.push(`${d.name}: formula error ${c.error}`);
      const v = Number(str(c)); if (str(c) === '' || Number.isNaN(v)) issues.push(`${d.name}: missing rating`); else ratings[d.name] = v;
    }
    const total = Number(str(r[iTotal]));
    const recomputed = dims.every((d) => ratings[d.name] !== undefined) ? dims.reduce((a, d) => a + ratings[d.name] * d.weight / 100, 0) : null;
    if (recomputed !== null && round(recomputed, precision) !== total) issues.push(`Total ${total} ≠ recomputed ${round(recomputed, precision)} (${round(recomputed, 4)})`);
    const why = iWhy >= 0 ? str(r[iWhy]) : '';
    if (why && rationales.has(why)) issues.push(`Rationale identical to ${rationales.get(why)} — check for copy/paste`);
    if (why) rationales.set(why, name);
    if (names.has(name.toLowerCase())) issues.push('Duplicate person'); names.set(name.toLowerCase(), true);
    const m = matchPerson(db, actor.tenantId, { name, source: 'pms' });
    const hard = issues.some((x) => /missing|formula|Duplicate|≠/.test(x));
    rows.push({ sheet: sheetName, rowNo: k + 2, sourceKey: `${year}|${name.toLowerCase()}`, raw: { name, title: iTitle >= 0 ? str(r[iTitle]) : null, ratings, total, recomputed, rationale: why },
      userId: m.userId, matchStatus: m.matchStatus, issues, action: hard ? 'reject' : m.userId ? 'insert' : 'review' });
  });
  const summary = { year, dimensions: dims.map(({ name, weight }) => ({ name, weight })), precision, excluded_columns: excluded, blocking,
    warnings: ['Historical ratings are kept as verified source values; they are not re-scored with the 2026 rules'] };
  return saveBatch(db, actor, { kind: 'pms_history', filename, sha, summary, rows });
}

export function applyHistory(db, actor, batchId) {
  if (!isOps(actor)) throw forbid();
  return tx(db, () => {
    const b = getBatch(db, actor, batchId);
    requirePreviewed(b);
    const { year, dimensions } = b.summary;
    let cycle = db.prepare("SELECT * FROM cycles WHERE tenant_id = ? AND year = ? AND kind = 'annual'").get(actor.tenantId, year);
    if (!cycle) {
      const id = uid('cyc_');
      db.prepare("INSERT INTO cycles (id, tenant_id, year, name, status, scoring_json) VALUES (?,?,?,?, 'historical', ?)").run(id, actor.tenantId, year, `${year} (history)`,
        J({ status: 'historical', scale: { min: 1, max: 5, step: 0.1 }, precision: b.summary.precision }));
      cycle = db.prepare('SELECT * FROM cycles WHERE id = ?').get(id);
    }
    const out = { plans: 0, skipped_existing: 0, review: b.rows.filter((r) => r.action === 'review').length };
    for (const r of b.rows) {
      if (r.action !== 'insert') continue;
      const ex = db.prepare('SELECT * FROM plans WHERE cycle_id = ? AND user_id = ?').get(cycle.id, r.match_user_id);
      if (ex) { out.skipped_existing++; continue; } // never overwrite a closed historical review
      const id = uid('plan_');
      db.prepare(`INSERT INTO plans (id, tenant_id, cycle_id, user_id, role_title, state, category_weights_json, basis_status, basis_note, source_ref, summary_json, final_score, closed_at, created_at)
          VALUES (?,?,?,?,?, 'closed', ?, 'verified', ?, ?, ?, ?, ?, ?)`).run(id, actor.tenantId, cycle.id, r.match_user_id, r.raw.title,
        J({ competency: 100 }), `Imported from ${b.filename} (${r.sheet} row ${r.row_no})`, `${b.id}:${r.row_no}`,
        J({ history: { rationale: r.raw.rationale, source_total: r.raw.total, recomputed: r.raw.recomputed } }), r.raw.total, now(), now());
      dimensions.forEach((d, i) => insertItem(db, actor.tenantId, id, { category: 'competency', title: d.name, weight: d.weight, position: i, source_rating_raw: String(r.raw.ratings[d.name]), source_ref: `${b.id}:${r.row_no}`, evidence_required: false }));
      db.prepare("INSERT INTO plan_transitions (plan_id, from_state, to_state, actor_id, reason, at) VALUES (?, NULL, 'closed', ?, 'Historical import', ?)").run(id, actor.id, now());
      out.plans++;
    }
    markApplied(db, actor, b);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'import.history', entity: 'import_batch', entityId: b.id, after: out });
    return out;
  });
}

function normPct(v) {
  if (typeof v === 'number') return v <= 1 ? round(v * 100, 6) : v; // 0.25 or 25
  const s = String(v).trim().replace('%', '');
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return String(v).includes('%') || n > 1 ? n : round(n * 100, 6);
}
