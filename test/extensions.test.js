import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN, rateAll, withToday } from './helpers.js';
import * as proj from '../src/domain/projects.js';
import * as ai from '../src/domain/ai.js';
import * as perf from '../src/domain/performance.js';
import * as ntf from '../src/domain/notifications.js';

const PLAN = `plan_${SYN.emp}_2026`;

test('one deliverable, two distinct contributions validated by the project lead', () => {
  const { db, as } = fresh();
  const emp = as(SYN.emp); const senior = as(SYN.senior); const lead = as(SYN.lead);
  const c1 = proj.claimContribution(db, emp, { deliverableId: 'dlv_alpha_report', responsibility: 'analyst', description: 'Market sizing model', evidenceUrl: 'https://drive.example/model' });
  const c2 = proj.claimContribution(db, senior, { deliverableId: 'dlv_alpha_report', responsibility: 'author', description: 'Wrote chapters 2–4' });
  assert.throws(() => proj.reviewContribution(db, emp, c2, { decision: 'confirm' }), /project lead/);
  proj.reviewContribution(db, lead, c1, { decision: 'confirm' });
  proj.reviewContribution(db, lead, c2, { decision: 'correct', responsibility: 'reviewer', note: 'Sara reviewed; chapters were drafted by Leo' });
  const d = proj.registerView(db, lead)[0].deliverables.find((x) => x.id === 'dlv_alpha_report');
  assert.deepEqual(d.contributions.map((c) => [c.name, c.responsibility, c.status]).sort(), [['Eli Employee', 'analyst', 'confirmed'], ['Sara Senior', 'reviewer', 'corrected']]);
});

test('provisional assignment stays out of the confirmed record and the review', () => {
  const { db, as } = fresh();
  const reg = proj.registerView(db, as(SYN.ops)).find((p) => p.id === 'prj_beta');
  assert.ok(reg.team_unconfirmed.some((a) => a.user_id === SYN.emp));
  assert.ok(!reg.team_confirmed.some((a) => a.user_id === SYN.emp));
  const v = perf.planView(db, as(SYN.emp), PLAN);
  assert.ok(!v.projects.some((p) => p.project_id === 'prj_beta'));
  assert.ok(v.projects.some((p) => p.project_id === 'prj_alpha'));
  // ops cannot turn a lead into a confirmation
  const id = proj.addAssignment(db, as(SYN.ops), { projectId: 'prj_alpha', userId: SYN.peer, role: 'support', status: 'confirmed', source: 'handwritten allocation' });
  assert.equal(db.prepare('SELECT status FROM project_assignments WHERE id = ?').get(id).status, 'provisional');
  proj.confirmAssignment(db, as(SYN.lead), id, {});
  assert.equal(db.prepare('SELECT status FROM project_assignments WHERE id = ?').get(id).status, 'confirmed');
});

test('AI usage: missing / no access / zero kept distinct; usage changes never move the performance score', () => {
  const { db, as } = fresh();
  const ops = as(SYN.ops);
  // complete a review to get a manager score
  const emp = as(SYN.emp); const mgr = as(SYN.manager);
  let v = perf.planView(db, emp, PLAN);
  perf.saveSelf(db, emp, PLAN, { items: rateAll(v.items, 'self', 4) }); perf.submitSelf(db, emp, PLAN);
  v = perf.planView(db, mgr, PLAN);
  perf.saveManager(db, mgr, PLAN, { items: rateAll(v.items, 'manager', 4) });
  const before = perf.planView(db, mgr, PLAN).scores.manager;
  ai.importUsage(db, ops, { tool: 'gemini', report: 'user-level usage', windowFrom: '2026-10-01', windowTo: '2026-10-31', rows: [
    { account_email: 'eli@example.test', access: 'licensed', metric: 'active_days', value: 0 },
    { account_email: 'sara@example.test', access: 'licensed', metric: 'active_days', value: null },
    { account_email: 'adam@example.test', access: 'no_access', metric: 'active_days', value: null },
    { account_email: 'leo@example.test', access: 'licensed', metric: 'active_days', value: 14 },
    { account_email: 'ghost@elsewhere.test', access: 'licensed', metric: 'active_days', value: 3 }] });
  const s = ai.adoptionSummary(db, ops)[0];
  assert.deepEqual(s.accounts_by_state, { zero: 1, not_reported: 1, no_access: 1, active: 2 });
  assert.deepEqual(s.unmatched_accounts, ['ghost@elsewhere.test']);
  assert.equal(s.denominators.licensed, 4);
  ai.importUsage(db, ops, { tool: 'claude', report: 'analytics', windowFrom: '2026-10-01', windowTo: '2026-10-31', spendScope: 'extra usage only', rows: [{ account_email: 'eli@example.test', access: 'licensed', metric: 'requests', value: 900 }] });
  const after = perf.planView(db, mgr, PLAN).scores.manager;
  assert.deepEqual(after, before);
  assert.throws(() => ai.adoptionSummary(db, as(SYN.manager)), /Not permitted/);
});

