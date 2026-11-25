// HR profiles. Visible to the person, People Ops/admin and partners only —
// never to managers, peers or project leads (they hold insurance and date of birth).
import crypto from 'node:crypto';
import { tx, now, audit, bad, forbid, notFound } from '../db.js';
import { isOps, has, currentEmployment } from './authz.js';
import { todayIn } from './dates.js';

export const PROFILE_FIELDS = ['level', 'date_of_birth', 'age_recorded', 'age_recorded_on', 'probation_status', 'contract_status', 'social_security_status', 'medical_insurance_status', 'gym_stipend_status', 'projects_summary', 'proposals_summary', 'gaps', 'leave_history', 'equipment', 'learning_notes',
  ...['public_title', 'years_experience', 'expertise', 'education', 'certifications', 'bio', 'industries', 'functions', 'cv_projects', 'languages', 'linkedin']];
/** Facts from the company profile: shown to every colleague (they are already public to clients). */
export const PUBLIC_FIELDS = ['public_title', 'years_experience', 'expertise', 'education', 'certifications', 'bio', 'industries', 'functions', 'cv_projects', 'languages', 'linkedin'];
const canSee = (actor, userId) => actor.id === userId || isOps(actor) || has(actor, 'partner');
const canEdit = (actor) => isOps(actor) || has(actor, 'partner');

function years(from, to) {
  if (!from) return null;
  const a = new Date(`${from}T00:00:00Z`); const b = new Date(`${to}T00:00:00Z`);
  return Math.round(((b - a) / (365.25 * 864e5)) * 10) / 10;
}
function age(dob, on) {
  if (!dob) return null;
  const [y, m, d] = dob.split('-').map(Number); const [Y, M, D] = on.split('-').map(Number);
  return Y - y - (M < m || (M === m && D < d) ? 1 : 0);
}

export function getProfile(db, actor, userId) {
  const u = db.prepare('SELECT id, tenant_id, name, email, active FROM users WHERE id = ?').get(userId);
  if (!u || u.tenant_id !== actor.tenantId) throw notFound();
  if (!canSee(actor, userId)) throw forbid();
  const p = db.prepare('SELECT * FROM employee_profiles WHERE user_id = ?').get(userId) || {};
  const emp = currentEmployment(db, userId);
  const today = todayIn();
  const assignments = db.prepare(`SELECT pa.role, pa.status, pa.start_date, pa.end_date, pa.source, pr.name project, pr.kind, pr.id project_id, l.name lead
      FROM project_assignments pa JOIN projects pr ON pr.id = pa.project_id LEFT JOIN users l ON l.id = pr.lead_user_id
      WHERE pa.user_id = ? ORDER BY pr.kind, pa.start_date`).all(userId);
  return {
    user: { id: u.id, name: u.name, email: u.email, active: !!u.active },
    title: emp?.title ?? null, manager: emp?.manager_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(emp.manager_id)?.name : null,
    hire_date: emp?.hire_date ?? null, years_with_gb: years(emp?.hire_date, today), probation_end: emp?.probation_end ?? null,
    age: p.date_of_birth ? age(p.date_of_birth, today) : null, ...Object.fromEntries(PROFILE_FIELDS.map((f) => [f, p[f] ?? null])),
    gaps_list: (p.gaps || '').split(/;\s*/).map((x) => x.trim()).filter(Boolean),
    source: p.source ?? null, updated_at: p.updated_at ?? null, photo: photoUrl(db, userId),
    assignments, can_edit: canEdit(actor),
  };
}

export function updateProfile(db, actor, userId, changes, { source } = {}) {
  if (!canEdit(actor)) throw forbid();
  const u = db.prepare('SELECT tenant_id FROM users WHERE id = ?').get(userId);
  if (!u || u.tenant_id !== actor.tenantId) throw notFound();
  const fields = Object.keys(changes).filter((k) => PROFILE_FIELDS.includes(k));
  if (!fields.length) throw bad('Nothing to update');
  for (const f of ['date_of_birth', 'age_recorded_on']) if (changes[f] && !/^\d{4}-\d{2}-\d{2}$/.test(changes[f])) throw bad(`${f.replace(/_/g, ' ')} must be yyyy-mm-dd`);
  if (changes.age_recorded != null && changes.age_recorded !== '' && !(Number.isInteger(Number(changes.age_recorded)) && Number(changes.age_recorded) >= 15 && Number(changes.age_recorded) <= 80)) throw bad('Age must be a whole number');
  return tx(db, () => {
    const before = db.prepare('SELECT * FROM employee_profiles WHERE user_id = ?').get(userId) || null;
    if (!before) db.prepare('INSERT INTO employee_profiles (user_id, tenant_id, updated_at) VALUES (?,?,?)').run(userId, u.tenant_id, now());
    for (const f of fields) db.prepare(`UPDATE employee_profiles SET ${f} = ? WHERE user_id = ?`).run(changes[f] === '' ? null : changes[f], userId);
    db.prepare('UPDATE employee_profiles SET updated_by = ?, updated_at = ?, source = COALESCE(?, source) WHERE user_id = ?').run(actor.id, now(), source ?? null, userId);
    // audit keeps which fields changed, not the sensitive values themselves
    audit(db, { tenantId: u.tenant_id, actorId: actor.id, action: 'profile.update', entity: 'user', entityId: userId, reason: source || null, after: { fields } });
    return getProfile(db, actor, userId);
  });
}

