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

/** Partners / People Ops set or change a project's lead (the person who confirms the team). */
export function setProjectLead(db, actor, projectId, leadUserId) {
  if (!isOps(actor) && !has(actor, 'partner')) throw forbid();
  assertTenantProject(db, actor, projectId); assertTenantUsers(db, actor, leadUserId);
  if (!leadUserId) throw bad('Choose a lead');
  const before = db.prepare('SELECT lead_user_id FROM projects WHERE id = ?').get(projectId).lead_user_id;
  db.prepare('UPDATE projects SET lead_user_id = ? WHERE id = ?').run(leadUserId, projectId);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'project.lead', entity: 'project', entityId: projectId, before: { leadUserId: before }, after: { leadUserId } });
  return { ok: true };
}

/** GB's five service lines (company profile, Jan 2026). */
export const SERVICE_LINES = ['Strategic Planning and Growth', 'Business Process Re-engineering', 'HR Transformation', 'Operating Model and Governance', 'AI Readiness and Strategy'];
export function setServiceLine(db, actor, projectId, line) {
  if (!isOps(actor) && !has(actor, 'partner') && !isLead(db, actor, projectId)) throw forbid();
  assertTenantProject(db, actor, projectId);
  if (line && !SERVICE_LINES.includes(line)) throw bad('Unknown service line');
  db.prepare('UPDATE projects SET service_line = ? WHERE id = ?').run(line || null, projectId);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'project.service_line', entity: 'project', entityId: projectId, after: { line } });
  return { ok: true };
}

/** Google Chat space and Google Meet link for a project (lead, partners, People Ops). */
export function setProjectLinks(db, actor, projectId, { chatUrl, meetUrl } = {}) {
  assertTenantProject(db, actor, projectId);
  if (!isOps(actor) && !has(actor, 'partner') && !isLead(db, actor, projectId)) throw forbid();
  const ok = (u, re, what) => { const s = String(u || '').trim(); if (s && !re.test(s)) throw bad(`Use a ${what} link`); return s || null; };
  const chat = ok(chatUrl, /^https:\/\/(chat\.google\.com|mail\.google\.com\/chat)\//, 'Google Chat (https://chat.google.com/…)');
  const meet = ok(meetUrl, /^https:\/\/meet\.google\.com\/[a-z0-9-]+$/, 'Google Meet (https://meet.google.com/abc-defg-hij)');
  db.prepare('UPDATE projects SET chat_url = ?, meet_url = ? WHERE id = ?').run(chat, meet, projectId);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'project.links', entity: 'project', entityId: projectId, after: { chat: !!chat, meet: !!meet } });
  return { ok: true };
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
    const lead = isLead(db, actor, a.project_id);
    const ownAsLead = a.user_id === db.prepare('SELECT lead_user_id FROM projects WHERE id = ?').get(a.project_id)?.lead_user_id;
    // the lead confirms the team; the lead's own assignment is confirmed by a partner or People Ops
    if (a.user_id === actor.id) throw forbid('You cannot confirm your own assignment');
    if (!lead && !(ownAsLead && (isOps(actor) || has(actor, 'partner')))) throw forbid('Only the project lead confirms assignments');
    if (decision === 'reject') {
      if (['confirmed', 'historical'].includes(a.status)) throw conflict('Confirmed work cannot be removed here');
      if (db.prepare('SELECT 1 FROM feedback_invites WHERE assignment_id = ? UNION SELECT 1 FROM project_feedback WHERE assignment_id = ?').get(assignmentId, assignmentId)) throw conflict('Feedback already refers to this assignment');
      if (!String(note || '').trim()) throw bad('Say briefly why this person was not on the project');
      const rid = uid('arm_');
      db.prepare('INSERT INTO assignment_removals (id, tenant_id, project_id, assignment_json, reason, removed_by, removed_at) VALUES (?,?,?,?,?,?,?)')
        .run(rid, actor.tenantId, a.project_id, JSON.stringify(a), String(note).trim(), actor.id, now());
      audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'assignment.reject', entity: 'project_assignment', entityId: assignmentId, reason: note, before: a, after: { removal: rid } });
      db.prepare('DELETE FROM project_assignments WHERE id = ?').run(assignmentId);
      return { removed: rid };
    }
    db.prepare("UPDATE project_assignments SET status = 'confirmed', role = COALESCE(?, role), start_date = COALESCE(?, start_date), end_date = COALESCE(?, end_date), confirmed_by = ?, confirmed_at = ? WHERE id = ?")
      .run(role ?? null, startDate ?? null, endDate ?? null, actor.id, now(), assignmentId);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: `assignment.${decision}`, entity: 'project_assignment', entityId: assignmentId, reason: note, before: { status: a.status } });
    return db.prepare('SELECT * FROM project_assignments WHERE id = ?').get(assignmentId);
  });
}