test('shared seats: Drive/chat leads are candidates until the person confirms', () => {
  const { db, as } = fresh();
  const n = ai.importSeatCandidates(db, as(SYN.ops), [
    { seat_email: 'leo@example.test', engagement: 'Alpha', candidate_name: 'Leo Lead', candidate_email: 'leo@example.test', evidence_type: 'account_holder', confidence: 'high' },
    { seat_email: 'leo@example.test', engagement: 'Alpha', candidate_name: 'Eli Employee', candidate_email: 'eli@example.test', evidence_type: 'chat_title_tag', confidence: 'medium' },
    { seat_email: 'leo@example.test', engagement: 'Alpha', candidate_name: 'Eli Employee', candidate_email: 'eli@example.test', evidence_type: 'chat_title_tag', confidence: 'medium' }], { source: 'test' });
  assert.equal(n, 2); // duplicate ignored
  const mine = ai.mySeatAttributions(db, as(SYN.emp));
  assert.equal(mine[0].status, 'candidate');
  assert.throws(() => ai.confirmSeatAttribution(db, as(SYN.peer), mine[0].id, { decision: 'confirm' }), /Not permitted/);
  ai.confirmSeatAttribution(db, as(SYN.emp), mine[0].id, { decision: 'confirm' });
  assert.equal(ai.mySeatAttributions(db, as(SYN.emp))[0].status, 'confirmed');
});

test('private AI examples: coworkers and admins without a grant cannot read them', () => {
  const { db, as } = fresh();
  const item = perf.planView(db, as(SYN.emp), PLAN).items[0];
  assert.throws(() => ai.saveExample(db, as(SYN.emp), { task: 'x', tool: 'Claude', verification: 'y', timeSavedEstimate: '3h' }), /basis/);
  const id = ai.saveExample(db, as(SYN.emp), { task: 'Benchmark 12 foundations', tool: 'Claude', why: 'Long documents', verification: 'Checked every figure against annual reports', timeSavedEstimate: '4 hours', estimateBasis: 'Previous benchmark took 1 day', linkedPlanItemId: item.id, submit: true });
  assert.ok(ai.getExample(db, as(SYN.emp), id));
  assert.ok(ai.getExample(db, as(SYN.manager), id)); // reviewer, linked to their reviewee's objective
  for (const who of [SYN.peer, SYN.ops, SYN.unrelated, SYN.otherUser]) assert.throws(() => ai.getExample(db, as(who), id), /Not permitted/);
  assert.throws(() => ai.saveExample(db, as(SYN.peer), { task: 'x', tool: 'Claude', verification: 'y', linkedPlanItemId: item.id }), /own plan/);
});

