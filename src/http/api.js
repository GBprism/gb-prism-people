// API routes. Every handler receives the authenticated actor; authorization is
// enforced inside the domain functions (record level) and here (role level).
import { Router } from './router.js';
import { P, bad, forbid, notFound, J, uid, now, audit, tx } from '../db.js';
import { loadActor, isOps, has, planAccess, currentEmployment, leaveAccess, assertTenantUsers } from '../domain/authz.js';
import * as perf from '../domain/performance.js';
import * as leave from '../domain/leave.js';
import * as proj from '../domain/projects.js';
import * as ai from '../domain/ai.js';
import * as ntf from '../domain/notifications.js';
import { previewLeaveboard, applyLeaveboard, postOpeningBalances, reconcile, compareSnapshots } from '../imports/leaveboard.js';
import { previewPlans, applyPlans, previewHistory, applyHistory } from '../imports/pms.js';
import { previewGbForms, applyGbForms } from '../imports/gbform.js';
import { importGeminiLog } from '../imports/gemini.js';
import { getBatch, reverseBatch } from '../imports/batch.js';
import { fmtX100, toX100 } from '../domain/decimal.js';
import { todayIn } from '../domain/dates.js';

export function buildApi(db) {
  const r = new Router();
  const q = (ctx, k) => ctx.url.searchParams.get(k);

  // ------------------------------------------------------------ identity --
  r.get('/api/me', ({ actor }) => {
    const emp = currentEmployment(db, actor.id);
    const reviews = db.prepare('SELECT COUNT(*) n FROM plans WHERE reviewer_id = ?').get(actor.id).n;
    const approvals = db.prepare("SELECT COUNT(*) n FROM employments WHERE (manager_id = ? OR backup_approver_id = ?) AND effective_to IS NULL").get(actor.id, actor.id).n;
    const leads = db.prepare('SELECT COUNT(*) n FROM projects WHERE lead_user_id = ?').get(actor.id).n;
    return { id: actor.id, name: actor.name, email: actor.email, roles: [...actor.roles], title: emp?.title,
      nav: { inbox: reviews > 0 || approvals > 0 || leads > 0 || has(actor, 'partner'), calibration: has(actor, 'partner'), admin: isOps(actor) } };
  });

  // directory (names only) for pickers such as "who covers your work"
  r.get('/api/people', ({ actor }) => db.prepare('SELECT id, name FROM users WHERE tenant_id = ? AND active = 1 AND id != ? ORDER BY name').all(actor.tenantId, actor.id));

  // ----------------------------------------------------------------- home --
  r.get('/api/home', ({ actor }) => {
    const year = Number(todayIn().slice(0, 4));
    const plans = db.prepare(`SELECT p.id, p.state, c.name cycle, c.year, c.self_due FROM plans p JOIN cycles c ON c.id = p.cycle_id WHERE p.user_id = ? AND c.status != 'historical' ORDER BY c.year`).all(actor.id);
    const balances = leave.balancesForUser(db, actor, actor.id, year).filter((b) => b.tracks_balance).map((b) => ({ ...b, posted: fmtX100(b.posted_x100), pending: fmtX100(b.pending_x100), projected: fmtX100(b.projected_x100) }));
    const wfhType = db.prepare("SELECT id FROM leave_types WHERE tenant_id = ? AND code = 'WFH'").get(actor.tenantId);
    const month = todayIn().slice(0, 7);
    const pol = leave.activePolicy(db, actor.tenantId, todayIn());
    let offsiteUsed = 0;
    if (wfhType) for (const x of db.prepare("SELECT breakdown_json FROM leave_requests WHERE user_id = ? AND type_id = ? AND state IN ('submitted','approved')").all(actor.id, wfhType.id)) for (const d of P(x.breakdown_json).days) if (d.date.startsWith(month)) offsiteUsed += d.charge_x100;
    const requests = db.prepare("SELECT * FROM leave_requests WHERE user_id = ? ORDER BY start_date DESC LIMIT 5").all(actor.id).map((x) => leave.requestView(db, actor, x));
    const next = nextAction(actor, plans);
    const devActions = db.prepare("SELECT d.* FROM development_actions d JOIN plans p ON p.id = d.plan_id WHERE d.user_id = ? AND p.state IN ('released','acknowledged','closed') AND d.status IN ('open','in_progress')").all(actor.id);
    return { next, plans: plans.map((p) => ({ ...p, stateLabel: perf.STATE_LABEL[p.state] })), balances, offsite: { month, used: fmtX100(offsiteUsed), quota: pol.settings.offsite.monthlyQuota },
      policy_status: pol.status, requests, development_actions: devActions };
  });
  function nextAction(actor, plans) {
    const p = plans.find((x) => ['approved_plan', 'self_assessment'].includes(x.state));
    if (p) return { label: `Complete your ${p.cycle} self-assessment`, due: p.self_due, link: `#/review/${p.id}` };
    const rel = plans.find((x) => x.state === 'released');
    if (rel) return { label: 'Read and acknowledge your review result', link: `#/review/${rel.id}` };
    const draft = plans.find((x) => x.state === 'draft_plan');
    if (draft) return { label: `Finish your ${draft.cycle} goals and send them for approval`, link: `#/review/${draft.id}` };
    return { label: 'Nothing waiting for you right now', link: null };
  }

  // ---------------------------------------------------------------- inbox --
  r.get('/api/inbox', ({ actor }) => {
    const items = [];
    for (const p of db.prepare(`SELECT p.*, u.name emp, c.name cycle, c.manager_due due FROM plans p JOIN users u ON u.id = p.user_id JOIN cycles c ON c.id = p.cycle_id
        WHERE p.tenant_id = ? AND p.reviewer_id = ? AND p.state IN ('draft_plan','manager_review','released','acknowledged')`).all(actor.tenantId, actor.id)) {
      const kind = { draft_plan: 'Approve plan', manager_review: 'Manager review', released: 'Hold 1:1 and agree actions', acknowledged: 'Close review' }[p.state];
      items.push({ type: 'review', kind, title: `${p.emp} — ${p.cycle}`, due: p.state === 'manager_review' ? p.due : null, link: `#/review/${p.id}`, state: perf.STATE_LABEL[p.state] });
    }
    for (const p of db.prepare(`SELECT p.*, u.name emp, c.name cycle, c.manager_due due, group_concat(r.category) cats FROM plan_category_reviewers r JOIN plans p ON p.id = r.plan_id
        JOIN users u ON u.id = p.user_id JOIN cycles c ON c.id = p.cycle_id WHERE r.user_id = ? AND p.tenant_id = ? AND p.state = 'manager_review' AND p.reviewer_id != ? GROUP BY p.id`).all(actor.id, actor.tenantId, actor.id))
      items.push({ type: 'review', kind: `Rate ${p.cats.replace(/,/g, ' & ')}`, title: `${p.emp} — ${p.cycle}`, due: p.due, link: `#/review/${p.id}`, state: 'Manager review' });
    for (const p of db.prepare(`SELECT p.id, u.name emp, i.label FROM plan_input_invites i JOIN plans p ON p.id = i.plan_id JOIN users u ON u.id = p.user_id
        WHERE i.invitee_id = ? AND p.state IN ('approved_plan','self_assessment','manager_review') AND NOT EXISTS (SELECT 1 FROM plan_inputs x WHERE x.plan_id = p.id AND x.author_id = i.invitee_id)`).all(actor.id))
      items.push({ type: 'feedback', kind: p.label, title: p.emp, link: `#/review/${p.id}`, state: 'Input requested' });
    if (has(actor, 'partner')) for (const p of db.prepare(`SELECT p.*, u.name emp, c.name cycle, c.calibration_due due FROM plans p JOIN users u ON u.id = p.user_id JOIN cycles c ON c.id = p.cycle_id
        WHERE p.tenant_id = ? AND p.partner_id = ? AND p.state = 'partner_calibration'`).all(actor.tenantId, actor.id)) items.push({ type: 'calibration', kind: 'Calibrate', title: `${p.emp} — ${p.cycle}`, due: p.due, link: `#/review/${p.id}`, state: 'Partner calibration' });
    for (const x of db.prepare("SELECT * FROM leave_requests WHERE tenant_id = ? AND state = 'submitted' AND (approver_id = ? OR backup_approver_id = ?) AND user_id != ?").all(actor.tenantId, actor.id, actor.id, actor.id)) {
      const v = leave.requestView(db, actor, x);
      items.push({ type: 'request', kind: v.type.category === 'offsite' ? 'Off-site request' : 'Time-off request', title: `${v.user.name} — ${v.type.name} ${v.start_date}${v.end_date !== v.start_date ? ' → ' + v.end_date : ''} (${v.chargeable} d)`, due: v.start_date, link: `#/request/${x.id}`, state: 'Waiting for you', warnings: v.warnings.length });
    }
    for (const f of db.prepare(`SELECT fi.plan_id, u.name emp, pr.name project FROM feedback_invites fi JOIN plans p ON p.id = fi.plan_id JOIN users u ON u.id = p.user_id
        JOIN project_assignments pa ON pa.id = fi.assignment_id JOIN projects pr ON pr.id = pa.project_id WHERE fi.invitee_id = ? AND p.state IN ('manager_review','self_assessment')
        AND NOT EXISTS (SELECT 1 FROM project_feedback pf WHERE pf.plan_id = fi.plan_id AND pf.assignment_id = fi.assignment_id AND pf.author_id = fi.invitee_id)`).all(actor.id))
      items.push({ type: 'feedback', kind: 'Project feedback', title: `${f.emp} on ${f.project}`, link: `#/review/${f.plan_id}`, state: 'Invited' });
    for (const c of db.prepare(`SELECT c.*, d.title FROM contributions c JOIN deliverables d ON d.id = c.deliverable_id JOIN projects p ON p.id = d.project_id WHERE p.lead_user_id = ? AND c.status = 'claimed' AND c.user_id != ?`).all(actor.id, actor.id))
      items.push({ type: 'contribution', kind: 'Confirm contribution', title: `${c.title} — ${c.responsibility}`, link: '#/projects', state: 'Claimed' });
    for (const c of db.prepare("SELECT c.*, u.name FROM clarifications c JOIN users u ON u.id = c.raised_by WHERE c.route_to = ? AND c.status = 'open'").all(actor.id))
      items.push({ type: 'clarification', kind: 'Clarification', title: `${c.name}: ${c.question.slice(0, 80)}`, link: `#/review/${c.plan_id}`, state: 'Open' });
    return { items };
  });

  // -------------------------------------------------------- performance --
  r.get('/api/my/plans', ({ actor }) => db.prepare('SELECT p.id, p.state, c.name cycle, c.year, c.status cycle_status FROM plans p JOIN cycles c ON c.id = p.cycle_id WHERE p.user_id = ? ORDER BY c.year DESC').all(actor.id)
    .map((p) => ({ ...p, stateLabel: perf.STATE_LABEL[p.state] })));
  r.get('/api/cycles', ({ actor }) => db.prepare('SELECT id, year, name, status, self_due, manager_due, calibration_due FROM cycles WHERE tenant_id = ? ORDER BY year DESC').all(actor.tenantId));
  r.get('/api/templates', ({ actor }) => db.prepare('SELECT id, role_family, version, status, category_weights_json FROM role_templates WHERE tenant_id = ?').all(actor.tenantId).map((t) => ({ ...t, category_weights: P(t.category_weights_json), category_weights_json: undefined })));
  r.post('/api/cycles/:id/open-self', ({ actor, params }) => ({ opened: perf.openSelfAssessment(db, actor, params.id) }));
  r.get('/api/plans/:id', ({ actor, params }) => perf.planView(db, actor, params.id));
  r.post('/api/plans', ({ actor, body }) => {
    const emp = currentEmployment(db, body.userId || actor.id);
    return perf.createPlan(db, actor, { ...body, userId: body.userId || actor.id, reviewerId: body.reviewerId ?? emp?.manager_id, partnerId: body.partnerId ?? partnerFor(actor) });
  });
  const partnerFor = (actor) => db.prepare("SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'partner' WHERE u.tenant_id = ? AND u.id != ? LIMIT 1").get(actor.tenantId, actor.id)?.id ?? null;
  r.post('/api/plans/:id/draft', ({ actor, params, body }) => perf.editDraft(db, actor, params.id, body));
  r.post('/api/plans/:id/approve', ({ actor, params, body }) => perf.approvePlan(db, actor, params.id, body));
  r.post('/api/plans/:id/amend', ({ actor, params, body }) => perf.amendPlan(db, actor, params.id, body));
  r.post('/api/plans/:id/self', ({ actor, params, body }) => perf.saveSelf(db, actor, params.id, body));
  r.post('/api/plans/:id/self/submit', ({ actor, params }) => perf.submitSelf(db, actor, params.id));
  r.post('/api/plans/:id/manager', ({ actor, params, body }) => perf.saveManager(db, actor, params.id, body));
  r.post('/api/plans/:id/manager/submit', ({ actor, params }) => perf.submitManager(db, actor, params.id));
  r.post('/api/plans/:id/return', ({ actor, params, body }) => perf.returnPlan(db, actor, params.id, body));
  r.post('/api/plans/:id/items/:item/calibrate', ({ actor, params, body }) => perf.calibrateItem(db, actor, params.id, params.item, body));
  r.post('/api/plans/:id/items/:item/approve-na', ({ actor, params }) => perf.approveNa(db, actor, params.id, params.item));
  r.post('/api/plans/:id/release', ({ actor, params, body }) => perf.release(db, actor, params.id, body));
  r.post('/api/plans/:id/acknowledge', ({ actor, params, body }) => perf.acknowledge(db, actor, params.id, body));
  r.post('/api/plans/:id/close', ({ actor, params }) => perf.closePlan(db, actor, params.id));
  r.post('/api/plans/:id/reopen', ({ actor, params, body }) => perf.reopen(db, actor, params.id, body));
  r.post('/api/plans/:id/feedback-invite', ({ actor, params, body }) => ({ invitee: perf.inviteProjectFeedback(db, actor, params.id, body.assignmentId) }));
  r.post('/api/plans/:id/feedback', ({ actor, params, body }) => ({ id: perf.addProjectFeedback(db, actor, params.id, body) }));
  r.post('/api/plans/:id/category-reviewers', ({ actor, params, body }) => ({ ok: perf.setCategoryReviewer(db, actor, params.id, body) }));
  r.post('/api/plans/:id/input-invites', ({ actor, params, body }) => ({ ok: perf.inviteInput(db, actor, params.id, body) }));
  r.post('/api/plans/:id/inputs', ({ actor, params, body }) => ({ id: perf.addInput(db, actor, params.id, body) }));
  r.post('/api/plans/:id/actions', ({ actor, params, body }) => ({ id: perf.addDevelopmentAction(db, actor, params.id, body) }));
  r.patch('/api/actions/:id', ({ actor, params, body }) => perf.updateDevelopmentAction(db, actor, params.id, body));
  r.post('/api/plans/:id/check-ins', ({ actor, params, body }) => ({ id: perf.addCheckIn(db, actor, params.id, body) }));
  r.post('/api/plans/:id/clarifications', ({ actor, params, body }) => ({ id: perf.raiseClarification(db, actor, params.id, body) }));
  r.post('/api/plans/:id/basis-decision', ({ actor, params, body }) => perf.recordBasisDecision(db, actor, params.id, body));
  r.get('/api/plans/:id/export', ({ actor, params }) => {
    const v = perf.planView(db, actor, params.id);
    if (!['reviewer', 'partner', 'granted'].includes(v.access.relation)) throw forbid('Exports are for reviewers and calibrators');
    const rows = [['Category', 'Item', 'Weight', 'Target', 'Actual', 'Self rating', 'Manager rating', 'Calibrated rating', 'N/A']];
    for (const i of v.items) rows.push([i.category, i.title, i.weight, i.target, i.actual, i.self_rating, i.manager_rating, i.calibrated_rating, i.na ? 'N/A' : '']);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'plan.export', entity: 'plan', entityId: params.id });
    return { __raw: rows.map((r) => r.map(csvCell).join(',')).join('\n'), contentType: 'text/csv; charset=utf-8', filename: `review-${params.id}.csv` };
  });
  r.get('/api/team/progress', ({ actor }) => {
    // manager progress tracking: own reviewees only, state + check-ins + open actions (no ratings)
    return db.prepare(`SELECT p.id, u.name, c.name cycle, p.state, (SELECT COUNT(*) FROM check_ins k WHERE k.plan_id = p.id) check_ins,
        (SELECT COUNT(*) FROM development_actions d WHERE d.user_id = p.user_id AND d.status IN ('open','in_progress')) open_actions
        FROM plans p JOIN users u ON u.id = p.user_id JOIN cycles c ON c.id = p.cycle_id WHERE p.reviewer_id = ? AND c.status != 'historical' ORDER BY c.year DESC, u.name`).all(actor.id)
      .map((x) => ({ ...x, stateLabel: perf.STATE_LABEL[x.state] }));
  });

  // ---------------------------------------------------------------- leave --
  r.get('/api/leave/types', ({ actor }) => db.prepare('SELECT code, name, category, allow_partial, requires_cover, reason_required, tracks_balance FROM leave_types WHERE tenant_id = ? AND active = 1').all(actor.tenantId));
  r.get('/api/leave/balances', ({ actor, ctx }) => leave.balancesForUser(db, actor, q(ctx, 'userId') || actor.id, Number(q(ctx, 'year') || todayIn().slice(0, 4)))
    .map((b) => ({ ...b, posted: fmtX100(b.posted_x100), pending: fmtX100(b.pending_x100), projected: fmtX100(b.projected_x100) })));
  r.get('/api/leave/ledger', ({ actor, ctx }) => {
    const userId = q(ctx, 'userId') || actor.id;
    leave.balancesForUser(db, actor, userId, 2000); // permission check
    return db.prepare('SELECT l.period_year, t.code type, l.kind, l.amount_x100, l.effective_date, l.note, l.request_id, l.created_at FROM leave_ledger l JOIN leave_types t ON t.id = l.type_id WHERE l.tenant_id = ? AND l.user_id = ? ORDER BY l.id DESC LIMIT 300')
      .all(actor.tenantId, userId).map((e) => ({ ...e, amount: fmtX100(e.amount_x100) }));
  });
  r.post('/api/leave/preview', ({ actor, body }) => {
    const ev = leave.previewRequest(db, actor, body);
    return { chargeable: fmtX100(ev.calc.total_x100), days: ev.calc.days.map((d) => ({ ...d, charge: fmtX100(d.charge_x100) })), by_year: Object.fromEntries(Object.entries(ev.calc.byYear).map(([y, v]) => [y, fmtX100(v)])),
      projected: ev.projected && Object.fromEntries(Object.entries(ev.projected).map(([y, p]) => [y, { before: fmtX100(p.before_x100), after: fmtX100(p.after_x100) }])),
      blocking: ev.blocking, warnings: ev.warnings, policy: ev.policy, approver: db.prepare('SELECT name FROM users WHERE id = ?').get(ev.approverId || '')?.name ?? null };
  });
  r.post('/api/leave/requests', ({ actor, body }) => leave.requestView(db, actor, leave.submitRequest(db, actor, body)));
  r.get('/api/leave/requests', ({ actor, ctx }) => {
    const scope = q(ctx, 'scope') || 'mine';
    const rows = scope === 'approvals'
      ? db.prepare('SELECT * FROM leave_requests WHERE tenant_id = ? AND (approver_id = ? OR backup_approver_id = ?) ORDER BY created_at DESC LIMIT 200').all(actor.tenantId, actor.id, actor.id)
      : scope === 'all' && isOps(actor) ? db.prepare('SELECT * FROM leave_requests WHERE tenant_id = ? ORDER BY start_date DESC LIMIT 500').all(actor.tenantId)
        : db.prepare('SELECT * FROM leave_requests WHERE tenant_id = ? AND user_id = ? ORDER BY start_date DESC').all(actor.tenantId, actor.id);
    return rows.map((x) => leave.requestView(db, actor, x)).filter(Boolean);
  });
  r.get('/api/leave/requests/:id', ({ actor, params }) => {
    const x = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(params.id);
    const v = x && leave.requestView(db, actor, x);
    if (!v) throw notFound();
    if (v.can_decide) v.balances = leave.balancesForUser(db, actor, x.user_id, Number(x.start_date.slice(0, 4))).filter((b) => b.tracks_balance).map((b) => ({ name: b.name, posted: fmtX100(b.posted_x100), pending: fmtX100(b.pending_x100) }));
    return v;
  });
  r.post('/api/leave/requests/:id/decide', ({ actor, params, body }) => leave.requestView(db, actor, leave.decideRequest(db, actor, params.id, body)));
  r.post('/api/leave/requests/:id/cancel', ({ actor, params, body }) => leave.requestView(db, actor, leave.cancelRequest(db, actor, params.id, body)));
  r.get('/api/leave/calendar', ({ actor, ctx }) => leave.teamCalendar(db, actor, { from: q(ctx, 'from') || todayIn(), to: q(ctx, 'to') || todayIn() }));
  r.post('/api/leave/adjust', ({ actor, body }) => leave.adjustBalance(db, actor, { ...body, amountX100: toX100(body.amount) }));
  r.post('/api/leave/carryover', ({ actor, body }) => leave.runCarryover(db, actor, body));
  r.post('/api/leave/expiry', ({ actor, body }) => leave.runCarryoverExpiry(db, actor, body));

  // ---------------------------------------------------------------- admin --
  const ops = (actor) => { if (!isOps(actor)) throw forbid(); };
  r.get('/api/admin/roster', ({ actor }) => { ops(actor);
    return db.prepare(`SELECT u.id, u.name, u.email, u.active, u.synthetic, e.title, e.role_family, e.country, e.hire_date, e.probation_end, m.name manager, b.name backup
        FROM users u LEFT JOIN employments e ON e.user_id = u.id AND e.effective_to IS NULL LEFT JOIN users m ON m.id = e.manager_id LEFT JOIN users b ON b.id = e.backup_approver_id
        WHERE u.tenant_id = ? ORDER BY u.name`).all(actor.tenantId).map((u) => ({ ...u, roles: db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(u.id).map((x) => x.role) }));
  });
  r.post('/api/admin/roster/:id/employment', ({ actor, params, body }) => { ops(actor);
    return tx(db, () => {
      const u = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(params.id, actor.tenantId); if (!u) throw notFound();
      if (!body.effectiveFrom || !body.title) throw bad('Title and effective date required');
      assertTenantUsers(db, actor, body.managerId, body.backupId);
      const cur = currentEmployment(db, u.id);
      if (cur) db.prepare("UPDATE employments SET effective_to = date(?, '-1 day') WHERE id = ?").run(body.effectiveFrom, cur.id); // keep history
      db.prepare(`INSERT INTO employments (id, tenant_id, user_id, title, role_family, manager_id, backup_approver_id, country, hire_date, probation_end, effective_from) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(uid('emp_'), actor.tenantId, u.id, body.title, body.roleFamily || cur?.role_family || 'consultant', body.managerId ?? cur?.manager_id ?? null, body.backupId ?? cur?.backup_approver_id ?? null, body.country || cur?.country || 'JO', body.hireDate ?? cur?.hire_date ?? null, body.probationEnd ?? cur?.probation_end ?? null, body.effectiveFrom);
      audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'roster.employment', entity: 'user', entityId: u.id, before: cur, after: body });
      return { ok: true };
    });
  });
  r.get('/api/admin/aliases', ({ actor }) => { ops(actor); return db.prepare('SELECT a.*, u.name FROM identity_aliases a LEFT JOIN users u ON u.id = a.user_id WHERE a.tenant_id = ?').all(actor.tenantId); });
  r.post('/api/admin/aliases', ({ actor, body }) => { ops(actor);
    if (!body.alias || !body.source || !body.userId) throw bad('alias, source and userId required');
    assertTenantUsers(db, actor, body.userId);
    db.prepare('INSERT INTO identity_aliases (id, tenant_id, user_id, source, alias, verified) VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id, source, alias) DO UPDATE SET user_id = excluded.user_id, verified = excluded.verified')
      .run(uid('al_'), actor.tenantId, body.userId, body.source, body.alias, body.verified ? 1 : 0);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'alias.set', entity: 'user', entityId: body.userId, after: body });
    return { ok: true };
  });
  r.get('/api/admin/policy', ({ actor }) => { ops(actor); return db.prepare('SELECT * FROM policy_versions WHERE tenant_id = ? ORDER BY version DESC').all(actor.tenantId).map((p) => ({ ...p, settings: P(p.settings_json), settings_json: undefined })); });
  r.post('/api/admin/policy', ({ actor, body }) => { ops(actor);
    const v = (db.prepare('SELECT MAX(version) m FROM policy_versions WHERE tenant_id = ?').get(actor.tenantId).m || 0) + 1;
    if (!body.effectiveFrom) throw bad('Effective date required');
    db.prepare("INSERT INTO policy_versions (id, tenant_id, version, effective_from, status, settings_json, note) VALUES (?,?,?,?, 'awaiting_confirmation', ?, ?)").run(uid('pol_'), actor.tenantId, v, body.effectiveFrom, J({ ...leave.CANDIDATE_POLICY, ...body.settings }), body.note ?? null);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'policy.draft', entity: 'policy', entityId: String(v), after: body });
    return { version: v };
  });
  r.post('/api/admin/policy/:version/approve', ({ actor, params, body }) => {
    if (!has(actor, 'partner') && !has(actor, 'admin')) throw forbid();
    if (!body.note) throw bad('Record who at GB approved this policy and where');
    return tx(db, () => {
      const p = db.prepare('SELECT * FROM policy_versions WHERE tenant_id = ? AND version = ?').get(actor.tenantId, Number(params.version)); if (!p) throw notFound();
      db.prepare("UPDATE policy_versions SET status = 'superseded', effective_to = date(?, '-1 day') WHERE tenant_id = ? AND status = 'approved' AND version != ?").run(p.effective_from, actor.tenantId, p.version);
      db.prepare("UPDATE policy_versions SET status = 'approved', approved_by = ?, approved_at = ?, note = ? WHERE id = ?").run(actor.id, now(), body.note, p.id);
      audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'policy.approve', entity: 'policy', entityId: String(p.version), reason: body.note });
      return { ok: true };
    });
  });
  r.get('/api/admin/dashboard', ({ actor, ctx }) => { ops(actor);
    const cycleId = q(ctx, 'cycleId') || db.prepare("SELECT id FROM cycles WHERE tenant_id = ? AND status = 'open' ORDER BY year DESC LIMIT 1").get(actor.tenantId)?.id;
    const rows = db.prepare(`SELECT p.id, u.name, p.state, p.basis_status, r.name reviewer, pa.name partner, p.self_submitted_at, p.manager_submitted_at, p.released_at, p.acknowledged_at
        FROM plans p JOIN users u ON u.id = p.user_id LEFT JOIN users r ON r.id = p.reviewer_id LEFT JOIN users pa ON pa.id = p.partner_id WHERE p.cycle_id = ? AND p.tenant_id = ? ORDER BY u.name`).all(cycleId, actor.tenantId);
    const active = db.prepare('SELECT u.id, u.name FROM users u WHERE u.tenant_id = ? AND u.active = 1').all(actor.tenantId);
    const missing = active.filter((u) => !rows.find((x) => x.name === u.name) && !db.prepare("SELECT 1 FROM employments WHERE user_id = ? AND role_family IN ('partner','admin')").get(u.id));
    const by = rows.reduce((a, x) => ((a[x.state] = (a[x.state] || 0) + 1), a), {});
    // completion only — ratings are never shown on the admin dashboard
    return { cycleId, by_state: by, rows: rows.map((x) => ({ ...x, stateLabel: perf.STATE_LABEL[x.state] })), without_plan: missing, needs_basis_decision: rows.filter((x) => x.basis_status === 'unverified').length };
  });
  r.get('/api/admin/audit', ({ actor, ctx }) => { ops(actor);
    return db.prepare(`SELECT a.id, a.action, a.entity, a.entity_id, a.reason, a.at, u.name actor FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id WHERE a.tenant_id = ? ${q(ctx, 'entity') ? 'AND a.entity = ?' : ''} ORDER BY a.id DESC LIMIT 300`)
      .all(...[actor.tenantId, q(ctx, 'entity')].filter(Boolean));
  });
  r.post('/api/admin/grants', ({ actor, body }) => {
    if (!has(actor, 'partner')) throw forbid('Only a partner can grant review access');
    if (!body.reason) throw bad('Reason required');
    assertTenantUsers(db, actor, body.userId);
    const id = uid('grant_');
    db.prepare('INSERT INTO access_grants (id, tenant_id, user_id, scope, object_id, granted_by, reason, created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, actor.tenantId, body.userId, body.scope, body.objectId ?? null, actor.id, body.reason, now());
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'grant.create', entity: 'user', entityId: body.userId, reason: body.reason, after: body });
    return { id };
  });

  // -------------------------------------------------------------- imports --
  r.post('/api/imports/leaveboard', async ({ actor, ctx, raw }) => previewLeaveboard(db, actor, { filename: q(ctx, 'filename') || 'upload.xlsx', buffer: raw, reportingFrom: q(ctx, 'from'), reportingTo: q(ctx, 'to'), filtersNote: q(ctx, 'filters') }), { raw: true });
  r.post('/api/imports/pms-plans', async ({ actor, ctx, raw }) => previewPlans(db, actor, { filename: q(ctx, 'filename') || 'plans.xlsx', buffer: raw, sheetName: q(ctx, 'sheet'), cycleId: q(ctx, 'cycleId') }), { raw: true });
  r.post('/api/imports/pms-history', async ({ actor, ctx, raw }) => previewHistory(db, actor, { filename: q(ctx, 'filename') || 'history.xlsx', buffer: raw, sheetName: q(ctx, 'sheet') || 'PMS', year: Number(q(ctx, 'year')), precision: Number(q(ctx, 'precision') || 1) }), { raw: true });
  // several GB evaluation-form workbooks at once: JSON { cycleId, files: [{ filename, base64 }] }
  r.post('/api/imports/gb-forms', async ({ actor, raw }) => {
    const b = JSON.parse(raw.toString() || '{}');
    if (!Array.isArray(b.files) || !b.files.length) throw bad('Add at least one form');
    return previewGbForms(db, actor, { cycleId: b.cycleId, files: b.files.map((f) => ({ filename: String(f.filename), buffer: Buffer.from(String(f.base64), 'base64') })) });
  }, { raw: true });
  r.get('/api/imports', ({ actor }) => { ops(actor); return db.prepare('SELECT id, kind, filename, status, created_at, applied_at, reporting_from, reporting_to, generated_at FROM import_batches WHERE tenant_id = ? ORDER BY created_at DESC').all(actor.tenantId); });
  r.get('/api/imports/:id', ({ actor, params }) => getBatch(db, actor, params.id));
  r.post('/api/imports/:id/apply', ({ actor, params, body }) => {
    const b = getBatch(db, actor, params.id);
    if (b.kind.startsWith('leaveboard_')) return applyLeaveboard(db, actor, b.id, body);
    if (b.kind === 'pms_plans') return applyPlans(db, actor, b.id, body);
    if (b.kind === 'pms_history') return applyHistory(db, actor, b.id);
    if (b.kind === 'pms_gb_form') return applyGbForms(db, actor, b.id, body);
    throw bad('Unknown batch kind');
  });
  r.post('/api/imports/:id/reverse', ({ actor, params, body }) => reverseBatch(db, actor, params.id, body));
  r.post('/api/imports/:id/opening-balances', ({ actor, params, body }) => postOpeningBalances(db, actor, { batchId: params.id, cutover: body.cutover }));
  r.get('/api/imports/:id/reconcile', ({ actor, params }) => reconcile(db, actor, { batchId: params.id }));
  r.get('/api/imports-compare', ({ actor, ctx }) => compareSnapshots(db, actor, { batchA: q(ctx, 'a'), batchB: q(ctx, 'b') }));

  // ------------------------------------------------------------- projects --
  r.get('/api/projects', ({ actor }) => proj.registerView(db, actor));
  r.post('/api/projects', ({ actor, body }) => ({ id: proj.createProject(db, actor, body) }));
  r.post('/api/projects/:id/approve', ({ actor, params }) => { proj.approveProject(db, actor, params.id); return { ok: true }; });
  r.post('/api/projects/:id/assignments', ({ actor, params, body }) => ({ id: proj.addAssignment(db, actor, { ...body, projectId: params.id }) }));
  r.post('/api/assignments/:id/review', ({ actor, params, body }) => proj.confirmAssignment(db, actor, params.id, body));
  r.post('/api/projects/:id/deliverables', ({ actor, params, body }) => ({ id: proj.addDeliverable(db, actor, { ...body, projectId: params.id }) }));
  r.post('/api/deliverables/:id/contributions', ({ actor, params, body }) => ({ id: proj.claimContribution(db, actor, { ...body, deliverableId: params.id }) }));
  r.post('/api/contributions/:id/review', ({ actor, params, body }) => proj.reviewContribution(db, actor, params.id, body));

  // ------------------------------------------------------------------- AI --
  r.get('/api/ai/adoption', ({ actor }) => ai.adoptionSummary(db, actor));
  r.post('/api/ai/usage', ({ actor, body }) => ai.importUsage(db, actor, body));
  // raw Gemini log-events CSV; every active roster account counts as licensed so "no events" shows as zero
  r.post('/api/ai/gemini-log', ({ actor, raw }) => {
    if (!isOps(actor)) throw forbid();
    const licensed = db.prepare('SELECT email FROM users WHERE tenant_id = ? AND active = 1').all(actor.tenantId).map((u) => u.email);
    const dec = db.prepare("SELECT value_json FROM settings WHERE tenant_id = ? AND key = 'decisions'").get(actor.tenantId);
    return importGeminiLog(db, actor, { text: raw.toString('utf8'), licensedEmails: licensed, excludeEmails: dec ? JSON.parse(dec.value_json).exclude_people || [] : [], fileBuffer: raw });
  }, { raw: true });
  r.get('/api/ai/seats/mine', ({ actor }) => ai.mySeatAttributions(db, actor));
  r.post('/api/ai/seats/:id/confirm', ({ actor, params, body }) => ({ status: ai.confirmSeatAttribution(db, actor, params.id, body) }));
  r.post('/api/ai/examples', ({ actor, body }) => ({ id: ai.saveExample(db, actor, body) }));
  r.get('/api/ai/examples/mine', ({ actor }) => db.prepare('SELECT * FROM ai_examples WHERE user_id = ? ORDER BY created_at DESC').all(actor.id));

  // -------------------------------------------------------- notifications --
  r.get('/api/notifications/plan', ({ actor, ctx }) => ntf.planReminders(db, actor, { cycleId: q(ctx, 'cycleId'), asOf: q(ctx, 'asOf') || undefined }));
  r.post('/api/notifications/queue', ({ actor, body }) => ntf.planReminders(db, actor, { cycleId: body.cycleId, asOf: body.asOf, queue: true }));
  r.get('/api/notifications/outbox', ({ actor }) => ntf.outbox(db, actor));
  r.post('/api/notifications/deliver', async ({ actor }) => { if (!isOps(actor)) throw forbid(); return ntf.deliver(db, { tenantId: actor.tenantId, transport: ntf.fileTransport(process.env.OUTBOX_DIR || 'data/outbox') }); });

  return r;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
