// Employee records: the HR master file. Admin only (role "admin"): not partners, not People Ops,
// not managers. Pay, identity numbers, bank details and personal data are encrypted at rest with
// AES-256-GCM (key HR_DATA_KEY, server settings only), so database backups do not expose them.
// Every view, change and export is written to the audit log (which fields — never the values).
// Employees can be asked to complete their own personal fields; what they send waits for the admin to apply.
import crypto from 'node:crypto';
import { uid, now, audit, bad, forbid, notFound } from '../db.js';
import { has, currentEmployment } from './authz.js';
import { todayIn } from './dates.js';
import { notify } from './mailer.js';

// ------------------------------------------------------------------ fields --
// who: 'admin' = only the admin fills it; 'employee' = the employee is asked for it
export const FIELDS = [
  { key: 'employee_code', label: 'Employee code', group: 'Job', who: 'admin' },
  { key: 'name_en', label: 'Name (English)', group: 'Job', who: 'admin' },
  { key: 'name_ar', label: 'Name (Arabic)', group: 'Job', who: 'employee', dir: 'rtl' },
  { key: 'title_en', label: 'Title (English)', group: 'Job', who: 'admin' },
  { key: 'title_ar', label: 'Title (Arabic)', group: 'Job', who: 'admin', dir: 'rtl' },
  { key: 'grade', label: 'Grade', group: 'Job', who: 'admin', options: ['A', 'B', 'C'] },
  { key: 'department_en', label: 'Department (English)', group: 'Job', who: 'admin' },
  { key: 'department_ar', label: 'Department (Arabic)', group: 'Job', who: 'admin', dir: 'rtl' },
  { key: 'division_en', label: 'Division (English)', group: 'Job', who: 'admin' },
  { key: 'division_ar', label: 'Division (Arabic)', group: 'Job', who: 'admin', dir: 'rtl' },
  { key: 'joining_date', label: 'Joining date', group: 'Job', who: 'admin', type: 'date' },
  { key: 'probation_end', label: 'End of probation', group: 'Job', who: 'admin', type: 'date' },
  { key: 'employment_type', label: 'Employment type', group: 'Job', who: 'admin', options: ['Full-time – permanent', 'Full-time – temporary', 'Part-time', 'Internship', 'Partner'] },
  { key: 'contract_end', label: 'Contract end date (temporary only)', group: 'Job', who: 'admin', type: 'date' },
  { key: 'basic_salary', label: 'Basic salary (JOD)', group: 'Pay', who: 'admin', type: 'money' },
  { key: 'mobile_allowance', label: 'Mobile allowance (JOD)', group: 'Pay', who: 'admin', type: 'money' },
  { key: 'transport_allowance', label: 'Transportation allowance (JOD)', group: 'Pay', who: 'admin', type: 'money' },
  { key: 'birth_date', label: 'Birth date', group: 'Personal', who: 'employee', type: 'date' },
  { key: 'gender', label: 'Gender', group: 'Personal', who: 'employee', options: ['Female', 'Male'] },
  { key: 'nationality', label: 'Nationality', group: 'Personal', who: 'employee' },
  { key: 'religion', label: 'Religion', group: 'Personal', who: 'employee' },
  { key: 'marital_status', label: 'Marital status', group: 'Personal', who: 'employee', options: ['Single', 'Married', 'Divorced', 'Widowed'] },
  { key: 'national_number', label: 'National number', group: 'Identity', who: 'employee' },
  { key: 'social_security_number', label: 'Social security number', group: 'Identity', who: 'employee' },
  { key: 'passport_number', label: 'Passport number', group: 'Identity', who: 'employee' },
  { key: 'education_level', label: 'Education level', group: 'Education', who: 'employee', options: ['Diploma', "Bachelor's", "Master's", 'Doctorate', 'Other'] },
  { key: 'specialization', label: 'Specialization', group: 'Education', who: 'employee' },
  { key: 'institute', label: 'Institute / university', group: 'Education', who: 'employee' },
  { key: 'certificates', label: 'Certificates', group: 'Education', who: 'employee' },
  { key: 'graduation_year', label: 'Graduation year', group: 'Education', who: 'employee', type: 'year' },
  { key: 'address', label: 'Address', group: 'Contact', who: 'employee' },
  { key: 'personal_email', label: 'Personal email', group: 'Contact', who: 'employee', type: 'email' },
  { key: 'mobile', label: 'Mobile number', group: 'Contact', who: 'employee', type: 'phone' },
  { key: 'emergency_name', label: 'Emergency contact name', group: 'Contact', who: 'employee' },
  { key: 'emergency_mobile', label: 'Emergency contact mobile', group: 'Contact', who: 'employee', type: 'phone' },
  { key: 'bank_name', label: 'Bank name', group: 'Bank', who: 'employee' },
  { key: 'iban', label: 'IBAN', group: 'Bank', who: 'employee', type: 'iban' },
];
const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const EMPLOYEE_KEYS = FIELDS.filter((f) => f.who === 'employee').map((f) => f.key);

