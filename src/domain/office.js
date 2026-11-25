// Office running costs (rent, utilities, kitchen, supplies, fines…) kept by the person GB assigns —
// the office administrator — and the register of company documents: licences, registrations and other
// government papers, with expiry dates so renewals are never missed.
// Access: office administrators, People Ops and partners. Everyone else sees neither.
import { tx, uid, now, audit, bad, forbid, notFound } from '../db.js';
import { isOps, has } from './authz.js';
import { toX100 } from './decimal.js';
import { storeFile, fileResponse } from './files.js';

export const OFFICE_CATEGORIES = ['Rent', 'Electricity', 'Water', 'Internet and phone', 'Coffee, tea and kitchen', 'Cups and disposables', 'Paper and stationery',
  'Printing and toner', 'Cleaning and hygiene', 'Maintenance and repairs', 'Furniture and equipment', 'Fines and penalties', 'Government fees and stamps', 'Courier and post',
  'Subscriptions and software', 'Hospitality and events', 'Other'];
export const DOCUMENT_KINDS = ['Commercial registration', 'Professional / trade licence', 'Municipality (vocational) licence', 'Chamber of commerce membership',
  'Tax registration (income and sales tax)', 'Social Security registration', 'Ministry of Labour registration', 'Lease contract', 'Insurance policy',
  'Bank and authorised signatories', 'Articles of association', 'Other government paper'];
const PAID_BY = ['company', 'petty_cash', 'employee'];
export const EXPIRY_WARN_DAYS = 60;

const settingOf = (db, t, k) => { const r = db.prepare('SELECT value_json FROM settings WHERE tenant_id = ? AND key = ?').get(t, k); return r ? JSON.parse(r.value_json) : null; };
export const officeAdmins = (db, tenantId) => settingOf(db, tenantId, 'office_admins') || [];
export const canOffice = (db, actor) => isOps(actor) || has(actor, 'partner') || officeAdmins(db, actor.tenantId).includes(actor.id);
const must = (db, actor) => { if (!canOffice(db, actor)) throw forbid(); };
const date = (v, label) => { if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`${label}: use yyyy-mm-dd`); return v; };

/** Partners / People Ops choose who keeps the office records. */
export function setOfficeAdmins(db, actor, userIds = []) {
  if (!isOps(actor) && !has(actor, 'partner')) throw forbid();
  const ids = [...new Set(userIds)];
  for (const id of ids) if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ? AND active = 1').get(id, actor.tenantId)) throw bad('Unknown person');
  db.prepare("INSERT INTO settings (tenant_id, key, value_json) VALUES (?, 'office_admins', ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json").run(actor.tenantId, JSON.stringify(ids));
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'office.admins', entity: 'settings', entityId: 'office_admins', after: { ids } });
  return { ok: true };
}

// ------------------------------------------------------------ office expenses --
export function officeView(db, actor, { month } = {}) {
  must(db, actor);
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : new Date().toISOString().slice(0, 7);
  const rows = db.prepare(`SELECT o.*, u.name entered_by_name FROM office_expenses o JOIN users u ON u.id = o.entered_by WHERE o.tenant_id = ? AND o.month = ? ORDER BY o.spent_on DESC, o.created_at DESC`).all(actor.tenantId, m);
  const year = m.slice(0, 4);
  const byMonth = db.prepare("SELECT month, SUM(amount_x100) total_x100 FROM office_expenses WHERE tenant_id = ? AND month LIKE ? GROUP BY month ORDER BY month").all(actor.tenantId, `${year}-%`);
  const byCategory = db.prepare('SELECT category, SUM(amount_x100) total_x100, COUNT(*) n FROM office_expenses WHERE tenant_id = ? AND month LIKE ? GROUP BY category ORDER BY total_x100 DESC').all(actor.tenantId, `${year}-%`);
  const admins = officeAdmins(db, actor.tenantId).map((id) => db.prepare('SELECT id, name FROM users WHERE id = ?').get(id)).filter(Boolean);
  return { month: m, rows, total_x100: rows.reduce((s, r) => s + r.amount_x100, 0), year, byMonth, byCategory, admins, categories: OFFICE_CATEGORIES,
    canAssign: isOps(actor) || has(actor, 'partner') };
}

