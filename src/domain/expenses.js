// Expense claims, following GB's expense claim form (v1.0): a claim for a period, lines with date,
// receipt amount and currency, exchange rate, expense type, justification, chargeable Y/N and project;
// the reimbursable amount is receipt × rate in JOD. Every line carries its receipt / invoice.
// Flow: draft → submitted → approved (or rejected, back to the employee) → paid (People Ops).
// Visible to the employee, the approver, People Ops and partners.
import { tx, uid, now, audit, bad, forbid, notFound } from '../db.js';
import { isOps, has } from './authz.js';
import { toX100 } from './decimal.js';
import { storeFile, fileResponse } from './files.js';

const BASE = ['Rail Fare', 'Taxi/Bus/Tube/Tram', 'Air Fare', 'Car Parking/Tolls/Petrol', 'Car Maintenance/Service', 'Other Travel', 'Hotel (Room)', 'Hotel (Food & Drink)',
  'Subsistence (personal)', 'Entertainment', 'Professional Subscriptions', 'Study/Exam Fees', 'Internet Access', 'Courier', 'Postage', 'Subsistence (office/department wide)',
  'Medical Costs (Consultancy staff)', 'Medical Costs (Non-Consultancy staff)', 'Other'];
const CD = ['Rail Fare', 'Taxi/Bus/Tube/Tram', 'Air Fare', 'Car Parking/Tolls', 'Other Travel', 'Hotel (Room)', 'Hotel (Food & Drink)', 'Subsistence', 'Entertainment', 'Other'].map((c) => `${c} (Client Development)`);
export const EXPENSE_CATEGORIES = [...BASE, ...CD];
export const CURRENCIES = ['JOD', 'USD', 'SAR', 'AED', 'EUR', 'GBP', 'KWD', 'QAR', 'OMR', 'BHD', 'TRY', 'CHF', 'IQD', 'EGP'];

const settingOf = (db, t, key) => { const r = db.prepare('SELECT value_json FROM settings WHERE tenant_id = ? AND key = ?').get(t, key); return r ? JSON.parse(r.value_json) : null; };
/** Expenses go to the GB expense approver (default: the central leave approver), never to the claimant. */
export function approverFor(db, tenantId, userId) {
  const a = settingOf(db, tenantId, 'expense_approver') || settingOf(db, tenantId, 'leave_approver');
  if (a && a !== userId && db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(a)) return a;
  // the approver's own claims go to another partner, else People Ops
  return db.prepare(`SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role IN ('partner','people_ops') WHERE u.tenant_id = ? AND u.active = 1 AND u.id != ?
      ORDER BY r.role = 'partner' DESC, u.name LIMIT 1`).get(tenantId, userId)?.id || null;
}

/** receipt amount × rate, both exact decimals, rounded half-up to fils/cents. */
export function convert(receiptX100, rate) {
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(String(rate ?? '').trim());
  if (!m) throw bad('Exchange rate must be a number like 0.709');
  const r = BigInt(m[1] + (m[2] || '').padEnd(6, '0'));
  if (r === 0n) throw bad('Exchange rate must be above zero');
  return Number((BigInt(receiptX100) * r + 500000n) / 1000000n);
}

function load(db, actor, id) {
  const c = db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(id);
  if (!c || c.tenant_id !== actor.tenantId) throw notFound();
  return c;
}
const canSee = (actor, c) => c.user_id === actor.id || c.approver_id === actor.id || isOps(actor) || has(actor, 'partner');
const canDecide = (actor, c) => c.user_id !== actor.id && (c.approver_id === actor.id || has(actor, 'partner'));

export function claimView(db, actor, id) {
  const c = load(db, actor, id); if (!canSee(actor, c)) throw forbid();
  const lines = db.prepare(`SELECT l.*, p.name project_name, f.filename receipt_name FROM expense_lines l LEFT JOIN projects p ON p.id = l.project_id
      LEFT JOIN files f ON f.id = l.receipt_file_id WHERE l.claim_id = ? ORDER BY l.position, l.spent_on`).all(id).map((l) => ({ ...l, chargeable: !!l.chargeable }));
  const who = (u) => (u ? db.prepare('SELECT name FROM users WHERE id = ?').get(u)?.name : null);
  return { ...c, employee: who(c.user_id), approver: who(c.approver_id), decided_by_name: who(c.decided_by), lines,
    can: { edit: c.user_id === actor.id && c.status === 'draft', decide: c.status === 'submitted' && canDecide(actor, c), pay: c.status === 'approved' && isOps(actor) } };
}

