// Performance cycle workflow:
//   draft_plan → approved_plan → self_assessment → manager_review →
//   partner_calibration → released → acknowledged → closed
// with returns (reason required) and an auditable reopen. Transitions are
// guarded here on the server and use optimistic row_version checks so two
// concurrent actions cannot both succeed.
import { tx, uid, now, J, P, audit, bad, conflict, forbid, notFound } from '../db.js';
import { assertPlan, planAccess, has, isOps, assertTenantUsers } from './authz.js';
import { computeScore, validateWeights, DEFAULT_SCORING, validRating } from './scoring.js';
import { planItemLinks } from './library.js';

export const STATES = ['draft_plan', 'approved_plan', 'self_assessment', 'manager_review', 'partner_calibration', 'released', 'acknowledged', 'closed'];
export const STATE_LABEL = {
  draft_plan: 'Plan in draft', approved_plan: 'Plan approved', self_assessment: 'Self-assessment',
  manager_review: 'Manager review', partner_calibration: 'Partner calibration', released: 'Result released',
  acknowledged: 'Acknowledged', closed: 'Closed',
};

export function getPlan(db, id) {
  const p = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!p) throw notFound('Plan not found');
  return p;
}
const items = (db, planId) => db.prepare('SELECT * FROM plan_items WHERE plan_id = ? ORDER BY category, position').all(planId);
const cycleCfg = (db, cycleId) => {
  const c = db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId);
  return { cycle: c, cfg: { ...DEFAULT_SCORING, ...P(c.scoring_json, {}) } };
};

function move(db, actor, plan, to, { reason, set = {} } = {}) {
  const cols = Object.keys(set);
  const sql = `UPDATE plans SET state = ?, row_version = row_version + 1${cols.map((c) => `, ${c} = ?`).join('')}
               WHERE id = ? AND state = ? AND row_version = ?`;
  const r = db.prepare(sql).run(to, ...cols.map((c) => set[c]), plan.id, plan.state, plan.row_version);
  if (r.changes !== 1) throw conflict('This review changed in the meantime. Reload and try again.');
  db.prepare('INSERT INTO plan_transitions (plan_id, from_state, to_state, actor_id, reason, at) VALUES (?,?,?,?,?,?)')
    .run(plan.id, plan.state, to, actor.id, reason ?? null, now());
  audit(db, { tenantId: plan.tenant_id, actorId: actor.id, action: `plan.${to}`, entity: 'plan', entityId: plan.id, reason, before: { state: plan.state }, after: { state: to, ...set } });
  return getPlan(db, plan.id);
}

function snapshot(db, actor, plan, kind, note) {
  const rev = (db.prepare('SELECT MAX(revision) m FROM plan_revisions WHERE plan_id = ?').get(plan.id).m || 0) + 1;
  db.prepare('INSERT INTO plan_revisions (id, plan_id, revision, kind, snapshot_json, approved_by, approved_at, note) VALUES (?,?,?,?,?,?,?,?)')
    .run(uid('rev_'), plan.id, rev, kind, J({ plan: { ...plan }, items: items(db, plan.id) }), actor.id, now(), note ?? null);
  return rev;
}

function expectState(plan, ...states) {
  if (!states.includes(plan.state)) throw conflict(`Not allowed while the review is "${STATE_LABEL[plan.state]}"`);
}

