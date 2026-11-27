// Historical performance outcomes (2025), admin + compensation access only, dry run first.
//
//  (1) "2025_PMS_Outcome_Confidential.csv" — one row per communicated outcome email. This is the
//      authoritative record of what was communicated. Key: tenant + review year + Gmail message id.
//  (2) Worksheets — the "Salaries" tab of the GB Team PMS workbook and the "Bonuses" sheet. Proposals with
//      their context; kept as separate source records, never overwrite the communicated decision.
//      Only allow-listed columns are read; Age is never read.
//
// People are matched by exact normalised work email (CSV) or exact normalised full name (worksheets, which
// have no email). Anything else needs a manual mapping or is skipped — never a fuzzy link. Nothing here
// changes current employee profiles, titles, payroll or sends any email.
import { uid, now, audit, bad, forbid, notFound, conflict, tx } from '../db.js';
import { has } from '../domain/authz.js';
import { seal, open } from '../domain/hrrecords.js';
import { compAccess, approvedPolicy } from '../domain/perf/outcomes.js';
import { readWorkbook, sha256, str, val } from './xlsx.js';

const need = (db, a) => { if (!has(a, 'admin') || !compAccess(db, a)) throw forbid('Historical outcomes need the admin role and compensation access'); };
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[‐-―-]/g, '-').replace(/\s+/g, ' ').trim();
const num = (s) => { if (s == null || s === '') return null; const n = Number(String(s).replace(/[,\s]|JOD/gi, '')); return Number.isFinite(n) ? n : null; };

/** RFC 4180 CSV with a UTF-8 BOM, quoted fields and line breaks inside quotes. */
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; } else f += c;
  }
  if (q) throw bad('The CSV has an unclosed quote');
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const [header, ...data] = rows.filter((r) => r.some((x) => x.trim() !== ''));
  if (!header) throw bad('The file is empty');
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

function activePeople(db, tenantId) {
  const users = db.prepare('SELECT id, name, email FROM users WHERE tenant_id = ? AND active = 1').all(tenantId);
  const aliases = db.prepare('SELECT user_id, alias FROM identity_aliases WHERE tenant_id = ? AND verified = 1').all(tenantId);
  return { byEmail: (e) => users.find((u) => norm(u.email) === norm(e)) || null,
    byName: (n) => { const hit = users.filter((u) => norm(u.name) === norm(n)); const al = aliases.filter((a) => norm(a.alias) === norm(n)).map((a) => users.find((u) => u.id === a.user_id)).filter(Boolean);
      const all = [...new Map([...hit, ...al].map((u) => [u.id, u])).values()]; return all.length === 1 ? all[0] : all.length > 1 ? 'ambiguous' : null; },
    list: users.map((u) => ({ id: u.id, name: u.name })) };
}

function storeBatch(db, actor, kind, filename, sha, preview) {
  const ex = db.prepare('SELECT * FROM perf_import_batches WHERE tenant_id = ? AND kind = ? AND sha = ?').get(actor.tenantId, kind, sha);
  if (ex && ex.status === 'discarded') db.prepare('DELETE FROM perf_import_batches WHERE id = ?').run(ex.id);
  else if (ex) return { id: ex.id, status: ex.status, duplicate: true, ...open(ex.preview_enc) };
  const id = uid('pib_');
  db.prepare("INSERT INTO perf_import_batches (id, tenant_id, kind, filename, sha, status, preview_enc, created_by, created_at) VALUES (?,?,?,?,?, 'previewed', ?,?,?)").run(id, actor.tenantId, kind, String(filename || '').slice(0, 120), sha, seal(preview), actor.id, now());
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: `perf_import.preview_${kind}`, entity: 'batch', entityId: id, after: { rows: preview.rows.length } });
  return { id, status: 'previewed', duplicate: false, ...preview };
}