test('reminders: test inbox, cadence in business days, dedupe, retry and suppression after completion', async () => {
  const { db, as } = fresh();
  const ops = as(SYN.ops);
  // self due 2026-12-10 (Thu). 3 business days before = Mon 2026-12-07; overdue from Sun 2026-12-13
  let p = ntf.planReminders(db, ops, { cycleId: 'cyc_2026', asOf: '2026-12-01' });
  assert.ok(p.items.every((i) => i.event === 'launch'));
  assert.ok(p.items.every((i) => !/rating|score/i.test(i.body)));
  p = ntf.planReminders(db, ops, { cycleId: 'cyc_2026', asOf: '2026-12-07', queue: true });
  assert.ok(p.items.some((i) => i.event === 'due_soon'));
  const queued = db.prepare("SELECT * FROM notification_outbox WHERE status = 'queued'").all();
  assert.ok(queued.every((q) => q.to_email === 'prism-test-inbox@example.test' && q.mode === 'test'));
  assert.equal(ntf.planReminders(db, ops, { cycleId: 'cyc_2026', asOf: '2026-12-07', queue: true }).items.length, 0); // dedupe
  // Eli submits before delivery → his reminders are suppressed
  const emp = as(SYN.emp);
  const v = perf.planView(db, emp, PLAN);
  perf.saveSelf(db, emp, PLAN, { items: rateAll(v.items, 'self', 3) });
  perf.submitSelf(db, emp, PLAN);
  let calls = 0; const sent = [];
  const flaky = async (m) => { calls++; if (calls === 1) throw new Error('SMTP 451 temporary'); sent.push(m); };
  const r1 = await ntf.deliver(db, { tenantId: 'gb', transport: flaky, nowIso: '2026-12-07T07:00:00Z' });
  assert.equal(r1.failed, 1);
  assert.ok(r1.suppressed >= 1);
  const r2 = await ntf.deliver(db, { tenantId: 'gb', transport: flaky, nowIso: '2026-12-07T08:00:00Z' });
  assert.equal(r2.sent, 1); // retry succeeded
  const r3 = await ntf.deliver(db, { tenantId: 'gb', transport: flaky, nowIso: '2026-12-07T09:00:00Z' });
  assert.deepEqual(r3, { sent: 0, failed: 0, suppressed: 0 });
  const eliRows = db.prepare("SELECT status FROM notification_outbox WHERE recipient_id = ?").all(SYN.emp);
  assert.ok(eliRows.every((r) => r.status === 'suppressed'));
  // manager reminder now appears for the submitted review
  assert.ok(ntf.planReminders(db, ops, { cycleId: 'cyc_2026', asOf: '2026-12-08' }).items.some((i) => i.event === 'manager_review' && i.recipient_id === SYN.manager));
});

test('Gemini log events: active vs passive kept apart, IP data dropped, licensed accounts without events are zero', async () => {
  const { importGeminiLog, summariseGeminiLog } = await import('../src/imports/gemini.js');
  const ai = await import('../src/domain/ai.js');
  const { db, as } = fresh();
  const csv = '﻿Date,Event,Description,Actor,App name,Feature source,Action,Event category,Network info\n'
    + '2026-11-14T10:00:00+03:00,Feature utilization,x,eli@example.test,Gmail,Help me schedule,detect_schedule_intent_compose,Inactive,"{""IP"": ""1.2.3.4""}"\n'
    + '2026-11-15T10:00:00+03:00,Feature utilization,x,eli@example.test,Slides,Side panel,edit_slide,Active generate,"{""IP"": ""1.2.3.4""}"\n'
    + '2026-11-16T10:00:00+03:00,Feature utilization,x,leo@example.test,Gemini App,,conversation,Active conversations,\n'
    + '2026-11-16T11:00:00+03:00,Feature utilization,x,adam@example.test,Gmail,Help me write,auto_proofread,Inactive,\n';
  const s = summariseGeminiLog(csv);
  assert.equal(JSON.stringify(s).includes('1.2.3.4'), false);
  assert.deepEqual([s.windowFrom, s.windowTo], ['2026-11-14', '2026-11-16']);
  importGeminiLog(db, as(SYN.ops), { text: csv, licensedEmails: ['eli@example.test', 'leo@example.test', 'sara@example.test'] });
  const sum = ai.adoptionSummary(db, as(SYN.ops))[0];
  assert.deepEqual(sum.accounts_by_state, { active: 2, zero: 2 }); // adam: passive only → zero
  assert.equal(sum.metrics.find((m) => m.metric === 'passive_events').total, 2);
});