// ---------------------------------------------------------------- plans ----
export function createPlan(db, actor, { cycleId, userId, reviewerId, partnerId, templateId, roleTitle, carryItemIds = [], carryActionIds = [], sourceRef }) {
  return tx(db, () => {
    const cycle = db.prepare('SELECT * FROM cycles WHERE id = ? AND tenant_id = ?').get(cycleId, actor.tenantId);
    if (!cycle) throw notFound('Cycle not found');
    const self = userId === actor.id;
    if (!self && !isOps(actor)) throw forbid('Only the employee or People Ops can start a plan');
    assertTenantUsers(db, actor, userId, reviewerId, partnerId);
    if (db.prepare('SELECT 1 FROM plans WHERE cycle_id = ? AND user_id = ?').get(cycleId, userId)) throw conflict('A plan already exists for this cycle');
    const tpl = templateId ? db.prepare('SELECT * FROM role_templates WHERE id = ? AND tenant_id = ?').get(templateId, actor.tenantId) : null;
    if (templateId && !tpl) throw notFound('Template not found');
    const id = uid('plan_');
    db.prepare(`INSERT INTO plans (id, tenant_id, cycle_id, user_id, reviewer_id, partner_id, template_id, role_title, category_weights_json, rubric_version, source_ref, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, actor.tenantId, cycleId, userId, reviewerId ?? null, partnerId ?? null,
      tpl?.id ?? null, roleTitle ?? null, tpl ? tpl.category_weights_json : '{}', tpl ? `${tpl.role_family}@v${tpl.version}` : null, sourceRef ?? null, now());
    let pos = 0;
    for (const s of tpl ? P(tpl.starter_items_json, []) : []) {
      insertItem(db, actor.tenantId, id, { ...s, position: pos++ });
    }
    // carry forward only deliberately selected items; targets and weights must be set afresh
    for (const itemId of carryItemIds) {
      const src = db.prepare('SELECT i.*, p.user_id owner FROM plan_items i JOIN plans p ON p.id = i.plan_id WHERE i.id = ?').get(itemId);
      if (!src || src.owner !== userId || src.tenant_id !== actor.tenantId) throw bad('Carry-forward item must come from the employee\'s own earlier plan');
      insertItem(db, actor.tenantId, id, { category: src.category, title: src.title, description: src.description, kpi: src.kpi,
        expected_proficiency: src.expected_proficiency, anchors: P(src.anchors_json), target: null, weight: null, carried_from_item_id: src.id, position: pos++ });
    }
    for (const aId of carryActionIds) {
      const a = db.prepare('SELECT * FROM development_actions WHERE id = ? AND user_id = ?').get(aId, userId);
      if (!a) throw bad('Development action not found for this employee');
      db.prepare('UPDATE development_actions SET carried_to_plan_id = ? WHERE id = ?').run(id, aId);
      insertItem(db, actor.tenantId, id, { category: 'competency', title: a.title, description: `Carried from development action (${a.kind})`, target: null, weight: null, position: pos++ });
    }
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'plan.create', entity: 'plan', entityId: id, after: { cycleId, userId, templateId, carryItemIds, carryActionIds } });
    return getPlan(db, id);
  });
}

export function insertItem(db, tenantId, planId, it) {
  const id = it.id || uid('item_');
  db.prepare(`INSERT INTO plan_items (id, tenant_id, plan_id, category, position, title, description, kpi, target, weight, expected_proficiency, anchors_json, carried_from_item_id, evidence_required, actual, source_rating_raw, source_ref)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, tenantId, planId, it.category, it.position ?? 0, it.title, it.description ?? null,
    it.kpi ?? null, it.target ?? null, it.weight ?? null, it.expected_proficiency ?? null, it.anchors ? J(it.anchors) : null,
    it.carried_from_item_id ?? null, it.evidence_required === false ? 0 : 1, it.actual ?? null, it.source_rating_raw ?? null, it.source_ref ?? null);
  return id;
}

/** Draft edits (employee or reviewer) — weights, targets, items. */
export function editDraft(db, actor, planId, { categoryWeights, upsertItems = [], removeItemIds = [] }) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'viewPlan');
    if (!['self', 'reviewer'].includes(c.relation)) throw forbid();
    expectState(plan, 'draft_plan');
    if (categoryWeights) db.prepare('UPDATE plans SET category_weights_json = ?, row_version = row_version + 1 WHERE id = ?').run(J(categoryWeights), planId);
    for (const it of upsertItems) {
      if (it.id) {
        const ex = db.prepare('SELECT * FROM plan_items WHERE id = ? AND plan_id = ?').get(it.id, planId);
        if (!ex) throw notFound('Item not found');
        db.prepare('UPDATE plan_items SET title = ?, description = ?, kpi = ?, target = ?, weight = ?, category = ?, expected_proficiency = ? WHERE id = ?')
          .run(it.title ?? ex.title, it.description ?? ex.description, it.kpi ?? ex.kpi, it.target ?? ex.target,
            it.weight ?? ex.weight, it.category ?? ex.category, it.expected_proficiency ?? ex.expected_proficiency, it.id);
      } else {
        if (!it.title || !it.category) throw bad('Item needs a title and category');
        insertItem(db, actor.tenantId, planId, it);
      }
    }
    for (const rid of removeItemIds) db.prepare('DELETE FROM plan_items WHERE id = ? AND plan_id = ?').run(rid, planId);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'plan.edit_draft', entity: 'plan', entityId: planId, after: { categoryWeights, upserts: upsertItems.length, removed: removeItemIds.length } });
    return getPlan(db, planId);
  });
}

export function approvePlan(db, actor, planId, { note } = {}) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'viewPlan');
    if (c.relation !== 'reviewer') throw forbid('Only the assigned line manager approves the plan');
    expectState(plan, 'draft_plan');
    const its = items(db, planId);
    const errs = validateWeights(P(plan.category_weights_json, {}), its);
    const noTarget = its.filter((i) => i.category === 'objective' && !String(i.target ?? '').trim());
    if (noTarget.length) errs.push({ code: 'target_missing', message: `${noTarget.length} objective(s) have no target` });
    if (errs.length) throw bad('Plan cannot be approved yet', errs);
    const rev = snapshot(db, actor, plan, 'approval', note);
    return move(db, actor, plan, 'approved_plan', { reason: note, set: { approved_revision: rev, basis_status: 'verified' } });
  });
}