// ----------------------------------------------------- (1) outcome emails --
const quotedPct = (body) => { const m = /([+-]?\d+(?:\.\d+)?)\s*%/.exec(body || ''); return m ? Number(m[1]) : null; };
export function previewOutcomeCsv(db, actor, { filename, text }) {
  need(db, actor);
  const rows = parseCsv(text);
  const required = ['employee', 'work_email', 'review_year', 'source_message_id', 'previous_monthly_salary_jod', 'new_monthly_salary_jod'];
  if (rows.length && required.some((k) => !(k in rows[0]))) throw bad(`Missing columns: ${required.filter((k) => !(k in rows[0])).join(', ')}`);
  const ppl = activePeople(db, actor.tenantId); const guidance = approvedPolicy(db, actor.tenantId)?.compensation?.bonus_guidance_months ?? null;
  const seen = new Set();
  const out = rows.map((r, i) => {
    const year = Number(r.review_year); const ref = String(r.source_message_id || '').trim();
    const u = ppl.byEmail(r.work_email);
    const prior = num(r.previous_monthly_salary_jod); const next = num(r.new_monthly_salary_jod); const bonus = num(r.bonus_months_of_base_salary);
    const computed = prior ? Math.round(((next - prior) / prior) * 1000) / 10 : null; const quoted = quotedPct(r.communicated_email_body);
    const flags = [];
    const label = String(r.communicated_outcome || '');
    if (/promotion/i.test(label) && !String(r.new_title || '').trim()) flags.push('Outcome says promotion but no new title is stated');
    if (String(r.new_title || '').trim() && !/promotion/i.test(label)) flags.push('A new title is stated but the outcome label has no promotion');
    if (/increase/i.test(label) && (next == null || prior == null || next <= prior)) flags.push('Outcome says salary increase but the amounts do not show one');
    if (quoted != null && computed != null && Math.abs(quoted - computed) > 0.05) flags.push(`Email quotes ${quoted}% but the amounts give ${computed}%`);
    if (guidance != null && bonus != null && bonus > guidance) flags.push(`Bonus of ${bonus} months is above the guidance of ${guidance}`);
    if (!/^\d{4}-\d{2}$/.test(r.effective_month || '')) flags.push('Effective month missing or not yyyy-mm');
    let status = u ? 'ready' : 'needs mapping';
    if (!ref || !year) status = 'invalid';
    if (seen.has(`${year}:${ref}`)) status = 'duplicate in file'; seen.add(`${year}:${ref}`);
    if (db.prepare("SELECT 1 FROM comp_records WHERE tenant_id = ? AND year = ? AND source = 'email' AND source_ref = ?").get(actor.tenantId, year, ref)) status = 'already imported';
    return { key: `r${i}`, name_in_source: r.employee, email_in_source: r.work_email, matched: u ? { id: u.id, name: u.name } : null, status, year, ref, flags,
      data: { name_in_source: r.employee, prior_x1000: prior == null ? null : Math.round(prior * 1000), proposed_x1000: null, approved_x1000: next == null ? null : Math.round(next * 1000), currency: 'JOD',
        bonus_type: bonus != null ? 'months' : 'none', bonus_months: bonus, bonus_basis: 'new', effective: r.effective_month || null, outcome_label: label || null, title: String(r.new_title || '').trim() || null,
        quoted_pct: quoted, sent_at: r.sent_at_amman || null, source_url: r.source_url || null, body: r.communicated_email_body || null } };
  });
  const sha = sha256(Buffer.from(String(text)));
  const preview = { kind: 'outcomes', filename, rows: out.map(({ data, ...x }) => ({ ...x, prior: data.prior_x1000 / 1000, new: data.approved_x1000 / 1000, bonus_months: data.bonus_months, title: data.title, outcome: data.outcome_label, effective: data.effective })), people: ppl.list, _data: out.map((x) => ({ key: x.key, data: x.data })) };
  const b = storeBatch(db, actor, 'outcomes', filename, sha, preview);
  return { ...b, _data: undefined };
}