export function saveOfficeExpense(db, actor, id, b = {}) {
  must(db, actor);
  const spent = date(b.spent_on, 'Date'); if (!spent) throw bad('Date is required');
  if (!OFFICE_CATEGORIES.includes(b.category)) throw bad('Choose a category');
  let amt; try { amt = toX100(b.amount); } catch (e) { throw bad(e.message); }
  if (!amt || amt <= 0) throw bad('Amount must be above zero');
  const paid = PAID_BY.includes(b.paid_by) ? b.paid_by : 'company';
  const vals = [spent, spent.slice(0, 7), b.category, String(b.vendor || '').trim().slice(0, 120) || null, String(b.description || '').trim().slice(0, 300) || null, amt, paid];
  if (id) {
    const r = db.prepare('UPDATE office_expenses SET spent_on = ?, month = ?, category = ?, vendor = ?, description = ?, amount_x100 = ?, paid_by = ?, updated_at = ? WHERE id = ? AND tenant_id = ?').run(...vals, now(), id, actor.tenantId);
    if (!r.changes) throw notFound();
  } else {
    id = uid('ofx_');
    db.prepare('INSERT INTO office_expenses (spent_on, month, category, vendor, description, amount_x100, paid_by, id, tenant_id, entered_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...vals, id, actor.tenantId, actor.id, now());
  }
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'office.expense', entity: 'office_expense', entityId: id, after: { category: b.category, amount_x100: amt } });
  return { id };
}
export function deleteOfficeExpense(db, actor, id) {
  must(db, actor);
  const r = db.prepare('DELETE FROM office_expenses WHERE id = ? AND tenant_id = ?').run(id, actor.tenantId); if (!r.changes) throw notFound();
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'office.expense.delete', entity: 'office_expense', entityId: id });
  return { ok: true };
}
export function attachOfficeReceipt(db, actor, id, buffer, filename) {
  must(db, actor);
  if (!db.prepare('SELECT 1 FROM office_expenses WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId)) throw notFound();
  const f = storeFile(db, actor, { purpose: 'office_receipt', filename, buffer });
  db.prepare('UPDATE office_expenses SET receipt_file_id = ? WHERE id = ?').run(f, id);
  return { ok: true };
}
export function officeReceipt(db, actor, id) {
  must(db, actor);
  const r = db.prepare('SELECT receipt_file_id FROM office_expenses WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId);
  if (!r?.receipt_file_id) throw notFound();
  return fileResponse(db, actor.tenantId, r.receipt_file_id);
}
/** CSV for the accountant: one year of office costs. */
export function officeCsv(db, actor, year) {
  must(db, actor);
  if (!/^\d{4}$/.test(year || '')) throw bad('Year like 2026');
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = db.prepare('SELECT o.*, u.name who FROM office_expenses o JOIN users u ON u.id = o.entered_by WHERE o.tenant_id = ? AND o.month LIKE ? ORDER BY o.spent_on').all(actor.tenantId, `${year}-%`);
  const csv = ['Date,Category,Vendor,Description,Amount,Currency,Paid by,Receipt,Entered by', ...rows.map((r) => [r.spent_on, r.category, r.vendor, r.description, (r.amount_x100 / 100).toFixed(2), r.currency, r.paid_by, r.receipt_file_id ? 'yes' : 'no', r.who].map(q).join(','))].join('\r\n');
  return { __raw: Buffer.from(`﻿${csv}`), contentType: 'text/csv; charset=utf-8', filename: `GB_office_expenses_${year}.csv` };
}

// ---------------------------------------------------------- company documents --
const statusOf = (d, today = new Date().toISOString().slice(0, 10)) => {
  if (!d.expires_on) return 'no_expiry';
  if (d.expires_on < today) return 'expired';
  const days = Math.round((new Date(`${d.expires_on}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 864e5);
  return days <= EXPIRY_WARN_DAYS ? 'expiring' : 'valid';
};
export function documentsView(db, actor) {
  must(db, actor);
  const docs = db.prepare(`SELECT d.*, u.name renewal_owner, f.filename, f.mime FROM company_documents d LEFT JOIN users u ON u.id = d.renewal_owner_id LEFT JOIN files f ON f.id = d.file_id
      WHERE d.tenant_id = ? AND d.archived = 0 ORDER BY d.expires_on IS NULL, d.expires_on, d.kind`).all(actor.tenantId).map((d) => ({ ...d, status: statusOf(d) }));
  return { docs, kinds: DOCUMENT_KINDS, warn_days: EXPIRY_WARN_DAYS };
}
export function saveDocument(db, actor, id, b = {}) {
  must(db, actor);
  if (!DOCUMENT_KINDS.includes(b.kind)) throw bad('Choose the type of document');
  const title = String(b.title || b.kind).trim().slice(0, 160);
  const issued = date(b.issued_on, 'Issued'); const expires = date(b.expires_on, 'Expires');
  if (issued && expires && expires < issued) throw bad('Expiry is before the issue date');
  if (b.renewal_owner_id && !db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ?').get(b.renewal_owner_id, actor.tenantId)) throw bad('Unknown person');
  const drive = String(b.drive_url || '').trim(); if (drive && !/^https:\/\/(drive|docs)\.google\.com\//.test(drive)) throw bad('Use a Google Drive link');
  const vals = [b.kind, title, String(b.number || '').trim().slice(0, 80) || null, String(b.issuer || '').trim().slice(0, 160) || null, issued, expires, b.renewal_owner_id || null,
    String(b.notes || '').trim().slice(0, 1000) || null, drive || null, actor.id, now()];
  if (id) {
    const r = db.prepare('UPDATE company_documents SET kind = ?, title = ?, number = ?, issuer = ?, issued_on = ?, expires_on = ?, renewal_owner_id = ?, notes = ?, drive_url = ?, updated_by = ?, updated_at = ? WHERE id = ? AND tenant_id = ?').run(...vals, id, actor.tenantId);
    if (!r.changes) throw notFound();
  } else {
    id = uid('doc_');
    db.prepare('INSERT INTO company_documents (kind, title, number, issuer, issued_on, expires_on, renewal_owner_id, notes, drive_url, updated_by, updated_at, id, tenant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals, id, actor.tenantId);
  }
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'document.save', entity: 'company_document', entityId: id, after: { kind: b.kind, expires } });
  return { id };
}
export function archiveDocument(db, actor, id) {
  must(db, actor);
  const r = db.prepare('UPDATE company_documents SET archived = 1, updated_by = ?, updated_at = ? WHERE id = ? AND tenant_id = ?').run(actor.id, now(), id, actor.tenantId);
  if (!r.changes) throw notFound();
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'document.archive', entity: 'company_document', entityId: id });
  return { ok: true };
}
export function attachDocumentFile(db, actor, id, buffer, filename) {
  must(db, actor);
  if (!db.prepare('SELECT 1 FROM company_documents WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId)) throw notFound();
  const f = storeFile(db, actor, { purpose: 'company_document', filename, buffer, maxBytes: 10 * 1024 * 1024 });
  db.prepare('UPDATE company_documents SET file_id = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(f, actor.id, now(), id);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'document.file', entity: 'company_document', entityId: id });
  return { ok: true };
}
export function documentFile(db, actor, id) {
  must(db, actor);
  const d = db.prepare('SELECT file_id FROM company_documents WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId);
  if (!d?.file_id) throw notFound();
  return fileResponse(db, actor.tenantId, d.file_id);
}
/** Inbox: documents expired or expiring soon, for the people who keep them. */
export function expiringDocuments(db, actor) {
  if (!canOffice(db, actor)) return [];
  return documentsView(db, actor).docs.filter((d) => ['expired', 'expiring'].includes(d.status));
}