/** Approved amendment during an ongoing cycle: earlier revision is preserved. */
export function amendPlan(db, actor, planId, { reason, categoryWeights, upsertItems = [], removeItemIds = [] }) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'viewPlan');
    if (c.relation !== 'reviewer') throw forbid();
    expectState(plan, 'approved_plan', 'self_assessment');
    if (!reason) throw bad('An amendment needs a reason');
    if (categoryWeights) db.prepare('UPDATE plans SET category_weights_json = ? WHERE id = ?').run(J(categoryWeights), planId);
    for (const it of upsertItems) {
      if (it.id) db.prepare('UPDATE plan_items SET title = COALESCE(?, title), target = COALESCE(?, target), weight = COALESCE(?, weight), kpi = COALESCE(?, kpi) WHERE id = ? AND plan_id = ?')
        .run(it.title ?? null, it.target ?? null, it.weight ?? null, it.kpi ?? null, it.id, planId);
      else insertItem(db, actor.tenantId, planId, it);
    }
    for (const rid of removeItemIds) db.prepare('DELETE FROM plan_items WHERE id = ? AND plan_id = ?').run(rid, planId);
    const errs = validateWeights(P(getPlan(db, planId).category_weights_json, {}), items(db, planId));
    if (errs.length) throw bad('Amended plan weights are invalid', errs);
    const fresh = getPlan(db, planId);
    const rev = snapshot(db, actor, fresh, 'amendment', reason);
    db.prepare('UPDATE plans SET approved_revision = ?, row_version = row_version + 1 WHERE id = ?').run(rev, planId);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'plan.amend', entity: 'plan', entityId: planId, reason, after: { revision: rev } });
    return getPlan(db, planId);
  });
}

/** People Ops opens self-assessment for approved plans in a cycle. */
export function openSelfAssessment(db, actor, cycleId) {
  if (!isOps(actor)) throw forbid();
  return tx(db, () => {
    const rows = db.prepare("SELECT * FROM plans WHERE cycle_id = ? AND tenant_id = ? AND state = 'approved_plan'").all(cycleId, actor.tenantId);
    for (const p of rows) move(db, actor, p, 'self_assessment', { reason: 'Cycle opened' });
    db.prepare("UPDATE cycles SET status = 'open' WHERE id = ?").run(cycleId);
    return rows.length;
  });
}

/** For legacy plans that could not be verified: documented GB decision on the assessment basis. */
export function recordBasisDecision(db, actor, planId, { note }) {
  if (!isOps(actor) && !has(actor, 'partner')) throw forbid();
  if (!note) throw bad('Describe the GB decision and who made it');
  return tx(db, () => {
    const plan = getPlan(db, planId);
    if (plan.tenant_id !== actor.tenantId) throw forbid();
    db.prepare("UPDATE plans SET basis_status = 'gb_decision', basis_note = ? WHERE id = ?").run(note, planId);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'plan.basis_decision', entity: 'plan', entityId: planId, reason: note });
    return getPlan(db, planId);
  });
}

// ------------------------------------------------------- self-assessment ----
export function saveSelf(db, actor, planId, { items: edits = [], summary }) {
  return tx(db, () => {
    let plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'viewPlan');
    if (c.relation !== 'self') throw forbid();
    if (plan.state === 'approved_plan') plan = move(db, actor, plan, 'self_assessment', { reason: 'Employee started self-assessment' });
    expectState(plan, 'self_assessment');
    const { cfg } = cycleCfg(db, plan.cycle_id);
    for (const e of edits) {
      const it = db.prepare('SELECT * FROM plan_items WHERE id = ? AND plan_id = ?').get(e.id, planId);
      if (!it) throw notFound('Item not found');
      if (e.self_rating !== undefined && e.self_rating !== null && !validRating(Number(e.self_rating), cfg.scale)) throw bad(`Self-rating must be ${cfg.scale.min}–${cfg.scale.max}`);
      db.prepare('UPDATE plan_items SET actual = ?, self_rating = ?, self_rationale = ?, self_evidence_json = ? WHERE id = ?').run(
        e.actual !== undefined ? e.actual : it.actual,
        e.self_rating !== undefined ? (e.self_rating === null ? null : Number(e.self_rating)) : it.self_rating,
        e.self_rationale !== undefined ? e.self_rationale : it.self_rationale,
        e.self_evidence !== undefined ? J(e.self_evidence) : it.self_evidence_json, it.id);
      if (e.propose_na !== undefined) {
        db.prepare('UPDATE plan_items SET na = ?, na_reason = ?, na_approved_by = NULL WHERE id = ?').run(e.propose_na ? 1 : 0, e.propose_na ? (e.na_reason || null) : null, it.id);
      }
    }
    if (summary) {
      const cur = P(plan.summary_json, {});
      cur.self = { ...(cur.self || {}), ...pick(summary, ['strongest_outcomes', 'improvements', 'ai_example_id', 'proposed_goals', 'development_priorities', 'projects']) };
      db.prepare('UPDATE plans SET summary_json = ? WHERE id = ?').run(J(cur), planId);
    }
    db.prepare('UPDATE plans SET row_version = row_version + 1 WHERE id = ?').run(planId);
    return { savedAt: now(), plan: getPlan(db, planId) };
  });
}

export function submitSelf(db, actor, planId) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'viewPlan');
    if (c.relation !== 'self') throw forbid();
    expectState(plan, 'self_assessment');
    const { cfg } = cycleCfg(db, plan.cycle_id);
    const res = computeScore({ categoryWeights: P(plan.category_weights_json), items: items(db, planId), config: cfg, field: 'self_rating', requireEvidence: cfg.evidenceRequiredForSelf });
    const problems = [...res.missing.map((m) => `${m.title}: ${m.what} missing`), ...res.errors.filter((e) => e.code !== 'na_pending').map((e) => e.message)];
    for (const i of items(db, planId)) if (!i.na && !String(i.self_rationale || '').trim()) problems.push(`${i.title}: short rationale missing`);
    if (problems.length) throw bad('Please complete these before submitting', [...new Set(problems)]);
    return move(db, actor, plan, 'manager_review', { reason: 'Self-assessment submitted', set: { self_submitted_at: now() } });
  });
}