// --------------------------------------------------------- (2) worksheets --
const COLS = { name: /^employee name$/i, current_title: /^current title$/i, new_title: /^new title$/i, salary_2025: /^2025 salary/i, rating: /^overall performance rating$/i, suggested_increase: /^suggested 2025 increase$/i, salary_2026: /^2026 salary$/i, suggested_bonus: /^suggested 2026 bonus$/i, outcome: /^eoy outcome$/i };
export async function previewWorksheet(db, actor, { filename, buffer, year = 2025 }) {
  need(db, actor);
  const sheets = await readWorkbook(buffer);
  // find the sheet and header row containing "Employee Name" (the Salaries tab or the Bonuses sheet)
  let sheet = null; let h = -1;
  for (const s of sheets) { for (let i = 0; i < Math.min(30, s.rows.length); i++) if ((s.rows[i] || []).some((c) => /^employee name$/i.test(str(c)))) { sheet = s; h = i; break; } if (sheet) break; }
  if (!sheet) throw bad('No sheet with an "Employee Name" column was found');
  const header = sheet.rows[h].map(str);
  const idx = Object.fromEntries(Object.entries(COLS).map(([k, re]) => [k, header.findIndex((x) => re.test(x))]));
  if (idx.name < 0) throw bad('No "Employee Name" column');
  const ignored = header.filter((x, i) => x && !Object.values(idx).includes(i)); // includes Age — never read
  const ppl = activePeople(db, actor.tenantId); const guidance = approvedPolicy(db, actor.tenantId)?.compensation?.bonus_guidance_months ?? null;
  const sha = sha256(buffer);
  const out = [];
  for (let i = h + 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i] || []; const cell = (k) => (idx[k] >= 0 ? row[idx[k]] : null);
    const nm = str(cell('name')); if (!nm) continue;
    const u = ppl.byName(nm);
    const s25 = num(val(cell('salary_2025'))); const s26 = num(val(cell('salary_2026')));
    const bonusRaw = str(cell('suggested_bonus')); const bonusN = num(bonusRaw);
    const flags = [];
    // reconcile with the communicated email for the same person and year
    const email = u && u !== 'ambiguous' ? db.prepare("SELECT data_enc FROM comp_records WHERE tenant_id = ? AND user_id = ? AND year = ? AND source = 'email'").get(actor.tenantId, u.id, year) : null;
    if (!email) flags.push('No communicated email on file — communication unverified');
    else {
      const e = open(email.data_enc);
      if (s26 != null && e.approved_x1000 != null && Math.round(s26 * 1000) !== e.approved_x1000) flags.push(`Worksheet 2026 salary ${s26} differs from the communicated ${e.approved_x1000 / 1000}`);
      if (s25 != null && e.prior_x1000 != null && Math.round(s25 * 1000) !== e.prior_x1000) flags.push(`Worksheet current salary ${s25} differs from the communicated previous ${e.prior_x1000 / 1000}`);
      const nt = str(cell('new_title'));
      if (nt && e.title && norm(nt) !== norm(e.title)) flags.push(`Worksheet new title “${nt}” differs from the communicated “${e.title}”`);
      if (bonusN != null && e.bonus_months != null && bonusN <= 12 && bonusN !== e.bonus_months) flags.push(`Worksheet bonus ${bonusN} differs from the communicated ${e.bonus_months} months`);
    }
    const sugg = str(cell('suggested_increase'));
    const sn = num(sugg.replace('%', ''));
    if (s25 && s26 && sn != null) {
      const pct = Math.round(((s26 - s25) / s25) * 1000) / 10; const amt = s26 - s25;
      const asPct = /%/.test(sugg) || (sn > 0 && sn < 1) ? (sn < 1 ? sn * 100 : sn) : null;
      if (asPct != null && Math.abs(asPct - pct) > 0.05) flags.push(`Suggested increase ${sugg} does not reconcile to ${s25} → ${s26} (${pct}%)`);
      if (asPct == null && Math.abs(sn - amt) > 0.5) flags.push(`Suggested increase ${sugg} does not reconcile to the amount ${amt}`);
    }
    if (guidance != null && bonusN != null && bonusN <= 12 && bonusN > guidance) flags.push(`Bonus ${bonusN} months is above the guidance of ${guidance}`);
    const ref = `ws:${sha.slice(0, 12)}:${norm(nm)}`;
    const status = u === 'ambiguous' ? 'needs mapping' : u ? (db.prepare("SELECT 1 FROM comp_records WHERE tenant_id = ? AND year = ? AND source = 'worksheet' AND source_ref = ?").get(actor.tenantId, year, ref) ? 'already imported' : 'ready') : 'needs mapping';
    out.push({ key: `w${i}`, name_in_source: nm, matched: u && u !== 'ambiguous' ? { id: u.id, name: u.name } : null, status, year, ref, flags,
      data: { name_in_source: nm, prior_x1000: s25 == null ? null : Math.round(s25 * 1000), proposed_x1000: s26 == null ? null : Math.round(s26 * 1000), approved_x1000: null, currency: 'JOD',
        bonus_type: bonusN != null ? (bonusN <= 12 ? 'months' : 'fixed') : 'none', bonus_months: bonusN != null && bonusN <= 12 ? bonusN : null, bonus_amount_x1000: bonusN != null && bonusN > 12 ? Math.round(bonusN * 1000) : null,
        bonus_basis: 'new', title: str(cell('new_title')) || null, current_title: str(cell('current_title')) || null, outcome_label: str(cell('outcome')) || null, rating_in_source: num(val(cell('rating'))), suggested_increase_in_source: sugg || null, note: `Worksheet proposal (${sheet.name})` } });
  }
  const preview = { kind: 'worksheet', filename, sheet: sheet.name, ignored_columns: ignored, rows: out.map(({ data, ...x }) => ({ ...x, current: data.prior_x1000 != null ? data.prior_x1000 / 1000 : null, proposed: data.proposed_x1000 != null ? data.proposed_x1000 / 1000 : null, bonus: data.bonus_months ?? (data.bonus_amount_x1000 != null ? data.bonus_amount_x1000 / 1000 : null), title: data.title, rating: data.rating_in_source, outcome: data.outcome_label })),
    people: ppl.list, _data: out.map((x) => ({ key: x.key, data: x.data })) };
  const b = storeBatch(db, actor, 'worksheet', filename, sha, preview);
  return { ...b, _data: undefined };
}

