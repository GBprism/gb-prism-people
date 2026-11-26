// People lifecycle after onboarding: offboarding (a leaver checklist with owners, ending with the account
// switched off) and training records (courses, hours, certificates and their expiry).
// Offboarding: People Ops and partners. Training: the person adds their own; their manager, People Ops
// and partners can see it; People Ops verifies.
import { tx, uid, now, audit, bad, forbid, notFound } from '../db.js';
import { isOps, has, currentEmployment } from './authz.js';
import { storeFile, fileResponse } from './files.js';
import { toX100 } from './decimal.js';

const editor = (a) => isOps(a) || has(a, 'partner');
export const OFFBOARDING_STEPS = [
  { key: 'handover', title: 'Hand over projects, files and client contacts to named colleagues', owner: 'manager' },
  { key: 'drive', title: 'Move their Drive files to the project shared drives; transfer ownership', owner: 'leaver' },
  { key: 'timesheet', title: 'Submit the final timesheet and any expense claims', owner: 'leaver' },
  { key: 'leave', title: 'Settle the leave balance (days taken or paid in final settlement)', owner: 'hr' },
  { key: 'equipment', title: 'Return the laptop, charger, access card and any other equipment', owner: 'leaver' },
  { key: 'claude', title: 'Remove them from their Claude seat and reassign it', owner: 'hr' },
  { key: 'access', title: 'Suspend the Google Workspace account; forward email to the manager; remove from shared drives and groups', owner: 'hr' },
  { key: 'other_access', title: 'Remove other access (client portals, WhatsApp groups, tools, office door code)', owner: 'hr' },
  { key: 'exit_interview', title: 'Hold the exit interview', owner: 'hr' },
  { key: 'letter', title: 'Issue the experience letter', owner: 'hr' },
  { key: 'settlement', title: 'Final settlement and Social Security de-registration', owner: 'hr' },
];
export const OFFBOARDING_KINDS = ['resignation', 'end of contract', 'end of internship', 'termination', 'other'];

export function startOffboarding(db, actor, { user_id, last_day, kind } = {}) {
  if (!editor(actor)) throw forbid();
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ? AND active = 1').get(user_id, actor.tenantId); if (!u) throw bad('Choose an active person');
  if (u.id === actor.id) throw bad('Someone else runs your offboarding');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(last_day || '')) throw bad('Last working day: use yyyy-mm-dd');
  if (db.prepare("SELECT 1 FROM offboardings WHERE user_id = ? AND status = 'open'").get(u.id)) throw bad('Offboarding is already open for this person');
  const id = uid('off_');
  tx(db, () => {
    db.prepare('INSERT INTO offboardings (id, tenant_id, user_id, last_day, kind, started_by, started_at) VALUES (?,?,?,?,?,?,?)').run(id, actor.tenantId, u.id, last_day, OFFBOARDING_KINDS.includes(kind) ? kind : 'other', actor.id, now());
    OFFBOARDING_STEPS.forEach((s, i) => db.prepare('INSERT INTO offboarding_steps (id, offboarding_id, key, title, owner, position) VALUES (?,?,?,?,?,?)').run(uid('ofs_'), id, s.key, s.title, s.owner, i));
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'offboarding.start', entity: 'user', entityId: u.id, after: { last_day } });
  });
  return { id };
}

export function offboardingView(db, actor) {
  const mine = db.prepare("SELECT o.* FROM offboardings o WHERE o.user_id = ? AND o.status = 'open'").get(actor.id);
  const managed = db.prepare("SELECT o.id FROM offboardings o JOIN employments e ON e.user_id = o.user_id AND e.effective_to IS NULL WHERE e.manager_id = ? AND o.status = 'open'").all(actor.id).map((r) => r.id);
  const list = editor(actor) ? db.prepare('SELECT o.* FROM offboardings o WHERE o.tenant_id = ? ORDER BY o.status = \'open\' DESC, o.last_day DESC').all(actor.tenantId)
    : db.prepare('SELECT * FROM offboardings WHERE id IN (' + [mine?.id, ...managed].filter(Boolean).map(() => '?').join(',') + ')').all(...[mine?.id, ...managed].filter(Boolean));
  return { canManage: editor(actor), kinds: OFFBOARDING_KINDS, items: list.map((o) => ({ ...o, name: db.prepare('SELECT name FROM users WHERE id = ?').get(o.user_id)?.name,
    steps: db.prepare('SELECT s.*, u.name done_by_name FROM offboarding_steps s LEFT JOIN users u ON u.id = s.done_by WHERE s.offboarding_id = ? ORDER BY s.position').all(o.id) })) };
}