// --------------------------------------------------------- manager review ----
export function saveManager(db, actor, planId, { items: edits = [], summary }) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'editManager');
    const { cfg } = cycleCfg(db, plan.cycle_id);
    for (const e of edits) {
      const it = db.prepare('SELECT * FROM plan_items WHERE id = ? AND plan_id = ?').get(e.id, planId);
      if (!it) throw notFound('Item not found');
      if (c.editCategories && !c.editCategories.includes(it.category)) throw forbid(`Another reviewer rates the ${it.category} items`);
      if (e.manager_rating != null && !validRating(Number(e.manager_rating), cfg.scale)) throw bad(`Rating must be ${cfg.scale.min}–${cfg.scale.max}`);
      db.prepare('UPDATE plan_items SET manager_rating = ?, manager_rationale = ? WHERE id = ?').run(
        e.manager_rating !== undefined ? (e.manager_rating === null ? null : Number(e.manager_rating)) : it.manager_rating,
        e.manager_rationale !== undefined ? e.manager_rationale : it.manager_rationale, it.id);
      if (e.na !== undefined) {
        // a manager may propose N/A, or approve one the employee proposed
        if (e.na && it.na && !it.na_approved_by && it.na_reason) db.prepare('UPDATE plan_items SET na_approved_by = ? WHERE id = ?').run(actor.id, it.id);
        else db.prepare('UPDATE plan_items SET na = ?, na_reason = ?, na_approved_by = NULL WHERE id = ?').run(e.na ? 1 : 0, e.na ? e.na_reason || null : null, it.id);
      }
    }
    if (summary) {
      if (c.relation !== 'reviewer') throw forbid('The lead reviewer writes the review summary');
      const cur = P(plan.summary_json, {});
      cur.manager = { ...(cur.manager || {}), ...pick(summary, ['strengths', 'gaps', 'next_action', 'discrepancy_notes', 'evidence_checked_with']) };
      db.prepare('UPDATE plans SET summary_json = ? WHERE id = ?').run(J(cur), planId);
    }
    db.prepare('UPDATE plans SET row_version = row_version + 1 WHERE id = ?').run(planId);
    return { savedAt: now(), plan: getPlan(db, planId), relation: c.relation };
  });
}

/** Partner approves an N/A the manager proposed (no one approves their own). */
export function approveNa(db, actor, planId, itemId) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'viewPlan');
    if (!['reviewer', 'partner', 'category_reviewer'].includes(c.relation)) throw forbid();
    const it = db.prepare('SELECT * FROM plan_items WHERE id = ? AND plan_id = ? AND na = 1').get(itemId, planId);
    if (!it) throw notFound('No N/A proposal on this item');
    if (!it.na_reason) throw bad('N/A needs a reason before approval');
    db.prepare('UPDATE plan_items SET na_approved_by = ? WHERE id = ?').run(actor.id, itemId);
    audit(db, { tenantId: plan.tenant_id, actorId: actor.id, action: 'item.na_approved', entity: 'plan_item', entityId: itemId, reason: it.na_reason });
    return true;
  });
}

export function returnPlan(db, actor, planId, { reason }) {
  if (!String(reason || '').trim()) throw bad('A return needs a reason');
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'viewPlan');
    if (plan.state === 'manager_review' && c.relation === 'reviewer') return move(db, actor, plan, 'self_assessment', { reason });
    if (plan.state === 'partner_calibration' && c.relation === 'partner') return move(db, actor, plan, 'manager_review', { reason });
    throw forbid('You cannot return this review at its current stage');
  });
}

export function submitManager(db, actor, planId) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'editManager');
    if (c.relation !== 'reviewer') throw forbid('The lead reviewer submits the review once every section is rated');
    const { cfg } = cycleCfg(db, plan.cycle_id);
    const its = items(db, planId);
    const res = computeScore({ categoryWeights: P(plan.category_weights_json), items: its, config: cfg, field: 'manager_rating' });
    const problems = [...res.missing.map((m) => `${m.title}: manager ${m.what} missing`), ...res.errors.map((e) => e.message)];
    for (const i of its) if (!i.na && !String(i.manager_rationale || '').trim()) problems.push(`${i.title}: manager rationale missing`);
    if (!plan.partner_id) problems.push('No partner assigned for calibration');
    if (problems.length) throw bad('Manager review is incomplete', [...new Set(problems)]);
    return move(db, actor, plan, 'partner_calibration', { reason: 'Manager review submitted', set: { manager_submitted_at: now() } });
  });
}