// GB titles and departments in Arabic (job titles as GB uses them)
export const TITLE_AR = {
  'Consultant': 'مستشار', 'Senior Consultant': 'مستشار أول', 'Assistant Manager': 'مساعد مدير', 'Consulting Manager': 'مدير استشارات',
  'Consulting Director': 'مدير الاستشارات', 'Managing Director / Partner': 'المدير العام / شريك', 'Managing Partner': 'الشريك المدير',
  'Analyst': 'محلل', 'Business Analyst': 'محلل أعمال', 'Admin Lead': 'مسؤول الشؤون الإدارية', 'Intern': 'متدرب',
};
const SUFFIX_AR = { 'Ops': 'العمليات', 'Operations': 'العمليات', 'Client Engagement & Projects': 'إدارة العملاء والمشاريع' };
/** Arabic title: the GB title, plus its specialisation when there is one (e.g. "Assistant Manager – Ops"). */
export function titleAr(title) {
  if (!title) return null;
  if (TITLE_AR[title]) return TITLE_AR[title];
  const [base, suffix] = title.split(/\s+[–-]\s+/);
  if (!TITLE_AR[base]) return null;
  return suffix && SUFFIX_AR[suffix] ? `${TITLE_AR[base]} – ${SUFFIX_AR[suffix]}` : TITLE_AR[base];
}
const DEPT = (title = '') => (/partner|managing director|director/i.test(title) ? ['Executive Management', 'الإدارة التنفيذية'] : /admin/i.test(title) ? ['Administration', 'الشؤون الإدارية'] : ['Consulting', 'الاستشارات']);

// ------------------------------------------------------------- encryption --
function key() {
  const k = process.env.HR_DATA_KEY;
  if (k) { const b = Buffer.from(k, 'base64'); if (b.length !== 32) throw bad('HR_DATA_KEY must be 32 random bytes, base64-encoded'); return b; }
  if (process.env.NODE_ENV === 'production') throw bad('Employee records are locked: HR_DATA_KEY is not set on the server (see docs/DEPLOY.md).');
  return crypto.createHash('sha256').update('gb-prism-dev-only-hr-key').digest(); // development and tests only
}
export function seal(obj) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}
export function open(s) {
  if (!s) return {};
  const [v, iv, tag, data] = s.split('.'); if (v !== 'v1') throw bad('Unknown record format');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
}

// ----------------------------------------------------------------- access --
export const canAdmin = (a) => has(a, 'admin');
const requireAdmin = (a) => { if (!canAdmin(a)) throw forbid('Employee records are for the admin only'); };