export function tickOffboardingStep(db, actor, stepId, done, note) {
  const s = db.prepare('SELECT s.*, o.user_id, o.tenant_id, o.status FROM offboarding_steps s JOIN offboardings o ON o.id = s.offboarding_id WHERE s.id = ?').get(stepId);
  if (!s || s.tenant_id !== actor.tenantId) throw notFound();
  if (s.status !== 'open') throw bad('This offboarding is closed');
  const isManager = currentEmployment(db, s.user_id)?.manager_id === actor.id;
  const allowed = editor(actor) || (s.owner === 'leaver' && s.user_id === actor.id) || (s.owner === 'manager' && isManager);
  if (!allowed) throw forbid();
  db.prepare('UPDATE offboarding_steps SET done_by = ?, done_at = ?, note = ? WHERE id = ?').run(done ? actor.id : null, done ? now() : null, String(note || '').slice(0, 300) || null, stepId);
  return { ok: true };
}

/** Close the offboarding; optionally switch the account off (no more sign-in; history is kept). */
export function completeOffboarding(db, actor, id, { deactivate = true } = {}) {
  if (!editor(actor)) throw forbid();
  const o = db.prepare('SELECT * FROM offboardings WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!o) throw notFound();
  const left = db.prepare('SELECT COUNT(*) n FROM offboarding_steps WHERE offboarding_id = ? AND done_at IS NULL').get(id).n;
  if (left) throw bad(`${left} step(s) still open`);
  tx(db, () => {
    db.prepare("UPDATE offboardings SET status = 'completed', completed_at = ? WHERE id = ?").run(now(), id);
    if (deactivate) {
      db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(o.user_id);
      db.prepare("UPDATE employments SET effective_to = ? WHERE user_id = ? AND effective_to IS NULL").run(o.last_day, o.user_id);
      db.prepare('DELETE FROM claude_account_users WHERE user_id = ?').run(o.user_id);
    }
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'offboarding.complete', entity: 'user', entityId: o.user_id, after: { deactivate } });
  });
  return { ok: true };
}

// ---------------------------------------------------------------- training --
export const TRAINING_KINDS = ['course', 'certification', 'workshop', 'conference', 'self_study'];
const canSeeTraining = (db, actor, userId) => actor.id === userId || editor(actor) || currentEmployment(db, userId)?.manager_id === actor.id;

export function trainingView(db, actor, userId = actor.id) {
  if (!canSeeTraining(db, actor, userId)) throw forbid();
  const rows = db.prepare('SELECT t.*, v.name verified_by_name FROM trainings t LEFT JOIN users v ON v.id = t.verified_by WHERE t.user_id = ? AND t.tenant_id = ? ORDER BY COALESCE(t.end_on, t.start_on, t.created_at) DESC').all(userId, actor.tenantId);
  const y = String(new Date().getFullYear());
  return { user_id: userId, kinds: TRAINING_KINDS, rows: rows.map((r) => ({ ...r, has_file: !!r.file_id, file_id: undefined })), hours_this_year_x100: rows.filter((r) => (r.end_on || r.start_on || '').startsWith(y)).reduce((s, r) => s + r.hours_x100, 0),
    canVerify: editor(actor) && userId !== actor.id };
}