// ------------------------------------------------------------ calibration ----
export function calibrateItem(db, actor, planId, itemId, { calibrated_rating, reason }) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    assertPlan(db, actor, plan, 'calibrate');
    const it = db.prepare('SELECT * FROM plan_items WHERE id = ? AND plan_id = ?').get(itemId, planId);
    if (!it) throw notFound();
    const { cfg } = cycleCfg(db, plan.cycle_id);
    if (calibrated_rating !== null && !validRating(Number(calibrated_rating), cfg.scale)) throw bad('Rating out of range');
    if (calibrated_rating !== null && Number(calibrated_rating) !== it.manager_rating && !String(reason || '').trim()) throw bad('A calibration change needs a reason');
    db.prepare('UPDATE plan_items SET calibrated_rating = ?, calibration_reason = ? WHERE id = ?').run(calibrated_rating === null ? null : Number(calibrated_rating), reason ?? null, itemId);
    audit(db, { tenantId: plan.tenant_id, actorId: actor.id, action: 'item.calibrated', entity: 'plan_item', entityId: itemId, reason,
      before: { manager_rating: it.manager_rating, calibrated_rating: it.calibrated_rating }, after: { calibrated_rating } });
    return true;
  });
}

export function release(db, actor, planId, { note } = {}) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    assertPlan(db, actor, plan, 'calibrate');
    const { cfg } = cycleCfg(db, plan.cycle_id);
    const res = computeScore({ categoryWeights: P(plan.category_weights_json), items: items(db, planId), config: cfg, field: 'final' });
    if (res.status !== 'scored') throw bad('Final score cannot be calculated', [...res.errors.map((e) => e.message), ...res.missing.map((m) => `${m.title}: ${m.what} missing`)]);
    snapshot(db, actor, plan, 'snapshot', 'Released result');
    return move(db, actor, plan, 'released', { reason: note || 'Released', set: {
      final_score: res.rounded, final_rating: res.rating, score_math_json: J(res), calibration_note: note ?? null, released_at: now() } });
  });
}

export function acknowledge(db, actor, planId, { comment } = {}) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'viewPlan');
    if (c.relation !== 'self') throw forbid();
    expectState(plan, 'released');
    // acknowledgement records receipt, not agreement
    return move(db, actor, plan, 'acknowledged', { reason: 'Receipt acknowledged', set: { acknowledged_at: now(), ack_comment: comment ?? null } });
  });
}

export function closePlan(db, actor, planId) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'viewPlan');
    if (c.relation !== 'reviewer' && !(c.relation === 'granted' && isOps(actor))) throw forbid();
    expectState(plan, 'acknowledged');
    const acts = db.prepare('SELECT * FROM development_actions WHERE plan_id = ?').all(planId);
    if (!acts.length) throw bad('Agree at least one development action before closing');
    if (acts.some((a) => !a.owner_id || !a.due_date)) throw bad('Each development action needs an owner and due date');
    return move(db, actor, plan, 'closed', { reason: 'Closed after 1:1', set: { closed_at: now() } });
  });
}

/** Auditable reopen of a released/acknowledged/closed review. */
export function reopen(db, actor, planId, { reason, to = 'manager_review' }) {
  if (!String(reason || '').trim()) throw bad('Reopening needs a reason');
  if (!['manager_review', 'partner_calibration'].includes(to)) throw bad('Can reopen to manager review or calibration only');
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'viewPlan');
    if (!(c.relation === 'partner' || (c.relation === 'granted' && isOps(actor)))) throw forbid('Only the partner or explicitly granted People Ops can reopen');
    expectState(plan, 'released', 'acknowledged', 'closed');
    snapshot(db, actor, plan, 'snapshot', `Before reopen: ${reason}`);
    return move(db, actor, plan, to, { reason: `Reopened: ${reason}`, set: { released_at: null, acknowledged_at: null, closed_at: null, final_score: null, final_rating: null } });
  });
}

// ------------------------------------------------- feedback & development ----
export function inviteProjectFeedback(db, actor, planId, assignmentId) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'viewPlan');
    if (c.relation !== 'reviewer') throw forbid();
    const a = db.prepare('SELECT pa.*, p.lead_user_id FROM project_assignments pa JOIN projects p ON p.id = pa.project_id WHERE pa.id = ? AND pa.user_id = ? AND pa.tenant_id = ?').get(assignmentId, plan.user_id, actor.tenantId);
    if (!a) throw bad('Assignment is not this employee\'s');
    if (!a.lead_user_id) throw bad('Project has no lead');
    if (a.lead_user_id === plan.user_id) throw bad('The employee leads this project');
    db.prepare('INSERT OR IGNORE INTO feedback_invites (id, plan_id, assignment_id, invitee_id, invited_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(uid('inv_'), planId, assignmentId, a.lead_user_id, actor.id, now());
    return a.lead_user_id;
  });
}

export function addProjectFeedback(db, actor, planId, { assignmentId, body, evidenceUrl }) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = planAccess(db, actor, plan);
    if (!c || !c.giveFeedback.includes(assignmentId)) throw forbid('You can only give feedback on an assignment you were invited to');
    if (!String(body || '').trim()) throw bad('Feedback is empty');
    const id = uid('fb_');
    db.prepare('INSERT INTO project_feedback (id, tenant_id, plan_id, assignment_id, author_id, body, evidence_url, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, plan.tenant_id, planId, assignmentId, actor.id, body, evidenceUrl ?? null, now());
    audit(db, { tenantId: plan.tenant_id, actorId: actor.id, action: 'feedback.add', entity: 'plan', entityId: planId });
    return id;
  });
}