// --------------------------------------------------------------- validate --
function clean(k, v) {
  const f = BY_KEY[k]; if (!f) throw bad(`Unknown field ${k}`);
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).trim().slice(0, f.key === 'certificates' || f.key === 'address' ? 500 : 160);
  if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${f.label}: use a date`);
  if (f.type === 'money') { const n = Number(s.replace(/,/g, '')); if (!(n >= 0) || n > 1e6) throw bad(`${f.label}: a positive amount`); return Math.round(n * 1000) / 1000; }
  if (f.type === 'year' && !/^(19|20)\d{2}$/.test(s)) throw bad(`${f.label}: a year like 2019`);
  if (f.type === 'email' && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s)) throw bad(`${f.label}: not an email address`);
  if (f.type === 'phone' && !/^\+?[0-9 ()-]{7,20}$/.test(s)) throw bad(`${f.label}: digits only, e.g. +962 79 123 4567`);
  if (f.type === 'iban') { const i = s.replace(/\s+/g, '').toUpperCase(); if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(i)) throw bad('IBAN: e.g. JO94 CBJO 0010 0000 0000 0131 0003 02'); return i; }
  if (f.options && !f.options.includes(s)) throw bad(`${f.label}: choose one of ${f.options.join(', ')}`);
  return s;
}

// ---------------------------------------------------------------- prefill --
/** Proposed grade within the person's title: A in the first two years at GB, B from two years, C from four. */
export function proposeGrade(joining, today = todayIn()) {
  if (!joining) return null;
  const years = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${joining}T00:00:00Z`)) / (365.25 * 864e5);
  return years >= 4 ? 'C' : years >= 2 ? 'B' : 'A';
}
/** What GB People already knows about the person. */
export function fromGbRecords(db, userId) {
  const u = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
  const e = currentEmployment(db, userId) || {};
  const p = db.prepare('SELECT * FROM employee_profiles WHERE user_id = ?').get(userId) || {};
  const [dEn, dAr] = DEPT(e.title);
  const partner = /partner/i.test(e.title || ''); const senior = partner || /director/i.test(e.title || '');
  const out = { name_en: u.name, title_en: e.title || null, title_ar: titleAr(e.title), department_en: dEn, department_ar: dAr,
    joining_date: e.hire_date || null, probation_end: e.probation_end || null, birth_date: p.date_of_birth || null,
    certificates: p.certifications || null, employment_type: partner ? 'Partner' : null, grade: senior ? null : proposeGrade(e.hire_date) };
  const edu = p.education || '';
  if (edu) {
    const first = edu.split(/;|\n/)[0];
    out.education_level = /ph\.?d|doctor/i.test(first) ? 'Doctorate' : /m\.?sc|master|mba|m\.a\b/i.test(first) ? "Master's" : /b\.?sc|bachelor|b\.a\b|beng/i.test(first) ? "Bachelor's" : null;
    const m = /^(?:[^,(]*?(?:B\.?Sc\.?|M\.?Sc\.?|MBA|B\.?A\.?|M\.?A\.?|Bachelor(?:'s)?|Master(?:'s)?)\b(?: (?:of|in)\b)?\s*)([^,(]+)?(?:\(([^)]*)\))?\s*,?\s*(.*)$/i.exec(first.trim());
    if (m) { out.specialization = (m[1] || '').replace(/^[.\s]+/, '').trim() || null; out.institute = (m[3] || '').trim() || null; }
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null && v !== ''));
}
function nextCode(db, tenantId) {
  const n = db.prepare("SELECT MAX(CAST(substr(employee_code, 4) AS INTEGER)) n FROM hr_records WHERE tenant_id = ? AND employee_code LIKE 'GB-%'").get(tenantId).n || 0;
  return `GB-${String(n + 1).padStart(3, '0')}`;
}
/** Create a record for everyone who has none, from GB People's own records; codes by joining date. */
export function prefillAll(db, actor) {
  requireAdmin(actor);
  const people = db.prepare(`SELECT u.id, e.hire_date FROM users u LEFT JOIN employments e ON e.user_id = u.id AND e.effective_to IS NULL
      WHERE u.tenant_id = ? AND u.active = 1 AND NOT EXISTS (SELECT 1 FROM hr_records r WHERE r.user_id = u.id) ORDER BY COALESCE(e.hire_date, '9999'), u.name`).all(actor.tenantId);
  for (const p of people) {
    const data = fromGbRecords(db, p.id); const code = nextCode(db, actor.tenantId);
    data.employee_code = code;
    const sources = Object.fromEntries(Object.keys(data).map((k) => [k, k === 'grade' ? 'Proposed by GB People — confirm' : 'GB People records']));
    db.prepare('INSERT INTO hr_records (user_id, tenant_id, employee_code, data_enc, updated_by, updated_at) VALUES (?,?,?,?,?,?)').run(p.id, actor.tenantId, code, seal({ data, sources }), actor.id, now());
  }
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'hr.prefill', entity: 'tenant', entityId: actor.tenantId, after: { created: people.length } });
  return { created: people.length };
}

