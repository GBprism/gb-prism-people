// Employees keep their own project list up to date: join a running project, say they have left one,
// or correct their role. Each change is a request; the project lead approves (or a partner / People Ops
// when the project has no lead or the lead is the one asking). Approved changes update the assignment.
import { uid, now, audit, bad, forbid, notFound } from '../db.js';
import { isOps, has } from './authz.js';
import { todayIn } from './dates.js';
import { notify } from './mailer.js';

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const KIND = { join: 'Join', leave: 'Leave', role: 'Change role on' };
const clean = (s, n = 80) => String(s || '').trim().slice(0, n);
const deciders = (db, tenantId, exclude) => db.prepare(`SELECT DISTINCT u.id FROM users u JOIN user_roles r ON r.user_id = u.id
    WHERE u.tenant_id = ? AND u.active = 1 AND r.role IN ('partner','people_ops') AND u.id != ?`).all(tenantId, exclude || '').map((r) => r.id);

/** Who decides: the project's lead, unless there is none or it is their own request; then partners and People Ops. */
function approversFor(db, req) {
  const p = db.prepare('SELECT lead_user_id FROM projects WHERE id = ?').get(req.project_id);
  return p?.lead_user_id && p.lead_user_id !== req.user_id ? [p.lead_user_id] : deciders(db, req.tenant_id, req.user_id);
}
const canDecide = (db, actor, req) => req.user_id !== actor.id && (approversFor(db, req).includes(actor.id) || isOps(actor) || has(actor, 'partner'));

/** The editor: my open assignments, running projects I could join, my requests. */
export function myProjectsEditor(db, actor) {
  const today = todayIn();
  const mine = db.prepare(`SELECT a.id, a.project_id, a.role, a.status, a.start_date, a.end_date, p.name FROM project_assignments a JOIN projects p ON p.id = a.project_id
      WHERE a.user_id = ? AND p.kind = 'engagement' AND p.status = 'active' AND a.status != 'historical' AND (a.end_date IS NULL OR a.end_date >= ?) ORDER BY p.name`).all(actor.id, today);
  const onIds = new Set(mine.map((a) => a.project_id));
  const running = db.prepare(`SELECT p.id, p.name, u.name lead_name FROM projects p LEFT JOIN users u ON u.id = p.lead_user_id
      WHERE p.tenant_id = ? AND p.kind = 'engagement' AND p.status = 'active' AND p.register_status != 'archived' ORDER BY p.name`).all(actor.tenantId).filter((p) => !onIds.has(p.id));
  const requests = db.prepare(`SELECT r.*, p.name project, d.name decided_by_name FROM assignment_requests r JOIN projects p ON p.id = r.project_id LEFT JOIN users d ON d.id = r.decided_by
      WHERE r.user_id = ? ORDER BY r.status = 'pending' DESC, r.created_at DESC LIMIT 20`).all(actor.id);
  return { mine, running, requests };
}