export function addDevelopmentAction(db, actor, planId, { kind, title, ownerId, dueDate }) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'viewPlan');
    if (c.relation !== 'reviewer') throw forbid('The line manager records agreed development actions');
    if (!['released', 'acknowledged', 'manager_review', 'partner_calibration'].includes(plan.state)) throw conflict('Not at this stage');
    if (!title) throw bad('Title required');
    const id = uid('dev_');
    db.prepare('INSERT INTO development_actions (id, tenant_id, plan_id, user_id, kind, title, owner_id, due_date) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, plan.tenant_id, planId, plan.user_id, kind || 'development', title, ownerId ?? plan.user_id, dueDate ?? null);
    return id;
  });
}

export function updateDevelopmentAction(db, actor, actionId, { status, followUp }) {
  return tx(db, () => {
    const a = db.prepare('SELECT * FROM development_actions WHERE id = ? AND tenant_id = ?').get(actionId, actor.tenantId);
    if (!a) throw notFound();
    const plan = getPlan(db, a.plan_id);
    const c = planAccess(db, actor, plan);
    if (!c || !['self', 'reviewer'].includes(c.relation)) throw forbid();
    db.prepare('UPDATE development_actions SET status = COALESCE(?, status), follow_up = COALESCE(?, follow_up) WHERE id = ?').run(status ?? null, followUp ?? null, actionId);
    return true;
  });
}

export function addCheckIn(db, actor, planId, { kind, heldOn, note }) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'viewPlan');
    if (!['self', 'reviewer'].includes(c.relation)) throw forbid();
    const id = uid('chk_');
    db.prepare('INSERT INTO check_ins (id, plan_id, kind, held_on, author_id, note) VALUES (?,?,?,?,?,?)').run(id, planId, kind || 'quarterly', heldOn, actor.id, note ?? null);
    return id;
  });
}

export function raiseClarification(db, actor, planId, { question }) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = assertPlan(db, actor, plan, 'viewPlan');
    if (c.relation !== 'self') throw forbid();
    const route = db.prepare("SELECT value_json FROM settings WHERE tenant_id = ? AND key = 'clarification_route'").get(actor.tenantId);
    const routeTo = route ? P(route.value_json) : 'reviewer';
    const to = routeTo === 'partner' ? plan.partner_id : plan.reviewer_id;
    const id = uid('clar_');
    db.prepare('INSERT INTO clarifications (id, tenant_id, plan_id, raised_by, route_to, question, created_at) VALUES (?,?,?,?,?,?,?)').run(id, plan.tenant_id, planId, actor.id, to, question, now());
    return id;
  });
}

