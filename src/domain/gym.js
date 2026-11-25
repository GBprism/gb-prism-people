// Gym allowance (GB policy): an employee is eligible once they attach their gym registration or
// membership document showing the gym and the period. People Ops / GB's approver checks it; the
// allowance then applies for the registration period, and the profile shows the eligibility.
import { uid, now, audit, bad, forbid, notFound } from '../db.js';
import { isOps, has } from './authz.js';
import { storeFile, fileResponse } from './files.js';
import { updateProfile } from './profiles.js';

const settingOf = (db, t, k) => { const r = db.prepare('SELECT value_json FROM settings WHERE tenant_id = ? AND key = ?').get(t, k); return r ? JSON.parse(r.value_json) : null; };
const approver = (db, actor) => isOps(actor) || has(actor, 'partner') || settingOf(db, actor.tenantId, 'leave_approver') === actor.id;
const iso = (v, l) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) throw bad(`${l}: use yyyy-mm-dd`); return v; };

export function submitGym(db, actor, { gym_name, valid_from, valid_to }, buffer, filename) {
  const name = String(gym_name || '').trim().slice(0, 120); if (!name) throw bad('Which gym?');
  const from = iso(valid_from, 'From'); const to = iso(valid_to, 'To');
  if (to < from) throw bad('The end date is before the start date');
  if (!buffer?.length) throw bad('Attach your gym registration or membership document');
  const fileId = storeFile(db, actor, { purpose: 'gym_registration', filename, buffer });
  const id = uid('gym_');
  db.prepare('INSERT INTO gym_claims (id, tenant_id, user_id, gym_name, valid_from, valid_to, file_id, created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, actor.tenantId, actor.id, name, from, to, fileId, now());
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'gym.submit', entity: 'gym_claim', entityId: id });
  return db.prepare('SELECT * FROM gym_claims WHERE id = ?').get(id);
}

export function gymView(db, actor) {
  const sql = 'SELECT g.*, u.name FROM gym_claims g JOIN users u ON u.id = g.user_id WHERE g.tenant_id = ?';
  const today = new Date().toISOString().slice(0, 10);
  const mine = db.prepare(`${sql} AND g.user_id = ? ORDER BY g.valid_to DESC`).all(actor.tenantId, actor.id);
  const current = mine.find((g) => g.status === 'approved' && g.valid_from <= today && g.valid_to >= today) || null;
  return { mine, current, canApprove: approver(db, actor),
    queue: approver(db, actor) ? db.prepare(`${sql} ORDER BY g.status = 'submitted' DESC, g.created_at DESC LIMIT 200`).all(actor.tenantId) : [] };
}

export function decideGym(db, actor, id, { decision, note } = {}) {
  if (!approver(db, actor)) throw forbid();
  const g = db.prepare('SELECT * FROM gym_claims WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!g) throw notFound();
  if (g.user_id === actor.id) throw forbid('Someone else approves your own gym allowance');
  if (g.status !== 'submitted') throw bad('Already decided');
  if (!['approve', 'reject'].includes(decision)) throw bad('Approve or reject');
  if (decision === 'reject' && !String(note || '').trim()) throw bad('Say why');
  const status = decision === 'approve' ? 'approved' : 'rejected';
  db.prepare('UPDATE gym_claims SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?').run(status, actor.id, now(), String(note || '').trim() || null, id);
  if (status === 'approved' && (isOps(actor) || has(actor, 'partner'))) updateProfile(db, actor, g.user_id, { gym_stipend_status: `Eligible — registration at ${g.gym_name} on file (${g.valid_from} to ${g.valid_to})` }, { source: 'Gym registration approved in the portal' });
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: `gym.${status}`, entity: 'gym_claim', entityId: id });
  return db.prepare('SELECT * FROM gym_claims WHERE id = ?').get(id);
}

export function gymFile(db, actor, id) {
  const g = db.prepare('SELECT * FROM gym_claims WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!g) throw notFound();
  if (g.user_id !== actor.id && !approver(db, actor)) throw forbid();
  return fileResponse(db, actor.tenantId, g.file_id);
}