export function saveTraining(db, actor, id, b = {}, file) {
  const userId = id ? db.prepare('SELECT user_id FROM trainings WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId)?.user_id : actor.id;
  if (!userId) throw notFound();
  if (userId !== actor.id && !editor(actor)) throw forbid();
  const title = String(b.title || '').trim().slice(0, 160); if (!title) throw bad('Name the course or certificate');
  if (!TRAINING_KINDS.includes(b.kind)) throw bad('Choose the type');
  const d = (v, l) => { if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`${l}: use yyyy-mm-dd`); return v; };
  let hours; try { hours = b.hours === '' || b.hours == null ? 0 : toX100(b.hours); } catch (e) { throw bad(e.message); }
  if (hours < 0 || hours > 100000) throw bad('Check the hours');
  const vals = [title, String(b.provider || '').slice(0, 120) || null, b.kind, d(b.start_on, 'Start'), d(b.end_on, 'End'), hours, d(b.expires_on, 'Expiry')];
  if (id) { db.prepare('UPDATE trainings SET title = ?, provider = ?, kind = ?, start_on = ?, end_on = ?, hours_x100 = ?, expires_on = ?, verified_by = NULL, verified_at = NULL WHERE id = ?').run(...vals, id); }
  else { id = uid('trn_'); db.prepare('INSERT INTO trainings (title, provider, kind, start_on, end_on, hours_x100, expires_on, id, tenant_id, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...vals, id, actor.tenantId, userId, now()); }
  if (file?.buffer?.length) db.prepare('UPDATE trainings SET file_id = ? WHERE id = ?').run(storeFile(db, actor, { purpose: 'training', filename: file.name, buffer: file.buffer }), id);
  return { id };
}
export function verifyTraining(db, actor, id) {
  const t = db.prepare('SELECT * FROM trainings WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!t) throw notFound();
  if (!editor(actor) || t.user_id === actor.id) throw forbid();
  db.prepare('UPDATE trainings SET verified_by = ?, verified_at = ? WHERE id = ?').run(actor.id, now(), id);
  return { ok: true };
}
export function deleteTraining(db, actor, id) {
  const t = db.prepare('SELECT * FROM trainings WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!t) throw notFound();
  if (t.user_id !== actor.id && !editor(actor)) throw forbid();
  db.prepare('DELETE FROM trainings WHERE id = ?').run(id);
  return { ok: true };
}
export function trainingFile(db, actor, id) {
  const t = db.prepare('SELECT * FROM trainings WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!t?.file_id) throw notFound();
  if (!canSeeTraining(db, actor, t.user_id)) throw forbid();
  return fileResponse(db, actor.tenantId, t.file_id);
}
/** Team overview for partners / People Ops: hours this year and certificates expiring in 90 days. */
export function trainingOverview(db, actor) {
  if (!editor(actor)) throw forbid();
  const y = String(new Date().getFullYear()); const in90 = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
  return { people: db.prepare(`SELECT u.id, u.name, COALESCE(SUM(CASE WHEN COALESCE(t.end_on, t.start_on) LIKE ? THEN t.hours_x100 END), 0) hours_x100, COUNT(t.id) records
      FROM users u LEFT JOIN trainings t ON t.user_id = u.id WHERE u.tenant_id = ? AND u.active = 1 GROUP BY u.id ORDER BY hours_x100 DESC, u.name`).all(`${y}-%`, actor.tenantId),
    expiring: db.prepare('SELECT t.title, t.expires_on, u.name FROM trainings t JOIN users u ON u.id = t.user_id WHERE t.tenant_id = ? AND t.expires_on IS NOT NULL AND t.expires_on <= ? ORDER BY t.expires_on').all(actor.tenantId, in90) };
}
/** Daily: certificate expiry reminders to the holder (60 days before, once a month). */
export function remindExpiringCertificates(db, tenantId, notify) {
  const limit = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10); const month = new Date().toISOString().slice(0, 7);
  for (const t of db.prepare('SELECT * FROM trainings WHERE tenant_id = ? AND expires_on IS NOT NULL AND expires_on <= ?').all(tenantId, limit))
    notify(db, { tenantId, to: t.user_id, event: 'certificate.expiry', key: `${t.id}:${month}`, link: '#/profile', subject: `Renew soon: ${t.title}`, text: `Your ${t.title} ${t.expires_on < new Date().toISOString().slice(0, 10) ? 'expired' : 'expires'} on ${t.expires_on}. Upload the renewed certificate on My profile → Training.` });
}