// ---------------------------------------------------------------- views ----
/** Serialize a plan with only the fields the viewer may see. */
export function planView(db, actor, planId) {
  const plan = getPlan(db, planId);
  const c = planAccess(db, actor, plan);
  if (!c) throw forbid();
  const emp = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(plan.user_id);
  if (c.relation === 'input') {
    const mine = db.prepare('SELECT * FROM plan_inputs WHERE plan_id = ? AND author_id = ? ORDER BY created_at').all(planId, actor.id);
    return { id: plan.id, employee: emp, access: c, label: c.giveInput, myInputs: mine };
  }
  if (c.relation === 'project_lead') {
    const asg = db.prepare(`SELECT pa.id, pa.role, p.name project FROM project_assignments pa JOIN projects p ON p.id = pa.project_id WHERE pa.id IN (${c.giveFeedback.map(() => '?').join(',')})`).all(...c.giveFeedback);
    const mine = db.prepare('SELECT * FROM project_feedback WHERE plan_id = ? AND author_id = ?').all(planId, actor.id);
    return { id: plan.id, employee: emp, access: c, assignments: asg, myFeedback: mine };
  }
  const { cycle, cfg } = cycleCfg(db, plan.cycle_id);
  const links = planItemLinks(db, planId);
  const its = items(db, planId).map((i) => {
    const o = { strategy: links[i.id] || [], id: i.id, category: i.category, title: i.title, description: i.description, kpi: i.kpi, target: i.target, weight: i.weight,
      expected_proficiency: i.expected_proficiency, anchors: P(i.anchors_json), carried_from_item_id: i.carried_from_item_id,
      evidence_required: !!i.evidence_required, na: !!i.na, na_reason: i.na_reason, na_approved: !!i.na_approved_by, source_rating_raw: i.source_rating_raw };
    if (c.viewSelf) Object.assign(o, { actual: i.actual, self_rating: i.self_rating, self_rationale: i.self_rationale, self_evidence: P(i.self_evidence_json, []) });
    if (c.viewManager) Object.assign(o, { manager_rating: i.manager_rating, manager_rationale: i.manager_rationale });
    if (c.viewCalibration || (c.viewOutcome && c.relation === 'self')) Object.assign(o, { calibrated_rating: i.calibrated_rating, calibration_reason: c.viewCalibration ? i.calibration_reason : undefined });
    return o;
  });
  const summary = P(plan.summary_json, {});
  const view = {
    id: plan.id, state: plan.state, stateLabel: STATE_LABEL[plan.state], cycle: { id: cycle.id, name: cycle.name, year: cycle.year, self_due: cycle.self_due, manager_due: cycle.manager_due },
    employee: emp, role_title: plan.role_title, reviewer: userName(db, plan.reviewer_id), partner: userName(db, plan.partner_id),
    category_weights: P(plan.category_weights_json, {}), rubric_version: plan.rubric_version, approved_revision: plan.approved_revision,
    basis_status: plan.basis_status, basis_note: plan.basis_note, scale: cfg.scale, scoring_status: cfg.status, row_version: plan.row_version,
    access: c, items: its,
    can_link_strategy: plan.state !== 'closed' && (isOps(actor) || ['self', 'reviewer', 'category_reviewer', 'partner'].includes(c.relation)),
    summary: { self: c.viewSelf ? summary.self : undefined, manager: c.viewManager ? summary.manager : undefined },
    revisions: db.prepare('SELECT revision, kind, approved_by, approved_at, note FROM plan_revisions WHERE plan_id = ? ORDER BY revision').all(planId),
    transitions: db.prepare('SELECT from_state, to_state, actor_id, reason, at FROM plan_transitions WHERE plan_id = ? ORDER BY id').all(planId),
    development_actions: db.prepare('SELECT * FROM development_actions WHERE plan_id = ?').all(planId),
    check_ins: db.prepare('SELECT * FROM check_ins WHERE plan_id = ? ORDER BY held_on').all(planId),
  };
  view.category_reviewers = db.prepare('SELECT r.category, u.id, u.name FROM plan_category_reviewers r JOIN users u ON u.id = r.user_id WHERE r.plan_id = ?').all(planId);
  if (c.viewProjectFeedback) {
    view.inputs = db.prepare('SELECT i.label, i.body, i.evidence_url, i.created_at, u.name author FROM plan_inputs i JOIN users u ON u.id = i.author_id WHERE i.plan_id = ? ORDER BY i.created_at').all(planId);
    view.input_invites = db.prepare('SELECT i.label, u.name, u.id user_id, EXISTS(SELECT 1 FROM plan_inputs x WHERE x.plan_id = i.plan_id AND x.author_id = i.invitee_id) given FROM plan_input_invites i JOIN users u ON u.id = i.invitee_id WHERE i.plan_id = ?').all(planId);
  }
  if (c.relation !== 'self') {
    const n = db.prepare('SELECT n.rationale, n.status, n.source, n.confirmed_at, u.name confirmed_by FROM plan_reviewer_notes n LEFT JOIN users u ON u.id = n.confirmed_by WHERE n.plan_id = ?').get(planId);
    if (n) view.reviewer_note = { ...n, can_decide: has(actor, 'partner') || isOps(actor) };
  }
  if (c.viewProjectFeedback) view.project_feedback = db.prepare(`SELECT f.*, u.name author, p.name project FROM project_feedback f JOIN users u ON u.id = f.author_id
      JOIN project_assignments pa ON pa.id = f.assignment_id JOIN projects p ON p.id = pa.project_id WHERE f.plan_id = ?`).all(planId);
  if (c.relation === 'self' || c.relation === 'reviewer' || c.relation === 'partner') {
    view.projects = db.prepare(`SELECT pa.id assignment_id, pa.role, pa.status, pa.start_date, pa.end_date, p.name, p.kind, p.id project_id FROM project_assignments pa
        JOIN projects p ON p.id = pa.project_id WHERE pa.user_id = ? AND pa.status IN ('confirmed','historical') AND p.register_status = 'approved'
        AND (pa.end_date IS NULL OR substr(pa.end_date,1,4) >= ?) AND (pa.start_date IS NULL OR substr(pa.start_date,1,4) <= ?)`).all(plan.user_id, String(cycle.year), String(cycle.year));
  }
  // live score previews (self vs manager vs final are always kept independent)
  const raw = items(db, planId);
  const cw = P(plan.category_weights_json, {});
  view.scores = {};
  if (c.viewSelf) view.scores.self = computeScore({ categoryWeights: cw, items: raw, config: cfg, field: 'self_rating' });
  if (c.viewManager && c.relation !== 'self') view.scores.manager = computeScore({ categoryWeights: cw, items: raw, config: cfg, field: 'manager_rating' });
  if (c.viewCalibration) view.scores.final = computeScore({ categoryWeights: cw, items: raw, config: cfg, field: 'final' });
  if (c.viewOutcome && plan.released_at) view.outcome = { final_score: plan.final_score, final_rating: plan.final_rating, math: P(plan.score_math_json)?.math, released_at: plan.released_at, acknowledged_at: plan.acknowledged_at, ack_comment: plan.ack_comment };
  if (c.viewSelf && c.viewManager && c.relation !== 'self') {
    view.discrepancies = raw.filter((i) => !i.na && i.self_rating != null && i.manager_rating != null && Math.abs(i.self_rating - i.manager_rating) >= 1)
      .map((i) => ({ itemId: i.id, title: i.title, self: i.self_rating, manager: i.manager_rating }));
  }
  return view;
}

