// Project / proposal / initiative register with deliverables and individual
// contributions. Drive ownership, last editor and handwritten allocations are
// LEADS: they land as 'provisional' assignments / 'claimed' contributions and
// only a project lead's confirmation makes them part of the confirmed record.
import { tx, uid, now, audit, bad, forbid, notFound, conflict } from '../db.js';
import { isOps, has, assertTenantUsers, assertTenantProject } from './authz.js';

const RESP = ['lead', 'author', 'analyst', 'reviewer', 'support'];

export function createProject(db, actor, p) {
  if (!isOps(actor) && !has(actor, 'partner')) throw forbid();
  if (!p.name) throw bad('Project name required');
  assertTenantUsers(db, actor, p.leadUserId);
  const id = uid('prj_');
  db.prepare(`INSERT INTO projects (id, tenant_id, code, name, client, kind, lead_user_id, status, start_date, end_date, register_status, drive_url, source_ref)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, actor.tenantId, p.code ?? null, p.name, p.client ?? null, p.kind || 'engagement', p.leadUserId ?? null,
    p.status || 'active', p.startDate ?? null, p.endDate ?? null, p.registerStatus || 'candidate', p.driveUrl ?? null, p.sourceRef ?? null);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'project.create', entity: 'project', entityId: id, after: p });
  return id;
}

export function approveProject(db, actor, projectId) {
  if (!isOps(actor) && !has(actor, 'partner')) throw forbid();
  const r = db.prepare("UPDATE projects SET register_status = 'approved' WHERE id = ? AND tenant_id = ?").run(projectId, actor.tenantId);
  if (!r.changes) throw notFound();
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'project.approve', entity: 'project', entityId: projectId });
}

export function addAssignment(db, actor, { projectId, userId, role, status = 'provisional', startDate, endDate, source }) {
  assertTenantProject(db, actor, projectId); assertTenantUsers(db, actor, userId);
  if (!isOps(actor) && !isLead(db, actor, projectId)) throw forbid();
  if (!['provisional', 'tentative', 'confirmed', 'historical'].includes(status)) throw bad('Bad status');
  // only a project lead can create a confirmed assignment directly
  if (status === 'confirmed' && !isLead(db, actor, projectId)) status = 'provisional';
  const id = uid('asg_');
  db.prepare(`INSERT INTO project_assignments (id, tenant_id, project_id, user_id, role, status, start_date, end_date, source, confirmed_by, confirmed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, actor.tenantId, projectId, userId, role || 'team member', status, startDate ?? null, endDate ?? null, source ?? null,
    status === 'confirmed' ? actor.id : null, status === 'confirmed' ? now() : null);
  return id;
}

export function confirmAssignment(db, actor, assignmentId, { decision = 'confirm', role, startDate, endDate, note } = {}) {
  return tx(db, () => {
    const a = db.prepare('SELECT * FROM project_assignments WHERE id = ? AND tenant_id = ?').get(assignmentId, actor.tenantId);
    if (!a) throw notFound();
    if (!isLead(db, actor, a.project_id)) throw forbid('Only the project lead confirms assignments');
    if (a.user_id === actor.id) throw forbid('Leads cannot confirm their own assignment');
    db.prepare('UPDATE project_assignments SET status = ?, role = COALESCE(?, role), start_date = COALESCE(?, start_date), end_date = COALESCE(?, end_date), confirmed_by = ?, confirmed_at = ? WHERE id = ?')
      .run(decision === 'reject' ? 'tentative' : 'confirmed', role ?? null, startDate ?? null, endDate ?? null, actor.id, now(), assignmentId);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: `assignment.${decision}`, entity: 'project_assignment', entityId: assignmentId, reason: note, before: { status: a.status } });
    return db.prepare('SELECT * FROM project_assignments WHERE id = ?').get(assignmentId);
  });
}

