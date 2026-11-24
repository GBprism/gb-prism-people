import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN, rateAll } from './helpers.js';
import * as perf from '../src/domain/performance.js';
import { planAccess } from '../src/domain/authz.js';

const PLAN = `plan_${SYN.emp}_2026`;

function runToCalibration(db, as, planId = PLAN) {
  const emp = as(SYN.emp); const mgr = as(SYN.manager);
  let v = perf.planView(db, emp, planId);
  perf.saveSelf(db, emp, planId, { items: rateAll(v.items, 'self', 4), summary: { strongest_outcomes: 'Shipped Alpha', proposed_goals: 'Lead a workstream' } });
  perf.submitSelf(db, emp, planId);
  v = perf.planView(db, mgr, planId);
  perf.saveManager(db, mgr, planId, { items: rateAll(v.items, 'manager', 3), summary: { strengths: ['Reliable analysis'], gaps: ['Client communication'], next_action: 'Present at next steering committee' } });
  perf.submitManager(db, mgr, planId);
}

test('2026 review end to end: self → manager → calibration → released → acknowledged → closed', () => {
  const { db, as } = fresh();
  const emp = as(SYN.emp); const mgr = as(SYN.manager); const partner = as(SYN.partner);
  // incomplete self-assessment cannot be submitted
  perf.saveSelf(db, emp, PLAN, { items: [] });
  assert.throws(() => perf.submitSelf(db, emp, PLAN), /complete these/);
  runToCalibration(db, as);
  let v = perf.planView(db, partner, PLAN);
  assert.equal(v.state, 'partner_calibration');
  assert.equal(v.scores.manager.rounded, 3);
  // calibration change needs a reason and is shown against the original
  const item = v.items[0];
  assert.throws(() => perf.calibrateItem(db, partner, PLAN, item.id, { calibrated_rating: 4 }), /needs a reason/);
  perf.calibrateItem(db, partner, PLAN, item.id, { calibrated_rating: 4, reason: 'Evidence from project lead shows stronger delivery' });
  v = perf.planView(db, partner, PLAN);
  assert.equal(v.items[0].manager_rating, 3);
  assert.equal(v.items[0].calibrated_rating, 4);
  assert.equal(v.scores.self.rounded, 4); // self stays independent
  perf.release(db, partner, PLAN, { note: 'Calibrated' });
  // consultant template: objective 50/50 → (4*.5+3*.5)=3.5 ; comp 3 ; init 3 → 3.5*.4 + 3*.4 + 3*.2 = 3.2
  v = perf.planView(db, emp, PLAN);
  assert.equal(v.outcome.final_score, 3.2);
  assert.ok(v.outcome.math.length > 2);
  assert.throws(() => perf.closePlan(db, mgr, PLAN), /Not allowed/);
  perf.acknowledge(db, emp, PLAN, { comment: 'Received; I would like to discuss the client item' });
  assert.throws(() => perf.closePlan(db, mgr, PLAN), /development action/);
  perf.addDevelopmentAction(db, mgr, PLAN, { kind: 'improvement', title: 'Lead one client presentation', ownerId: SYN.emp, dueDate: '2027-03-31' });
  perf.closePlan(db, mgr, PLAN);
  v = perf.planView(db, emp, PLAN);
  assert.equal(v.state, 'closed');
  assert.deepEqual(v.transitions.map((t) => t.to_state), ['self_assessment', 'manager_review', 'partner_calibration', 'released', 'acknowledged', 'closed']);
});

test('employee does not see manager ratings before release; manager does not see self-assessment before submission', () => {
  const { db, as } = fresh();
  const emp = as(SYN.emp); const mgr = as(SYN.manager);
  const before = perf.planView(db, mgr, PLAN);
  perf.saveSelf(db, emp, PLAN, { items: rateAll(before.items, 'self', 5) });
  assert.equal(perf.planView(db, mgr, PLAN).items[0].self_rating, undefined);
  runToCalibration(db, as);
  const ve = perf.planView(db, emp, PLAN);
  assert.equal(ve.items[0].manager_rating, undefined);
  assert.equal(ve.scores.manager, undefined);
  assert.equal(ve.summary.manager, undefined);
});