/** Send one or more changes for approval. */
export function requestChanges(db, actor, { join = [], leave = [], role = [], note } = {}) {
  const T = actor.tenantId; const today = todayIn(); const created = [];
  const open = (projectId, kind) => db.prepare("SELECT 1 FROM assignment_requests WHERE user_id = ? AND project_id = ? AND kind = ? AND status = 'pending'").get(actor.id, projectId, kind);
  const ins = (r) => { const id = uid('arq_'); db.prepare(`INSERT INTO assignment_requests (id, tenant_id, user_id, project_id, assignment_id, kind, role, start_date, end_date, note, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, T, actor.id, r.project_id, r.assignment_id || null, r.kind, r.role || null, r.start_date || null, r.end_date || null, clean(note, 300) || null, now()); created.push(id); };
  for (const j of join) {
    const p = db.prepare("SELECT id, name FROM projects WHERE id = ? AND tenant_id = ? AND kind = 'engagement' AND status = 'active'").get(j.project_id, T);
    if (!p) throw bad('Choose a running project');
    if (db.prepare("SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ? AND status != 'historical' AND (end_date IS NULL OR end_date >= ?)").get(p.id, actor.id, today)) throw bad(`You are already on ${p.name}`);
    const r = clean(j.role); if (!r) throw bad(`Say what you do on ${p.name} (e.g. analyst, author)`);
    if (j.start_date && !isDate(j.start_date)) throw bad('Start date must be a date');
    if (!open(p.id, 'join')) ins({ kind: 'join', project_id: p.id, role: r, start_date: j.start_date || today });
  }
  for (const l of leave) {
    const a = db.prepare('SELECT a.*, p.name FROM project_assignments a JOIN projects p ON p.id = a.project_id WHERE a.id = ? AND a.user_id = ?').get(l.assignment_id, actor.id);
    if (!a) throw notFound();
    const end = l.end_date || today; if (!isDate(end)) throw bad('Last day must be a date');
    if (!open(a.project_id, 'leave')) ins({ kind: 'leave', project_id: a.project_id, assignment_id: a.id, end_date: end });
  }
  for (const c of role) {
    const a = db.prepare('SELECT * FROM project_assignments WHERE id = ? AND user_id = ?').get(c.assignment_id, actor.id);
    if (!a) throw notFound();
    const r = clean(c.role); if (!r || r === a.role) continue;
    if (!open(a.project_id, 'role')) ins({ kind: 'role', project_id: a.project_id, assignment_id: a.id, role: r });
  }
  if (!created.length) throw bad('Nothing to send: add a project, mark one you left, or change a role');
  for (const id of created) {
    const r = db.prepare('SELECT r.*, p.name project FROM assignment_requests r JOIN projects p ON p.id = r.project_id WHERE r.id = ?').get(id);
    notify(db, { tenantId: T, to: approversFor(db, r), event: 'project.change', key: id, link: '#/manager',
      subject: `Project change to approve: ${actor.name}`, text: `${actor.name} asked to ${describe(r).toLowerCase()}. Please approve or decline in Manager → Approvals.` });
  }
  audit(db, { tenantId: T, actorId: actor.id, action: 'project.change_requested', entity: 'user', entityId: actor.id, after: { requests: created.length } });
  return { created: created.length };
}

export function describe(r) {
  if (r.kind === 'join') return `Join ${r.project} as ${r.role}${r.start_date ? ` from ${r.start_date}` : ''}`;
  if (r.kind === 'leave') return `Leave ${r.project} (last day ${r.end_date})`;
  return `${KIND.role} ${r.project} to ${r.role}`;
}

/** Requests this person may decide, for Manager → Approvals. Partners/People Ops see those without another approver. */
export function pendingFor(db, actor) {
  return db.prepare(`SELECT r.*, p.name project, u.name person FROM assignment_requests r JOIN projects p ON p.id = r.project_id JOIN users u ON u.id = r.user_id
      WHERE r.tenant_id = ? AND r.status = 'pending' AND r.user_id != ? ORDER BY r.created_at`).all(actor.tenantId, actor.id)
    .filter((r) => approversFor(db, r).includes(actor.id)).map((r) => ({ ...r, summary: describe(r) }));
}

export function decideChange(db, actor, id, { decision, note } = {}) {
  const r = db.prepare('SELECT r.*, p.name project FROM assignment_requests r JOIN projects p ON p.id = r.project_id WHERE r.id = ? AND r.tenant_id = ?').get(id, actor.tenantId);
  if (!r) throw notFound();
  if (r.status !== 'pending') throw bad('This request was already decided');
  if (!canDecide(db, actor, r)) throw forbid();
  if (!['approve', 'decline'].includes(decision)) throw bad('Approve or decline');
  if (decision === 'decline' && !clean(note, 300)) throw bad('Say why you are declining, so they can correct it');
  if (decision === 'approve') {
    if (r.kind === 'join') db.prepare("INSERT INTO project_assignments (id, tenant_id, project_id, user_id, role, status, start_date, source, confirmed_by, confirmed_at) VALUES (?,?,?,?,?, 'confirmed', ?, 'Employee request', ?, ?)")
      .run(uid('asg_'), r.tenant_id, r.project_id, r.user_id, r.role, r.start_date, actor.id, now());
    if (r.kind === 'leave') db.prepare('UPDATE project_assignments SET end_date = ? WHERE id = ?').run(r.end_date, r.assignment_id);
    if (r.kind === 'role') db.prepare('UPDATE project_assignments SET role = ? WHERE id = ?').run(r.role, r.assignment_id);
  }
  db.prepare('UPDATE assignment_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(decision === 'approve' ? 'approved' : 'declined', actor.id, now(), clean(note, 300) || null, id);
  notify(db, { tenantId: r.tenant_id, to: r.user_id, event: `project.change.${decision}`, key: id, link: '#/active',
    subject: `Your project change was ${decision === 'approve' ? 'approved' : 'declined'}`, text: `${describe(r)}: ${decision === 'approve' ? 'approved' : 'declined'} by ${actor.name}.${note ? ` Note: ${note}` : ''}` });
  audit(db, { tenantId: r.tenant_id, actorId: actor.id, action: `project.change_${decision}`, entity: 'assignment_request', entityId: id, after: { kind: r.kind, project: r.project_id } });
  return { ok: true };
}

export function withdrawChange(db, actor, id) {
  const r = db.prepare("SELECT * FROM assignment_requests WHERE id = ? AND user_id = ? AND status = 'pending'").get(id, actor.id);
  if (!r) throw notFound();
  db.prepare("UPDATE assignment_requests SET status = 'withdrawn', decided_at = ? WHERE id = ?").run(now(), id);
  return { ok: true };
}
