// Server-side, record-level authorization. Every API handler and background
// job goes through these functions; the UI hides things for convenience only.
//
// Scopes:
//   employee     – own records
//   manager      – plans where plan.reviewer_id = me; leave where I'm approver/backup
//   project lead – feedback only on invited assignments for projects I lead
//   partner      – plans where plan.partner_id = me, from calibration onwards
//   people_ops   – roster, balances, imports. NO review content unless an
//                  explicit access_grant('reviews', cycle) exists.
//   admin        – workspace settings. Same rule as people_ops for reviews.
import { forbid } from '../db.js';

export function loadActor(db, userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
  if (!u) return null;
  const roles = new Set(db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(userId).map((r) => r.role));
  roles.add('employee');
  return { id: u.id, tenantId: u.tenant_id, email: u.email, name: u.name, roles };
}

export const has = (actor, role) => actor.roles.has(role);
export const isOps = (a) => has(a, 'people_ops') || has(a, 'admin');

export function requireRole(actor, ...roles) {
  if (!roles.some((r) => has(actor, r))) throw forbid();
}

/** Throws unless every given user id belongs to the actor's workspace. */
export function assertTenantUsers(db, actor, ...ids) {
  for (const id of ids.filter(Boolean)) {
    const u = db.prepare('SELECT tenant_id FROM users WHERE id = ?').get(id);
    if (!u || u.tenant_id !== actor.tenantId) throw forbid('Unknown person in this workspace');
  }
}
export function assertTenantProject(db, actor, projectId) {
  const p = db.prepare('SELECT tenant_id FROM projects WHERE id = ?').get(projectId);
  if (!p || p.tenant_id !== actor.tenantId) throw forbid('Unknown project in this workspace');
}

export function sameTenant(actor, row) {
  if (!row || row.tenant_id !== actor.tenantId) throw forbid('Not found in this workspace');
}

function grant(db, actor, scope, objectId) {
  return !!db.prepare(`SELECT 1 FROM access_grants WHERE tenant_id = ? AND user_id = ? AND scope = ?
                       AND (object_id IS NULL OR object_id = ?)`).get(actor.tenantId, actor.id, scope, objectId ?? null);
}

const PARTNER_STATES = new Set(['partner_calibration', 'released', 'acknowledged', 'closed']);
const EMPLOYEE_OUTCOME_STATES = new Set(['released', 'acknowledged', 'closed']);

/**
 * What the actor may see on a plan. Returns a capability object or null.
 *  relation: 'self' | 'reviewer' | 'partner' | 'granted' | 'project_lead'
 */
export function planAccess(db, actor, plan) {
  if (!plan || plan.tenant_id !== actor.tenantId) return null;
  const caps = { relation: null, viewPlan: false, viewSelf: false, viewManager: false, viewCalibration: false,
    viewOutcome: false, viewProjectFeedback: false, editSelf: false, editManager: false, calibrate: false, giveFeedback: [] };
  if (plan.user_id === actor.id) {
    Object.assign(caps, { relation: 'self', viewPlan: true, viewSelf: true,
      editSelf: ['approved_plan', 'self_assessment'].includes(plan.state) || plan.state === 'draft_plan',
      viewOutcome: EMPLOYEE_OUTCOME_STATES.has(plan.state),
      viewManager: EMPLOYEE_OUTCOME_STATES.has(plan.state) });
    return caps;
  }
  if (plan.reviewer_id === actor.id) {
    Object.assign(caps, { relation: 'reviewer', viewPlan: true, viewManager: true, viewProjectFeedback: true,
      // manager sees the self-assessment once submitted (or plan returned)
      viewSelf: !['draft_plan', 'approved_plan', 'self_assessment'].includes(plan.state) || !!plan.self_submitted_at,
      editManager: plan.state === 'manager_review', viewOutcome: true, viewCalibration: PARTNER_STATES.has(plan.state) });
    return caps;
  }
  if (plan.partner_id === actor.id && has(actor, 'partner') && PARTNER_STATES.has(plan.state)) {
    Object.assign(caps, { relation: 'partner', viewPlan: true, viewSelf: true, viewManager: true, viewProjectFeedback: true,
      viewCalibration: true, viewOutcome: true, calibrate: plan.state === 'partner_calibration' });
    return caps;
  }
  if (grant(db, actor, 'reviews', plan.cycle_id)) {
    Object.assign(caps, { relation: 'granted', viewPlan: true, viewSelf: true, viewManager: true, viewOutcome: true, viewCalibration: true });
    return caps;
  }
  // project lead: only the invited assignment(s); no plan body, ratings or other feedback
  const invites = db.prepare(`SELECT fi.assignment_id FROM feedback_invites fi
      JOIN project_assignments pa ON pa.id = fi.assignment_id JOIN projects p ON p.id = pa.project_id
      WHERE fi.plan_id = ? AND fi.invitee_id = ? AND p.lead_user_id = ?`).all(plan.id, actor.id, actor.id);
  if (invites.length && !['released', 'acknowledged', 'closed'].includes(plan.state)) {
    caps.relation = 'project_lead';
    caps.giveFeedback = invites.map((i) => i.assignment_id);
    return caps;
  }
  return null;
}

export function assertPlan(db, actor, plan, cap) {
  const c = planAccess(db, actor, plan);
  if (!c || (cap && !c[cap])) throw forbid();
  return c;
}

/** Leave request visibility. Reasons/attachments only to owner + approvers + ops. */
export function leaveAccess(db, actor, req) {
  if (!req || req.tenant_id !== actor.tenantId) return null;
  if (req.user_id === actor.id) return { relation: 'self', viewReason: true, viewBalance: true, decide: false };
  const approver = req.approver_id === actor.id || req.backup_approver_id === actor.id;
  if (approver) return { relation: 'approver', viewReason: true, viewBalance: true, decide: req.state === 'submitted' };
  if (isOps(actor)) return { relation: 'ops', viewReason: true, viewBalance: true, decide: false };
  return null;
}

export function canViewBalances(db, actor, userId) {
  if (userId === actor.id) return true;
  const target = db.prepare('SELECT tenant_id FROM users WHERE id = ?').get(userId);
  if (!target || target.tenant_id !== actor.tenantId) return false; // never across workspaces
  if (isOps(actor)) return true;
  const emp = currentEmployment(db, userId);
  return !!emp && (emp.manager_id === actor.id || emp.backup_approver_id === actor.id);
}

export function currentEmployment(db, userId, onDate = new Date().toISOString().slice(0, 10)) {
  return db.prepare(`SELECT * FROM employments WHERE user_id = ? AND effective_from <= ?
                     AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC LIMIT 1`).get(userId, onDate, onDate);
}

/** AI evidence is private: owner, their reviewer (for linked items), granted ops only. */
export function aiExampleAccess(db, actor, ex) {
  if (!ex || ex.tenant_id !== actor.tenantId) return false;
  if (ex.user_id === actor.id) return true;
  if (ex.status !== 'approved') return false;
  const plan = ex.linked_plan_item_id && db.prepare('SELECT p.* FROM plan_items i JOIN plans p ON p.id = i.plan_id WHERE i.id = ?').get(ex.linked_plan_item_id);
  if (plan && (plan.reviewer_id === actor.id || (plan.partner_id === actor.id && PARTNER_STATES.has(plan.state)))) return true;
  return grant(db, actor, 'ai_evidence', null);
}