test('returns need reasons and go back one stage', () => {
  const { db, as } = fresh();
  const emp = as(SYN.emp); const mgr = as(SYN.manager); const partner = as(SYN.partner);
  const v = perf.planView(db, emp, PLAN);
  perf.saveSelf(db, emp, PLAN, { items: rateAll(v.items, 'self', 4) });
  perf.submitSelf(db, emp, PLAN);
  assert.throws(() => perf.returnPlan(db, mgr, PLAN, {}), /reason/);
  perf.returnPlan(db, mgr, PLAN, { reason: 'Please attach evidence for the traceability objective' });
  assert.equal(perf.getPlan(db, PLAN).state, 'self_assessment');
  runToCalibration(db, as);
  perf.returnPlan(db, partner, PLAN, { reason: 'Rationale missing for competency 2' });
  assert.equal(perf.getPlan(db, PLAN).state, 'manager_review');
});

test('reopen after release is restricted, needs a reason, and keeps a snapshot', () => {
  const { db, as } = fresh();
  runToCalibration(db, as);
  const partner = as(SYN.partner);
  perf.release(db, partner, PLAN);
  assert.throws(() => perf.reopen(db, as(SYN.manager), PLAN, { reason: 'x' }), /partner|granted/i);
  assert.throws(() => perf.reopen(db, as(SYN.ops), PLAN, { reason: 'x' }), /Not permitted|partner/); // ops without grant
  assert.throws(() => perf.reopen(db, partner, PLAN, {}), /reason/);
  perf.reopen(db, partner, PLAN, { reason: 'Attribution error on Project Alpha confirmed by lead' });
  const p = perf.getPlan(db, PLAN);
  assert.equal(p.state, 'manager_review');
  assert.equal(p.final_score, null);
  const revs = perf.planView(db, as(SYN.manager), PLAN).revisions;
  assert.ok(revs.some((r) => /Before reopen/.test(r.note)));
});

test('concurrent transition: second action on a stale row fails', () => {
  const { db, as } = fresh();
  const emp = as(SYN.emp);
  const v = perf.planView(db, emp, PLAN);
  perf.saveSelf(db, emp, PLAN, { items: rateAll(v.items, 'self', 4) });
  perf.submitSelf(db, emp, PLAN);
  assert.throws(() => perf.submitSelf(db, emp, PLAN), /Not allowed/);
});

test('N/A proposed by employee must be approved by manager before scoring', () => {
  const { db, as } = fresh();
  const emp = as(SYN.emp); const mgr = as(SYN.manager);
  const v = perf.planView(db, emp, PLAN);
  const init = v.items.find((i) => i.category === 'initiative');
  const edits = rateAll(v.items.filter((i) => i.id !== init.id), 'self', 4);
  edits.push({ id: init.id, propose_na: true, na_reason: 'Initiative paused by firm' });
  perf.saveSelf(db, emp, PLAN, { items: edits });
  perf.submitSelf(db, emp, PLAN);
  const mv = perf.planView(db, mgr, PLAN);
  perf.saveManager(db, mgr, PLAN, { items: rateAll(mv.items.filter((i) => i.id !== init.id), 'manager', 4) });
  assert.throws(() => perf.submitManager(db, mgr, PLAN), (e) => e.details.some((d) => /awaiting approval/.test(d)));
  perf.approveNa(db, mgr, PLAN, init.id);
  perf.submitManager(db, mgr, PLAN);
  const s = perf.planView(db, as(SYN.partner), PLAN).scores.final;
  assert.equal(s.rounded, 4);
  assert.ok(s.redistributions.length);
});

test('permission boundaries: peer, unrelated manager, people ops, other tenant', () => {
  const { db, as } = fresh();
  runToCalibration(db, as);
  const plan = perf.getPlan(db, PLAN);
  for (const who of [SYN.peer, SYN.unrelated, SYN.ops, SYN.senior]) {
    assert.equal(planAccess(db, as(who), plan), null, `${who} must not see the review`);
    assert.throws(() => perf.planView(db, as(who), PLAN), /Not permitted/);
  }
  assert.equal(planAccess(db, as(SYN.otherUser), plan), null);
  // partner sees only from calibration on; before that, nothing
  const { db: db2, as: as2 } = fresh();
  assert.equal(planAccess(db2, as2(SYN.partner), perf.getPlan(db2, PLAN)), null);
});