export function listClaims(db, actor, { scope = 'mine' } = {}) {
  const base = `SELECT c.*, u.name employee, (SELECT COUNT(*) FROM expense_lines l WHERE l.claim_id = c.id) lines FROM expense_claims c JOIN users u ON u.id = c.user_id WHERE c.tenant_id = ?`;
  if (scope === 'mine') return db.prepare(`${base} AND c.user_id = ? ORDER BY c.created_at DESC`).all(actor.tenantId, actor.id);
  if (scope === 'approve') return db.prepare(`${base} AND c.status = 'submitted' AND c.user_id != ? AND (c.approver_id = ? OR ?) ORDER BY c.submitted_at`).all(actor.tenantId, actor.id, actor.id, has(actor, 'partner') ? 1 : 0);
  if (scope === 'all') { if (!isOps(actor) && !has(actor, 'partner')) throw forbid(); return db.prepare(`${base} AND c.status != 'draft' ORDER BY c.submitted_at DESC`).all(actor.tenantId); }
  throw bad('Unknown list');
}

export function createClaim(db, actor, { title, period_from, period_to } = {}) {
  const t = String(title || '').trim().slice(0, 120); if (!t) throw bad('Give the claim a title, e.g. “Riyadh trip, March”');
  const id = uid('exp_');
  db.prepare('INSERT INTO expense_claims (id, tenant_id, user_id, title, period_from, period_to, created_at) VALUES (?,?,?,?,?,?,?)').run(id, actor.tenantId, actor.id, t, period_from || null, period_to || null, now());
  return { id };
}

const recalc = (db, id) => db.prepare('UPDATE expense_claims SET total_x100 = (SELECT COALESCE(SUM(amount_x100), 0) FROM expense_lines WHERE claim_id = ?) WHERE id = ?').run(id, id);
function editable(db, actor, id) { const c = load(db, actor, id); if (c.user_id !== actor.id) throw forbid(); if (c.status !== 'draft') throw bad('This claim is no longer a draft'); return c; }

export function saveLine(db, actor, claimId, lineId, b = {}) {
  const c = editable(db, actor, claimId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.spent_on || '')) throw bad('Date is required');
  if (b.spent_on > new Date().toISOString().slice(0, 10)) throw bad('The date cannot be in the future');
  if (!EXPENSE_CATEGORIES.includes(b.category)) throw bad('Choose an expense type');
  const description = String(b.description || '').trim().slice(0, 300); if (!description) throw bad('Add a justification');
  let receipt; try { receipt = toX100(b.receipt_amount); } catch (e) { throw bad(e.message); }
  if (!receipt || receipt <= 0) throw bad('Receipt amount must be above zero');
  const cur = CURRENCIES.includes(b.receipt_currency) ? b.receipt_currency : null; if (!cur) throw bad('Choose the receipt currency');
  const rate = cur === c.currency ? '1' : String(b.fx_rate ?? '').trim();
  const amount = convert(receipt, rate);
  if (b.project_id && !db.prepare('SELECT 1 FROM projects WHERE id = ? AND tenant_id = ?').get(b.project_id, actor.tenantId)) throw bad('Unknown project');
  const vals = [b.spent_on, b.category, description, b.project_id || null, String(b.project_text || '').slice(0, 120) || null, b.chargeable ? 1 : 0, receipt, cur, rate, amount];
  return tx(db, () => {
    let id = lineId;
    if (id) {
      const ex = db.prepare('SELECT id FROM expense_lines WHERE id = ? AND claim_id = ?').get(id, claimId); if (!ex) throw notFound();
      db.prepare('UPDATE expense_lines SET spent_on = ?, category = ?, description = ?, project_id = ?, project_text = ?, chargeable = ?, receipt_amount_x100 = ?, receipt_currency = ?, fx_rate = ?, amount_x100 = ? WHERE id = ?').run(...vals, id);
    } else {
      id = uid('exl_');
      const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 n FROM expense_lines WHERE claim_id = ?').get(claimId).n;
      db.prepare('INSERT INTO expense_lines (spent_on, category, description, project_id, project_text, chargeable, receipt_amount_x100, receipt_currency, fx_rate, amount_x100, id, tenant_id, claim_id, position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals, id, actor.tenantId, claimId, pos);
    }
    recalc(db, claimId);
    return { id };
  });
}