export function addDeliverable(db, actor, { projectId, title, workstream, version, milestone, dueDate, driveUrl, qaReviewerId }) {
  assertTenantProject(db, actor, projectId); assertTenantUsers(db, actor, qaReviewerId);
  if (!isOps(actor) && !isLead(db, actor, projectId)) throw forbid();
  if (!title) throw bad('Title required');
  const id = uid('dlv_');
  db.prepare(`INSERT INTO deliverables (id, tenant_id, project_id, workstream, title, version, milestone, due_date, drive_url, qa_reviewer_id) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, actor.tenantId, projectId, workstream ?? null, title, version ?? null, milestone ?? null, dueDate ?? null, driveUrl ?? null, qaReviewerId ?? null);
  return id;
}

/** Employee claims their contribution (several people may claim different roles on one deliverable). */
export function claimContribution(db, actor, { deliverableId, responsibility, description, evidenceUrl, leadSource }) {
  if (!RESP.includes(responsibility)) throw bad(`Responsibility must be one of ${RESP.join(', ')}`);
  const d = db.prepare('SELECT * FROM deliverables WHERE id = ? AND tenant_id = ?').get(deliverableId, actor.tenantId);
  if (!d) throw notFound();
  const onProject = db.prepare("SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ? AND status IN ('provisional','tentative','confirmed','historical')").get(d.project_id, actor.id);
  if (!onProject) throw forbid('You are not assigned to this project');
  const id = uid('ctb_');
  try {
    db.prepare(`INSERT INTO contributions (id, tenant_id, deliverable_id, user_id, responsibility, description, evidence_url, lead_source) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, actor.tenantId, deliverableId, actor.id, responsibility, description ?? null, evidenceUrl ?? null, leadSource ?? null);
  } catch (e) { if (/UNIQUE/.test(e.message)) throw conflict('You already claimed this role on this deliverable'); throw e; }
  return id;
}

/** One-click lead confirmation or correction. */
export function reviewContribution(db, actor, contributionId, { decision, responsibility, note }) {
  return tx(db, () => {
    const c = db.prepare('SELECT c.*, d.project_id FROM contributions c JOIN deliverables d ON d.id = c.deliverable_id WHERE c.id = ? AND c.tenant_id = ?').get(contributionId, actor.tenantId);
    if (!c) throw notFound();
    if (!isLead(db, actor, c.project_id)) throw forbid('Only the project lead validates contributions');
    if (c.user_id === actor.id) throw forbid('Leads cannot validate their own contribution');
    const status = { confirm: 'confirmed', correct: 'corrected', reject: 'rejected' }[decision];
    if (!status) throw bad('decision must be confirm, correct or reject');
    if (status === 'corrected' && !responsibility && !note) throw bad('Say what was corrected');
    db.prepare('UPDATE contributions SET status = ?, responsibility = COALESCE(?, responsibility), reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?')
      .run(status, responsibility ?? null, actor.id, now(), note ?? null, contributionId);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: `contribution.${status}`, entity: 'contribution', entityId: contributionId, reason: note, before: { status: c.status, responsibility: c.responsibility } });
    return db.prepare('SELECT * FROM contributions WHERE id = ?').get(contributionId);
  });
}

export function isLead(db, actor, projectId) {
  return !!db.prepare('SELECT 1 FROM projects WHERE id = ? AND tenant_id = ? AND lead_user_id = ?').get(projectId, actor.tenantId, actor.id);
}

/** Register view. Confirmed record only shows confirmed assignments; provisional ones are separate. */
export function registerView(db, actor, { projectId } = {}) {
  const projects = db.prepare(`SELECT p.*, u.name lead_name FROM projects p LEFT JOIN users u ON u.id = p.lead_user_id WHERE p.tenant_id = ? ${projectId ? 'AND p.id = ?' : ''} ORDER BY p.name`)
    .all(...[actor.tenantId, projectId].filter(Boolean));
  const ops = isOps(actor);
  return projects.filter((p) => ops || has(actor, 'partner') || p.lead_user_id === actor.id ||
      db.prepare('SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ?').get(p.id, actor.id))
    .map((p) => {
      const asg = db.prepare('SELECT a.*, u.name FROM project_assignments a JOIN users u ON u.id = a.user_id WHERE a.project_id = ?').all(p.id);
      const dels = db.prepare('SELECT * FROM deliverables WHERE project_id = ?').all(p.id).map((d) => ({
        ...d, contributions: db.prepare('SELECT c.id, c.user_id, u.name, c.responsibility, c.status, c.description, c.evidence_url, c.review_note FROM contributions c JOIN users u ON u.id = c.user_id WHERE c.deliverable_id = ?').all(d.id) }));
      return { ...p, is_lead: p.lead_user_id === actor.id,
        team_confirmed: asg.filter((a) => a.status === 'confirmed'), team_historical: asg.filter((a) => a.status === 'historical'),
        team_unconfirmed: asg.filter((a) => a.status === 'provisional' || a.status === 'tentative'), deliverables: dels };
    });
}