const userName = (db, id) => (id ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(id) : null);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// ------------------------------------------------------- split reviews ----
/** People Ops or the lead reviewer assigns who rates a category (e.g. objectives → technical partner). */
export function setCategoryReviewer(db, actor, planId, { category, userId }) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    if (plan.tenant_id !== actor.tenantId) throw forbid();
    const c = planAccess(db, actor, plan);
    if (!isOps(actor) && c?.relation !== 'reviewer') throw forbid();
    if (!['objective', 'competency', 'initiative'].includes(category)) throw bad('Unknown category');
    if (['partner_calibration', 'released', 'acknowledged', 'closed'].includes(plan.state)) throw conflict('Reviewers cannot change after the manager review');
    if (userId === plan.user_id) throw bad('An employee cannot rate their own review');
    assertTenantUsers(db, actor, userId);
    if (!userId || userId === plan.reviewer_id) db.prepare('DELETE FROM plan_category_reviewers WHERE plan_id = ? AND category = ?').run(planId, category);
    else db.prepare('INSERT INTO plan_category_reviewers (plan_id, category, user_id, assigned_by, assigned_at) VALUES (?,?,?,?,?) ON CONFLICT(plan_id, category) DO UPDATE SET user_id = excluded.user_id, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at')
      .run(planId, category, userId, actor.id, now());
    audit(db, { tenantId: plan.tenant_id, actorId: actor.id, action: 'plan.category_reviewer', entity: 'plan', entityId: planId, after: { category, userId } });
    return true;
  });
}

/** Invite someone (e.g. the senior who led the person's projects) to give written input. */
/** Withdraw an input request that has not been answered (lead reviewer or People Ops). */
export function removeInputInvite(db, actor, planId, { inviteeId, reason }) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    if (plan.tenant_id !== actor.tenantId) throw forbid();
    const c = planAccess(db, actor, plan);
    if (!isOps(actor) && c?.relation !== 'reviewer') throw forbid();
    if (db.prepare('SELECT 1 FROM plan_inputs WHERE plan_id = ? AND author_id = ?').get(planId, inviteeId)) throw conflict('Input was already given and stays on the record');
    const r = db.prepare('DELETE FROM plan_input_invites WHERE plan_id = ? AND invitee_id = ?').run(planId, inviteeId);
    if (r.changes) audit(db, { tenantId: plan.tenant_id, actorId: actor.id, action: 'plan.input_uninvite', entity: 'plan', entityId: planId, reason: reason || null, after: { inviteeId } });
    return r.changes > 0;
  });
}

export function inviteInput(db, actor, planId, { inviteeId, label }) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    if (plan.tenant_id !== actor.tenantId) throw forbid();
    const c = planAccess(db, actor, plan);
    if (!isOps(actor) && c?.relation !== 'reviewer') throw forbid();
    assertTenantUsers(db, actor, inviteeId);
    if (inviteeId === plan.user_id) throw bad('The employee cannot give input on their own review');
    db.prepare('INSERT OR IGNORE INTO plan_input_invites (id, plan_id, invitee_id, label, invited_by, created_at) VALUES (?,?,?,?,?,?)').run(uid('pii_'), planId, inviteeId, label || 'Project feedback', actor.id, now());
    audit(db, { tenantId: plan.tenant_id, actorId: actor.id, action: 'plan.input_invite', entity: 'plan', entityId: planId, after: { inviteeId, label } });
    return true;
  });
}

export function addInput(db, actor, planId, { body, evidenceUrl }) {
  return tx(db, () => {
    const plan = getPlan(db, planId);
    const c = planAccess(db, actor, plan);
    if (c?.relation !== 'input') throw forbid('You were not invited to give input on this review');
    if (!String(body || '').trim()) throw bad('Input is empty');
    const id = uid('inp_');
    db.prepare('INSERT INTO plan_inputs (id, tenant_id, plan_id, author_id, label, body, evidence_url, created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, plan.tenant_id, planId, actor.id, c.giveInput, body, evidenceUrl ?? null, now());
    audit(db, { tenantId: plan.tenant_id, actorId: actor.id, action: 'plan.input', entity: 'plan', entityId: planId });
    return id;
  });
}

/** Partners (or People Ops) confirm the reviewer choice, or ask for a change. */
export function decideReviewerNote(db, actor, planId, { decision, note } = {}) {
  if (!has(actor, 'partner') && !isOps(actor)) throw forbid();
  const plan = getPlan(db, planId);
  if (plan.tenant_id !== actor.tenantId) throw notFound();
  if (!['confirm', 'change'].includes(decision)) throw bad('decision must be confirm or change');
  return tx(db, () => {
    const cur = db.prepare('SELECT * FROM plan_reviewer_notes WHERE plan_id = ?').get(planId);
    if (!cur) db.prepare("INSERT INTO plan_reviewer_notes (plan_id, tenant_id, status, updated_at) VALUES (?,?,'draft',?)").run(planId, plan.tenant_id, now());
    const status = decision === 'confirm' ? 'confirmed' : 'change_requested';
    db.prepare('UPDATE plan_reviewer_notes SET status = ?, confirmed_by = ?, confirmed_at = ?, updated_at = ?, rationale = CASE WHEN ? IS NULL THEN rationale ELSE COALESCE(rationale || char(10), \'\') || ? END WHERE plan_id = ?')
      .run(status, actor.id, now(), now(), note || null, note ? `Note: ${note}` : null, planId);
    audit(db, { tenantId: plan.tenant_id, actorId: actor.id, action: `reviewers.${status}`, entity: 'plan', entityId: planId, reason: note || null });
    return { status };
  });
}