/** Apply a previewed batch in one transaction. mappings: { rowKey: userId | 'skip' } for unmatched rows. */
export function applyBatch(db, actor, batchId, { mappings = {} } = {}) {
  need(db, actor);
  const b = db.prepare('SELECT * FROM perf_import_batches WHERE id = ? AND tenant_id = ?').get(batchId, actor.tenantId); if (!b) throw notFound();
  if (b.status !== 'previewed') throw conflict('This file was already applied or discarded');
  const p = open(b.preview_enc); const data = Object.fromEntries(p._data.map((x) => [x.key, x.data]));
  const report = { imported: 0, skipped: [], already: 0 };
  const source = b.kind === 'outcomes' ? 'email' : 'worksheet';
  tx(db, () => {
    for (const r of p.rows) {
      if (['already imported', 'duplicate in file', 'invalid'].includes(r.status)) { if (r.status === 'already imported') report.already++; else report.skipped.push(`${r.name_in_source}: ${r.status}`); continue; }
      let userId = r.matched?.id || null;
      const m = mappings[r.key];
      if (!userId) {
        if (!m || m === 'skip') { report.skipped.push(`${r.name_in_source}: not mapped — skipped`); continue; }
        if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ?').get(m, actor.tenantId)) throw bad(`Mapping for ${r.name_in_source} is not a person in this workspace`);
        userId = m;
      }
      if (db.prepare('SELECT 1 FROM comp_records WHERE tenant_id = ? AND year = ? AND source = ? AND source_ref = ?').get(actor.tenantId, r.year, source, r.ref)) { report.already++; continue; }
      db.prepare("INSERT INTO comp_records (id, tenant_id, user_id, year, source, source_ref, status, data_enc, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?, 'historical', ?,?,?,?)")
        .run(uid('cmp_'), actor.tenantId, userId, r.year, source, r.ref, seal({ ...data[r.key], imported_from: b.filename, flags: r.flags }), actor.id, now(), now());
      report.imported++;
    }
    db.prepare("UPDATE perf_import_batches SET status = 'applied', applied_at = ? WHERE id = ?").run(now(), batchId);
  });
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: `perf_import.apply_${b.kind}`, entity: 'batch', entityId: batchId, after: { imported: report.imported, skipped: report.skipped.length } });
  return report;
}
export function listBatches(db, actor) {
  need(db, actor);
  return db.prepare('SELECT id, kind, filename, status, created_at, applied_at FROM perf_import_batches WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20').all(actor.tenantId);
}
export function discardBatch(db, actor, batchId) {
  need(db, actor);
  const r = db.prepare("UPDATE perf_import_batches SET status = 'discarded', preview_enc = ? WHERE id = ? AND tenant_id = ? AND status = 'previewed'").run(seal({ rows: [], _data: [] }), batchId, actor.tenantId);
  if (!r.changes) throw notFound();
  return { ok: true };
}