// ------------------------------------------------------------------- view --
const load = (db, userId) => { const r = db.prepare('SELECT * FROM hr_records WHERE user_id = ?').get(userId); return r ? { row: r, ...open(r.data_enc) } : null; };
const gross = (d) => (d.basic_salary != null || d.mobile_allowance != null || d.transport_allowance != null ? Math.round(((d.basic_salary || 0) + (d.mobile_allowance || 0) + (d.transport_allowance || 0)) * 1000) / 1000 : null);
const completeness = (d) => Math.round((FIELDS.filter((f) => f.key !== 'contract_end' && d[f.key] != null && d[f.key] !== '').length / (FIELDS.length - 1)) * 100);
function manager(db, userId) {
  const e = currentEmployment(db, userId); if (!e?.manager_id) return { name: null, title: null };
  return { name: db.prepare('SELECT name FROM users WHERE id = ?').get(e.manager_id)?.name || null, title: currentEmployment(db, e.manager_id)?.title || null };
}
const lastRequest = (db, userId) => db.prepare('SELECT id, status, requested_at, submitted_at, decided_at, note FROM hr_record_requests WHERE user_id = ? ORDER BY requested_at DESC LIMIT 1').get(userId) || null;

export function listRecords(db, actor) {
  requireAdmin(actor);
  const rows = db.prepare(`SELECT u.id, u.name, u.email FROM users u WHERE u.tenant_id = ? AND u.active = 1 ORDER BY u.name`).all(actor.tenantId).map((u) => {
    const r = load(db, u.id); const d = r?.data || {};
    return { user_id: u.id, name: u.name, code: r?.row.employee_code || null, title: d.title_en || currentEmployment(db, u.id)?.title || null, grade: d.grade || null,
      joining_date: d.joining_date || null, has_record: !!r, complete: r ? completeness(d) : 0, request: lastRequest(db, u.id),
      missing_employee: EMPLOYEE_KEYS.filter((k) => d[k] == null || d[k] === '').length };
  });
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'hr.list', entity: 'tenant', entityId: actor.tenantId });
  return { rows, fields: FIELDS, locked: !process.env.HR_DATA_KEY && process.env.NODE_ENV === 'production' };
}

export function getRecord(db, actor, userId) {
  requireAdmin(actor);
  const u = db.prepare('SELECT id, name, email FROM users WHERE id = ? AND tenant_id = ?').get(userId, actor.tenantId); if (!u) throw notFound();
  const r = load(db, userId);
  const req = db.prepare("SELECT * FROM hr_record_requests WHERE user_id = ? AND status = 'submitted' ORDER BY submitted_at DESC LIMIT 1").get(userId);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'hr.view', entity: 'user', entityId: userId });
  const d = r?.data || {};
  return { user: u, data: d, sources: r?.sources || {}, gross_salary: gross(d), manager: manager(db, userId), fields: FIELDS, request: lastRequest(db, userId),
    submitted: req ? { id: req.id, at: req.submitted_at, data: open(req.submitted_enc) } : null, suggested: r ? null : fromGbRecords(db, userId) };
}

export function saveRecord(db, actor, userId, patch = {}) {
  requireAdmin(actor);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ?').get(userId, actor.tenantId)) throw notFound();
  const r = load(db, userId); const data = { ...(r?.data || {}) }; const sources = { ...(r?.sources || {}) };
  const changed = [];
  for (const [k, v] of Object.entries(patch)) { const c = clean(k, v); if (c !== (data[k] ?? null)) { if (c == null) delete data[k]; else data[k] = c; sources[k] = `Admin, ${todayIn()}`; changed.push(k); } }
  if (data.employment_type !== 'Full-time – temporary' && data.contract_end) { delete data.contract_end; changed.push('contract_end'); }
  const code = data.employee_code || r?.row.employee_code || nextCode(db, actor.tenantId); data.employee_code = code;
  const clash = db.prepare('SELECT user_id FROM hr_records WHERE tenant_id = ? AND employee_code = ? AND user_id != ?').get(actor.tenantId, code, userId);
  if (clash) throw bad(`Employee code ${code} is already used`);
  if (r) db.prepare('UPDATE hr_records SET employee_code = ?, data_enc = ?, updated_by = ?, updated_at = ? WHERE user_id = ?').run(code, seal({ data, sources }), actor.id, now(), userId);
  else db.prepare('INSERT INTO hr_records (user_id, tenant_id, employee_code, data_enc, updated_by, updated_at) VALUES (?,?,?,?,?,?)').run(userId, actor.tenantId, code, seal({ data, sources }), actor.id, now());
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'hr.update', entity: 'user', entityId: userId, after: { fields: changed } });
  return { ok: true, changed: changed.length, gross_salary: gross(data) };
}