/** Directory of HR profiles for People Ops and partners. */
export function listProfiles(db, actor) {
  if (!canEdit(actor)) throw forbid();
  const today = todayIn();
  return db.prepare(`SELECT u.id, u.name, u.email, e.title, e.hire_date, e.probation_end, m.name manager, p.level, p.probation_status, p.contract_status,
      p.social_security_status, p.medical_insurance_status, p.gym_stipend_status, p.gaps, p.updated_at,
      (SELECT COUNT(*) FROM project_assignments pa WHERE pa.user_id = u.id) assignments
    FROM users u LEFT JOIN employments e ON e.user_id = u.id AND e.effective_to IS NULL LEFT JOIN users m ON m.id = e.manager_id
    LEFT JOIN employee_profiles p ON p.user_id = u.id WHERE u.tenant_id = ? AND u.active = 1 ORDER BY u.name`).all(actor.tenantId)
    .map((r) => ({ ...r, photo: photoUrl(db, r.id), years_with_gb: years(r.hire_date, today), gaps_list: (r.gaps || '').split(/;\s*/).map((x) => x.trim()).filter(Boolean) }));
}

/** Team directory for everyone in the workspace: name, title, photo and company-profile facts only. */
export function teamDirectory(db, actor) {
  return db.prepare(`SELECT u.id, u.name, u.email, e.title, ${PUBLIC_FIELDS.map((f) => `p.${f}`).join(', ')}, ph.updated_at photo_at
      FROM users u LEFT JOIN employments e ON e.user_id = u.id AND e.effective_to IS NULL LEFT JOIN employee_profiles p ON p.user_id = u.id
      LEFT JOIN user_photos ph ON ph.user_id = u.id WHERE u.tenant_id = ? AND u.active = 1 ORDER BY u.name`).all(actor.tenantId)
    .map((r) => ({ ...r, photo: r.photo_at ? `/api/people/${r.id}/photo?v=${encodeURIComponent(r.photo_at)}` : null, photo_at: undefined }));
}

export const photoUrl = (db, userId) => { const r = db.prepare('SELECT updated_at FROM user_photos WHERE user_id = ?').get(userId); return r ? `/api/people/${userId}/photo?v=${encodeURIComponent(r.updated_at)}` : null; };

export function getPhoto(db, actor, userId) {
  const r = db.prepare('SELECT * FROM user_photos WHERE user_id = ? AND tenant_id = ?').get(userId, actor.tenantId);
  if (!r) throw notFound();
  return r;
}

const MIME = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
  : b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : null);

/** Set a photo: the person themself, People Ops or a partner. JPEG, PNG or WebP up to 1.5 MB. */
export function setPhoto(db, actor, userId, buffer, { source = 'Uploaded in GB Prism' } = {}) {
  const u = db.prepare('SELECT tenant_id FROM users WHERE id = ?').get(userId);
  if (!u || u.tenant_id !== actor.tenantId) throw notFound();
  if (actor.id !== userId && !canEdit(actor)) throw forbid();
  if (!buffer?.length) throw bad('Choose a photo');
  if (buffer.length > 1.5 * 1024 * 1024) throw bad('Photo is larger than 1.5 MB');
  const mime = MIME(buffer); if (!mime) throw bad('Use a JPEG, PNG or WebP image');
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const cur = db.prepare('SELECT sha256 FROM user_photos WHERE user_id = ?').get(userId);
  if (cur?.sha256 === sha) return { changed: false };
  db.prepare(`INSERT INTO user_photos (user_id, tenant_id, mime, data, sha256, source, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, sha256 = excluded.sha256, source = excluded.source, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(userId, u.tenant_id, mime, buffer, sha, source, actor.id, now());
  audit(db, { tenantId: u.tenant_id, actorId: actor.id, action: 'profile.photo', entity: 'user', entityId: userId, reason: source });
  return { changed: true };
}