export function removeLine(db, actor, claimId, lineId) {
  editable(db, actor, claimId);
  tx(db, () => { db.prepare('DELETE FROM expense_lines WHERE id = ? AND claim_id = ?').run(lineId, claimId); recalc(db, claimId); });
  return { ok: true };
}

export function attachReceipt(db, actor, claimId, lineId, buffer, filename) {
  editable(db, actor, claimId);
  const l = db.prepare('SELECT id FROM expense_lines WHERE id = ? AND claim_id = ?').get(lineId, claimId); if (!l) throw notFound();
  const fileId = storeFile(db, actor, { purpose: 'receipt', filename, buffer });
  db.prepare('UPDATE expense_lines SET receipt_file_id = ? WHERE id = ?').run(fileId, lineId);
  return { ok: true };
}

export function receipt(db, actor, claimId, lineId) {
  const c = load(db, actor, claimId); if (!canSee(actor, c)) throw forbid();
  const l = db.prepare('SELECT receipt_file_id FROM expense_lines WHERE id = ? AND claim_id = ?').get(lineId, claimId);
  if (!l?.receipt_file_id) throw notFound();
  return fileResponse(db, actor.tenantId, l.receipt_file_id);
}

export function submitClaim(db, actor, id) {
  const c = editable(db, actor, id);
  const lines = db.prepare('SELECT * FROM expense_lines WHERE claim_id = ?').all(id);
  if (!lines.length) throw bad('Add at least one expense');
  const missing = lines.filter((l) => !l.receipt_file_id).length;
  if (missing) throw bad(`Upload the receipt or invoice for ${missing === 1 ? 'one line' : `${missing} lines`} before submitting`);
  const approver = approverFor(db, actor.tenantId, actor.id); if (!approver) throw bad('No expense approver is set up — ask People Ops');
  db.prepare("UPDATE expense_claims SET status = 'submitted', submitted_at = ?, approver_id = ?, decided_by = NULL, decided_at = NULL WHERE id = ?").run(now(), approver, id);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'expense.submit', entity: 'expense_claim', entityId: id, after: { total_x100: c.total_x100 } });
  return { ok: true, approver };
}

export function decideClaim(db, actor, id, { decision, note } = {}) {
  const c = load(db, actor, id);
  if (c.status !== 'submitted') throw bad('Only submitted claims can be decided');
  if (!canDecide(actor, c)) throw forbid();
  if (!['approve', 'reject'].includes(decision)) throw bad('Approve or reject');
  const n = String(note || '').trim().slice(0, 500);
  if (decision === 'reject' && !n) throw bad('Say what needs to change');
  // rejected claims go back to the employee as a draft so they can fix and resubmit
  db.prepare('UPDATE expense_claims SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(decision === 'approve' ? 'approved' : 'draft', actor.id, now(), n || null, id);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: `expense.${decision}`, entity: 'expense_claim', entityId: id, reason: n || null });
  return { ok: true };
}

export function markPaid(db, actor, id) {
  const c = load(db, actor, id); if (!isOps(actor)) throw forbid(); if (c.status !== 'approved') throw bad('Only approved claims can be marked paid');
  db.prepare("UPDATE expense_claims SET status = 'paid', paid_by = ?, paid_at = ? WHERE id = ?").run(actor.id, now(), id);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'expense.paid', entity: 'expense_claim', entityId: id });
  return { ok: true };
}

export function deleteClaim(db, actor, id) {
  editable(db, actor, id);
  tx(db, () => { db.prepare('DELETE FROM expense_lines WHERE claim_id = ?').run(id); db.prepare('DELETE FROM expense_claims WHERE id = ?').run(id); });
  return { ok: true };
}