// ---------------------------------------------------- asking employees --
export function requestData(db, actor, { userIds = [] } = {}) {
  requireAdmin(actor);
  const ids = userIds.length ? userIds : db.prepare('SELECT id FROM users WHERE tenant_id = ? AND active = 1').all(actor.tenantId).map((u) => u.id);
  let n = 0;
  for (const id of ids) {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ? AND active = 1').get(id, actor.tenantId)) continue;
    if (db.prepare("SELECT 1 FROM hr_record_requests WHERE user_id = ? AND status IN ('requested','submitted','returned')").get(id)) continue;
    const rid = uid('hrq_');
    db.prepare("INSERT INTO hr_record_requests (id, tenant_id, user_id, status, requested_by, requested_at) VALUES (?,?,?, 'requested', ?,?)").run(rid, actor.tenantId, id, actor.id, now());
    notify(db, { tenantId: actor.tenantId, to: id, event: 'hr.request', key: rid, link: '#/my-record', subject: 'Please complete your employee record',
      text: `${actor.name} asked you to complete your employee record in GB People (personal details, ID numbers, education, emergency contact and bank details). Only the GB admin can see it.` });
    n++;
  }
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'hr.request', entity: 'tenant', entityId: actor.tenantId, after: { asked: n } });
  return { asked: n };
}

/** The employee's own view: only the fields they are asked for, with what is on file. Never pay or grade. */
export function myRecord(db, actor) {
  const r = load(db, actor.id); const d = r?.data || {};
  const req = db.prepare("SELECT * FROM hr_record_requests WHERE user_id = ? AND status IN ('requested','submitted','returned') ORDER BY requested_at DESC LIMIT 1").get(actor.id);
  const sent = req?.submitted_enc ? open(req.submitted_enc) : null;
  const fields = FIELDS.filter((f) => f.who === 'employee');
  return { fields, values: Object.fromEntries(fields.map((f) => [f.key, sent?.[f.key] ?? d[f.key] ?? null])), request: req ? { id: req.id, status: req.status, note: req.note, submitted_at: req.submitted_at } : null,
    code: r?.row.employee_code || null, name_en: d.name_en || actor.name, title_en: d.title_en || currentEmployment(db, actor.id)?.title || null };
}
export function submitMyRecord(db, actor, values = {}) {
  const req = db.prepare("SELECT * FROM hr_record_requests WHERE user_id = ? AND status IN ('requested','returned','submitted') ORDER BY requested_at DESC LIMIT 1").get(actor.id);
  const out = {};
  for (const k of EMPLOYEE_KEYS) if (k in values) out[k] = clean(k, values[k]);
  for (const k of Object.keys(values)) if (!EMPLOYEE_KEYS.includes(k)) throw forbid(`${BY_KEY[k]?.label || k} is filled by the admin`);
  const id = req?.id || uid('hrq_');
  if (req) db.prepare("UPDATE hr_record_requests SET status = 'submitted', submitted_enc = ?, submitted_at = ?, note = NULL WHERE id = ?").run(seal(out), now(), id);
  else db.prepare("INSERT INTO hr_record_requests (id, tenant_id, user_id, status, requested_by, requested_at, submitted_enc, submitted_at) VALUES (?,?,?, 'submitted', ?,?,?,?)").run(id, actor.tenantId, actor.id, actor.id, now(), seal(out), now());
  const admins = db.prepare("SELECT DISTINCT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin' WHERE u.tenant_id = ? AND u.active = 1").all(actor.tenantId).map((r) => r.id).filter((x) => x !== actor.id);
  notify(db, { tenantId: actor.tenantId, to: admins, event: 'hr.submitted', key: `${id}:${now().slice(0, 16)}`, link: `#/admin/records?u=${actor.id}`, subject: `Employee record to review: ${actor.name}`, text: `${actor.name} sent their employee record details. Review and apply them in Admin → Employee records.` });
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'hr.submit', entity: 'user', entityId: actor.id, after: { fields: Object.keys(out).filter((k) => out[k] != null) } });
  return { ok: true };
}
export function decideSubmission(db, actor, requestId, { decision, note, values } = {}) {
  requireAdmin(actor);
  const req = db.prepare("SELECT * FROM hr_record_requests WHERE id = ? AND tenant_id = ? AND status = 'submitted'").get(requestId, actor.tenantId); if (!req) throw notFound();
  if (decision === 'return') {
    if (!String(note || '').trim()) throw bad('Say what needs correcting');
    db.prepare("UPDATE hr_record_requests SET status = 'returned', decided_by = ?, decided_at = ?, note = ? WHERE id = ?").run(actor.id, now(), String(note).trim().slice(0, 300), requestId);
    notify(db, { tenantId: actor.tenantId, to: req.user_id, event: 'hr.returned', key: `${requestId}:${now()}`, link: '#/my-record', subject: 'Please correct your employee record', text: `Your employee record needs a correction: ${String(note).trim()}` });
  } else if (decision === 'apply') {
    const sent = open(req.submitted_enc);
    const take = values && typeof values === 'object' ? Object.fromEntries(Object.entries(sent).filter(([k]) => values[k] !== false)) : sent;
    saveRecord(db, actor, req.user_id, Object.fromEntries(Object.entries(take).filter(([, v]) => v != null)));
    const r = load(db, req.user_id); for (const k of Object.keys(take)) if (take[k] != null) r.sources[k] = `Employee, ${req.submitted_at.slice(0, 10)}`;
    db.prepare('UPDATE hr_records SET data_enc = ? WHERE user_id = ?').run(seal({ data: r.data, sources: r.sources }), req.user_id);
    db.prepare("UPDATE hr_record_requests SET status = 'applied', decided_by = ?, decided_at = ?, submitted_enc = NULL WHERE id = ?").run(actor.id, now(), requestId);
  } else throw bad('Apply or return');
  return { ok: true };
}