/** Put back an assignment removed by mistake, exactly as it was (same id and status). */
export function restoreAssignment(db, actor, removalId) {
  return tx(db, () => {
    const r = db.prepare('SELECT * FROM assignment_removals WHERE id = ? AND tenant_id = ?').get(removalId, actor.tenantId);
    if (!r) throw notFound();
    if (r.restored_at) throw conflict('Already restored');
    if (!isLead(db, actor, r.project_id) && !isOps(actor) && !has(actor, 'partner')) throw forbid('Only the project lead, a partner or People Ops can restore');
    const a = JSON.parse(r.assignment_json);
    db.prepare(`INSERT INTO project_assignments (id, tenant_id, project_id, user_id, role, status, start_date, end_date, source, confirmed_by, confirmed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(a.id, a.tenant_id, a.project_id, a.user_id, a.role, a.status, a.start_date, a.end_date, a.source, a.confirmed_by, a.confirmed_at);
    db.prepare('UPDATE assignment_removals SET restored_by = ?, restored_at = ? WHERE id = ?').run(actor.id, now(), removalId);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'assignment.restore', entity: 'project_assignment', entityId: a.id, after: { removal: removalId } });
    return a;
  });
}

export function addDeliverable(db, actor, { projectId, title, workstream, version, milestone, dueDate, driveUrl, qaReviewerId }) {
  assertTenantProject(db, actor, projectId); assertTenantUsers(db, actor, qaReviewerId);
  const onTeam = db.prepare("SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ? AND status IN ('confirmed','tentative','historical','provisional')").get(projectId, actor.id);
  if (!isOps(actor) && !isLead(db, actor, projectId) && !onTeam) throw forbid();
  if (!title) throw bad('Title required');
  if (driveUrl && !/^https:\/\/(drive|docs)\.google\.com\//.test(driveUrl)) throw bad('Use the Google Drive link of the deliverable');
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
        team_unconfirmed: asg.filter((a) => a.status === 'provisional' || a.status === 'tentative'), deliverables: dels,
        removed: (ops || has(actor, 'partner') || p.lead_user_id === actor.id) ? db.prepare(`SELECT r.id, r.reason, r.removed_at, r.assignment_json, u.name removed_by FROM assignment_removals r
            LEFT JOIN users u ON u.id = r.removed_by WHERE r.project_id = ? AND r.restored_at IS NULL ORDER BY r.removed_at DESC`).all(p.id)
          .map((r) => { const a = JSON.parse(r.assignment_json); return { id: r.id, reason: r.reason, removed_at: r.removed_at, removed_by: r.removed_by, role: a.role,
            name: db.prepare('SELECT name FROM users WHERE id = ?').get(a.user_id)?.name }; }) : [] };
    });
}

/** Running engagements for everyone: dates, client and scope (from the library), lead, team, Drive and chat links. */
export function activeProjects(db, actor) {
  const rows = db.prepare(`SELECT p.id, p.name, p.client, p.start_date, p.end_date, p.service_line, p.drive_url, p.chat_url, p.meet_url, u.name lead_name, p.lead_user_id,
      e.title_en, e.scope_en, e.scope_ar, e.drive_url lib_drive, c.name_en client_name, c.country, c.sector
    FROM projects p LEFT JOIN users u ON u.id = p.lead_user_id
    LEFT JOIN engagements e ON e.project_id = p.id AND e.tenant_id = p.tenant_id
    LEFT JOIN clients c ON c.id = e.client_id
    WHERE p.tenant_id = ? AND p.kind = 'engagement' AND p.status = 'active' AND p.register_status != 'archived'
    ORDER BY COALESCE(p.start_date, '9999') DESC, p.name`).all(actor.tenantId);
  const seen = new Set();
  return rows.filter((r) => !seen.has(r.id) && seen.add(r.id)).map((r) => ({ ...r, drive_url: r.drive_url || r.lib_drive, lib_drive: undefined,
    team: db.prepare(`SELECT u.id, u.name, a.role, a.status FROM project_assignments a JOIN users u ON u.id = a.user_id WHERE a.project_id = ? AND a.status IN ('confirmed','tentative','historical','provisional')
        AND (a.end_date IS NULL OR a.end_date >= date('now')) ORDER BY a.status = 'confirmed' DESC, u.name`).all(r.id)
      .filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i),
    mine: r.lead_user_id === actor.id || !!db.prepare('SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ?').get(r.id, actor.id) }));
}