test('project lead feedback is limited to the invited assignment', () => {
  const { db, as } = fresh();
  const emp = as(SYN.emp); const mgr = as(SYN.manager); const lead = as(SYN.lead);
  const v = perf.planView(db, emp, PLAN);
  perf.saveSelf(db, emp, PLAN, { items: rateAll(v.items, 'self', 4) });
  perf.submitSelf(db, emp, PLAN);
  assert.throws(() => perf.addProjectFeedback(db, lead, PLAN, { assignmentId: 'asg_emp_alpha', body: 'x' }), /invited/);
  assert.throws(() => perf.inviteProjectFeedback(db, mgr, PLAN, 'asg_senior_alpha'), /not this employee/);
  perf.inviteProjectFeedback(db, mgr, PLAN, 'asg_emp_alpha');
  const lv = perf.planView(db, lead, PLAN);
  assert.equal(lv.access.relation, 'project_lead');
  assert.equal(lv.items, undefined); // no plan body, ratings or other feedback
  perf.addProjectFeedback(db, lead, PLAN, { assignmentId: 'asg_emp_alpha', body: 'Built the market model; QA found two minor issues', evidenceUrl: 'https://drive.example/model' });
  assert.equal(perf.planView(db, mgr, PLAN).project_feedback.length, 1);
  assert.equal(perf.planView(db, emp, PLAN).project_feedback, undefined);
});

test('2027 plan from role defaults with selected carry-forward; fresh targets and approval required', () => {
  const { db, as } = fresh();
  runToCalibration(db, as);
  const partner = as(SYN.partner); const mgr = as(SYN.manager); const emp = as(SYN.emp);
  perf.release(db, partner, PLAN);
  perf.acknowledge(db, emp, PLAN, {});
  const act = perf.addDevelopmentAction(db, mgr, PLAN, { kind: 'improvement', title: 'Client communication', ownerId: SYN.emp, dueDate: '2027-06-30' });
  perf.closePlan(db, mgr, PLAN);
  const old = perf.planView(db, emp, PLAN);
  const keep = old.items.find((i) => i.title === 'Data traceability');
  const p27 = perf.createPlan(db, emp, { cycleId: 'cyc_2027', userId: SYN.emp, reviewerId: SYN.manager, partnerId: SYN.partner, templateId: 'tpl_consultant', carryItemIds: [keep.id], carryActionIds: [act] });
  let v = perf.planView(db, emp, p27.id);
  const carried = v.items.find((i) => i.carried_from_item_id === keep.id);
  assert.ok(carried);
  assert.equal(carried.weight, null);
  assert.equal(carried.target, null);
  assert.throws(() => perf.approvePlan(db, mgr, p27.id), /cannot be approved/);
  // employee sets fresh targets & weights; rebalance
  const upserts = v.items.map((i) => ({ id: i.id, weight: i.category === 'objective' ? (i.id === carried.id ? 34 : 33) : i.category === 'competency' ? (i.title === 'Client communication' ? 34 : 33) : 100, target: i.category === 'objective' ? '≥95% traced' : i.target }));
  perf.editDraft(db, emp, p27.id, { upsertItems: upserts });
  v = perf.planView(db, emp, p27.id);
  const objSum = v.items.filter((i) => i.category === 'objective').reduce((a, i) => a + i.weight, 0);
  assert.equal(objSum, 100);
  perf.approvePlan(db, mgr, p27.id, { note: 'Agreed in 1:1' });
  assert.equal(perf.getPlan(db, p27.id).state, 'approved_plan');
  // approved 2026 review remains closed and unchanged
  assert.equal(perf.getPlan(db, PLAN).state, 'closed');
  assert.throws(() => perf.saveSelf(db, emp, PLAN, { items: [] }), /Not allowed/);
});