/** For the inbox: the employee's own open request; the admin's submissions to review. */
export function hrInboxItems(db, actor) {
  const items = [];
  const mine = db.prepare("SELECT * FROM hr_record_requests WHERE user_id = ? AND status IN ('requested','returned') ORDER BY requested_at DESC LIMIT 1").get(actor.id);
  if (mine) items.push({ type: 'hr_record', kind: mine.status === 'returned' ? 'Correction requested' : 'Employee record', title: mine.status === 'returned' ? `Correct your employee record: ${mine.note}` : 'Complete your employee record', link: '#/my-record', scope: 'mine', action: 'Complete my record' });
  if (canAdmin(actor)) for (const r of db.prepare("SELECT r.id, r.user_id, u.name FROM hr_record_requests r JOIN users u ON u.id = r.user_id WHERE r.tenant_id = ? AND r.status = 'submitted' AND r.user_id != ? ORDER BY r.submitted_at").all(actor.tenantId, actor.id))
    items.push({ type: 'hr_review', kind: 'Employee record', title: `${r.name} sent their details`, link: `#/admin/records?u=${r.user_id}`, scope: 'team', action: 'Review' });
  return items;
}

/** Excel export for the admin: every field, gross computed, manager from the org chart. */
export async function exportXlsx(db, actor) {
  requireAdmin(actor);
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Employees', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  const cols = [...FIELDS.slice(0, 12), { key: 'manager_title', label: 'Direct manager title' }, { key: 'manager_name', label: 'Direct manager name' }, ...FIELDS.slice(12, 17), { key: 'gross_salary', label: 'Gross salary (JOD)' }, ...FIELDS.slice(17)];
  ws.columns = cols.map((c) => ({ header: c.label, key: c.key, width: Math.max(14, Math.min(40, c.label.length + 4)) }));
  ws.getRow(1).font = { bold: true };
  for (const u of db.prepare('SELECT id FROM users WHERE tenant_id = ? AND active = 1 ORDER BY name').all(actor.tenantId)) {
    const r = load(db, u.id); if (!r) continue;
    const m = manager(db, u.id);
    ws.addRow({ ...r.data, manager_title: m.title, manager_name: m.name, gross_salary: gross(r.data) });
  }
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'hr.export', entity: 'tenant', entityId: actor.tenantId });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