test('split review: section reviewers rate only their sections, invited seniors give input only, lead submits', () => {
  const { db, as } = fresh();
  const emp = as(SYN.emp); const mgr = as(SYN.manager); const sara = as(SYN.senior); const leo = as(SYN.lead);
  perf.setCategoryReviewer(db, as(SYN.ops), PLAN, { category: 'objective', userId: SYN.senior });
  assert.throws(() => perf.setCategoryReviewer(db, as(SYN.peer), PLAN, { category: 'competency', userId: SYN.peer }), /Not permitted/);
  perf.inviteInput(db, mgr, PLAN, { inviteeId: SYN.lead, label: 'Project feedback (primary senior)' });
  let v = perf.planView(db, emp, PLAN);
  perf.saveSelf(db, emp, PLAN, { items: rateAll(v.items, 'self', 4) });
  perf.submitSelf(db, emp, PLAN);
  const all = perf.planView(db, mgr, PLAN).items;
  const obj = all.filter((i) => i.category === 'objective'); const rest = all.filter((i) => i.category !== 'objective');
  assert.throws(() => perf.saveManager(db, mgr, PLAN, { items: rateAll(obj, 'manager', 3) }), /Another reviewer/);
  assert.throws(() => perf.saveManager(db, sara, PLAN, { items: rateAll(rest, 'manager', 3) }), /Another reviewer/);
  assert.throws(() => perf.saveManager(db, sara, PLAN, { summary: { strengths: ['x'] } }), /lead reviewer/);
  perf.saveManager(db, sara, PLAN, { items: rateAll(obj, 'manager', 5) });
  perf.saveManager(db, mgr, PLAN, { items: rateAll(rest, 'manager', 3) });
  const sv = perf.planView(db, sara, PLAN);
  assert.equal(sv.access.relation, 'category_reviewer');
  assert.equal(sv.items.find((i) => i.category === 'objective').self_rating, 4); // sees the self-assessment after submission
  // invited senior: own note only
  const lv = perf.planView(db, leo, PLAN);
  assert.equal(lv.access.relation, 'input');
  assert.equal(lv.items, undefined);
  perf.addInput(db, leo, PLAN, { body: 'Strong analysis on Alpha; needs to own client calls' });
  assert.throws(() => perf.addInput(db, as(SYN.peer), PLAN, { body: 'x' }), /not invited/);
  assert.equal(perf.planView(db, mgr, PLAN).inputs.length, 1);
  assert.equal(perf.planView(db, emp, PLAN).inputs, undefined); // employee does not see raw input
  assert.throws(() => perf.submitManager(db, sara, PLAN), /lead reviewer/);
  perf.submitManager(db, mgr, PLAN);
  // consultant: objectives 40% (5) + competencies 40% (3) + initiative 20% (3) = 3.8
  assert.equal(perf.planView(db, as(SYN.partner), PLAN).scores.manager.rounded, 3.8);
  assert.equal(planAccess(db, as(SYN.peer), perf.getPlan(db, PLAN)), null);
});

test('input requests: lead reviewer can withdraw an unanswered one; answered input stays', () => {
  const { db, as } = fresh();
  const mgr = as(SYN.manager);
  perf.inviteInput(db, mgr, PLAN, { inviteeId: SYN.senior, label: 'Project feedback' });
  perf.inviteInput(db, mgr, PLAN, { inviteeId: SYN.am, label: 'Assistant Manager review' });
  assert.throws(() => perf.removeInputInvite(db, as(SYN.peer), PLAN, { inviteeId: SYN.senior }), /Not permitted/);
  assert.equal(perf.removeInputInvite(db, mgr, PLAN, { inviteeId: SYN.senior, reason: 'did not work together' }), true);
  perf.addInput(db, as(SYN.am), PLAN, { body: 'Solid analysis on Alpha' });
  assert.throws(() => perf.removeInputInvite(db, mgr, PLAN, { inviteeId: SYN.am }), /already given/);
  assert.deepEqual(perf.planView(db, mgr, PLAN).input_invites.map((i) => i.name), ['Adam Assistant']);
});
