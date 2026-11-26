import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN } from './helpers.js';
import * as com from '../src/domain/commercial.js';
import * as staff from '../src/domain/staffing.js';
import * as pipe from '../src/domain/pipeline.js';
import * as srv from '../src/domain/surveys.js';
import * as life from '../src/domain/lifecycle.js';
import * as clo from '../src/domain/closeout.js';
import { applyLibrary, strategyView } from '../src/domain/library.js';

const hours = (db, user, project, month, h) => db.prepare("INSERT INTO timesheet_entries (id, tenant_id, user_id, month, work_date, code, project_id, hours_x100, source) VALUES (?,?,?,?,?,?,?,?, 'manual')")
  .run(`t_${user}_${month}_${h}`, SYN.tenant, user, month, `${month}-02`, `p:${project}`, project, h * 100);

test('commercial: partners only; burn, cost from level rates, margin, milestones; leads see hours only; alerts once per threshold', () => {
  const { db, as } = fresh();
  const P = as(SYN.partner);
  assert.throws(() => com.portfolio(db, as(SYN.ops)), /partners only/);
  assert.throws(() => com.saveBudget(db, as(SYN.lead), 'prj_alpha', { fee: 1000 }), /partners only/);
  com.saveBudget(db, P, 'prj_alpha', { billing: 'fixed', fee: '20000', budget_hours: '100' });
  const level = db.prepare('SELECT title FROM employments WHERE user_id = ? AND effective_to IS NULL').get(SYN.emp).title;
  com.saveCostRates(db, P, [{ level, hourly: '40', target_pct: 80 }]);
  hours(db, SYN.emp, 'prj_alpha', '2026-03', 80);
  const f = com.projectFinance(db, P, 'prj_alpha');
  assert.equal(f.burn_pct, 80); assert.equal(f.alert, 'warning');
  assert.equal(f.cost_x100, 320000); assert.equal(f.margin_x100, 2000000 - 320000);
  const lead = com.projectFinance(db, as(SYN.lead), 'prj_alpha', { forLead: true });
  assert.equal(lead.burn_pct, 80); assert.equal(lead.fee_x100, undefined, 'a lead never sees the fee'); assert.equal(lead.margin_x100, undefined);
  assert.throws(() => com.projectFinance(db, as(SYN.emp), 'prj_alpha', { forLead: true }), /Not permitted/);
  const { id: m } = com.saveMilestone(db, P, 'prj_alpha', null, { title: 'Inception 30%', amount: '6000', due_on: '2026-01-15' });
  com.saveMilestone(db, P, 'prj_alpha', m, { title: 'Inception 30%', amount: '6000', due_on: '2026-01-15', status: 'invoiced' });
  const f2 = com.projectFinance(db, P, 'prj_alpha');
  assert.equal(f2.outstanding_x100, 600000); assert.equal(f2.overdue_x100, 600000);
  const sent = [];
  com.checkBurnAlerts(db, SYN.tenant, (_db, n) => sent.push(n));
  com.checkBurnAlerts(db, SYN.tenant, (_db, n) => sent.push(n));
  assert.equal(sent.filter((n) => n.link?.startsWith('#/commercial')).length, 1, 'partners alerted once at 75%');
  hours(db, SYN.emp, 'prj_alpha', '2026-04', 25);
  com.checkBurnAlerts(db, SYN.tenant, (_db, n) => sent.push(n));
  assert.ok(sent.some((n) => /105%/.test(n.subject)), 'and again when it goes over 100%');
  assert.ok(com.portfolio(db, P).at_risk.includes('Project Alpha — strategy'));
});

test('resource calendar: everyone sees availability; allocations and bookings; over-booking flagged', () => {
  const { db, as } = fresh();
  db.prepare("UPDATE project_assignments SET start_date = '2026-01-01', end_date = '2027-12-31' WHERE id IN ('asg_emp_alpha','asg_emp_beta')").run();
  db.prepare("UPDATE projects SET start_date = '2026-01-01', end_date = '2027-12-31'").run();
  const v = staff.calendar(db, as(SYN.peer), { from: '2026-12-06' });
  assert.equal(v.weeks.length, 12);
  const emp = v.people.find((p) => p.id === SYN.emp);
  assert.ok(emp.weeks[0].items.every((i) => i.estimated), 'no allocation yet: estimated split');
  assert.equal(emp.utilisation, undefined, 'colleagues do not see someone else’s utilisation');
  assert.throws(() => staff.setAllocation(db, as(SYN.emp), 'asg_emp_alpha', 60), /Not permitted/);
  staff.setAllocation(db, as(SYN.lead), 'asg_emp_alpha', 60);
  staff.saveBooking(db, as(SYN.ops), null, { user_id: SYN.emp, label: 'Internal tender', start_date: '2026-12-06', end_date: '2026-12-31', pct: 70, status: 'confirmed' });
  assert.throws(() => staff.saveBooking(db, as(SYN.ops), null, { user_id: SYN.emp, label: 'x', start_date: '2026-12-06', end_date: '2026-12-01', pct: 50 }), /valid start and end/);
  const v2 = staff.calendar(db, as(SYN.partner), { from: '2026-12-06' });
  const c = v2.people.find((p) => p.id === SYN.emp).weeks[0];
  assert.ok(c.over, `over-booked: ${c.booked}% of ${c.available}%`);
  assert.ok(v2.summary.over.includes(v2.people.find((p) => p.id === SYN.emp).name));
});

test('pipeline: partners add; owners see their own; stage drives the outcome; won becomes a project with the booked team', () => {
  const { db, as } = fresh();
  assert.throws(() => pipe.saveOpportunity(db, as(SYN.emp), null, { title_en: 'x', clientName: 'Acme' }), /Ask a partner/);
  const { id } = pipe.saveOpportunity(db, as(SYN.partner), null, { clientName: 'Acme Bank', title_en: 'Strategy 2027–2031', value: '50000', owner_user_id: SYN.senior, next_step: 'Call the CEO', next_step_on: '2020-01-01' });
  assert.equal(pipe.pipelineView(db, as(SYN.emp)).rows.length, 0, 'not the owner: nothing shown');
  const mine = pipe.pipelineView(db, as(SYN.senior));
  assert.equal(mine.rows.length, 1); assert.equal(mine.rows[0].weighted_x100, 500000); assert.equal(mine.totals.overdue_next_steps, 1);
  assert.equal(pipe.overdueSteps(db, as(SYN.senior)).length, 1);
  pipe.saveOpportunity(db, as(SYN.senior), id, { stage: 'negotiation' });
  assert.equal(db.prepare('SELECT outcome, probability FROM proposals WHERE id = ?').get(id).outcome, 'submitted');
  assert.throws(() => pipe.saveOpportunity(db, as(SYN.partner), id, { stage: 'lost' }), /why it was lost/);
  staff.saveBooking(db, as(SYN.partner), null, { user_id: SYN.emp, proposal_id: id, start_date: '2027-01-03', end_date: '2027-03-31', pct: 50 });
  pipe.saveOpportunity(db, as(SYN.partner), id, { stage: 'won', expected_start: '2027-01-03' });
  const r = pipe.convertToProject(db, as(SYN.partner), id);
  assert.ok(r.project_id);
  assert.equal(db.prepare('SELECT lead_user_id FROM projects WHERE id = ?').get(r.project_id).lead_user_id, SYN.senior);
  assert.ok(db.prepare("SELECT 1 FROM engagements WHERE project_id = ? AND status = 'running'").get(r.project_id));
  assert.equal(db.prepare('SELECT status FROM resource_bookings WHERE project_id = ?').get(r.project_id).status, 'confirmed');
  assert.ok(db.prepare('SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ?').get(r.project_id, SYN.emp));
  assert.equal(pipe.convertToProject(db, as(SYN.partner), id).existing, true);
});

test('surveys: client link answered once without sign-in; pulse anonymous with a 3-answer threshold; KPIs', () => {
  const { db, as } = fresh();
  assert.throws(() => srv.createClientSurvey(db, as(SYN.emp), { project_id: 'prj_alpha' }), /Not permitted/);
  const c = srv.createClientSurvey(db, as(SYN.lead), { project_id: 'prj_alpha', contact_name: 'Rania', contact_email: 'rania@client.test' });
  assert.equal(srv.surveyByToken(db, 'not-a-real-token-value-123'), null);
  assert.throws(() => srv.answerClientSurvey(db, c.token, { quality: 7 }), /choose a value/);
  srv.answerClientSurvey(db, c.token, { overall: 5, quality: 4, nps: 9 }, 'Great team');
  assert.throws(() => srv.answerClientSurvey(db, c.token, { overall: 1 }), /already been answered/);
  assert.throws(() => srv.openPulse(db, as(SYN.emp), {}), /Not permitted/);
  const { id } = srv.openPulse(db, as(SYN.ops), { title: 'Pulse Q4' });
  srv.answerPulse(db, as(SYN.emp), id, { enps: 9, workload: 2 }, 'More focus time please');
  assert.throws(() => srv.answerPulse(db, as(SYN.emp), id, { enps: 9 }), /already answered/);
  assert.equal(srv.surveysView(db, as(SYN.ops)).pulses[0].results, null, 'hidden below three answers');
  srv.answerPulse(db, as(SYN.senior), id, { enps: 6 }); srv.answerPulse(db, as(SYN.peer), id, { enps: 10 });
  const p = srv.surveysView(db, as(SYN.ops)).pulses[0];
  assert.equal(p.results.enps.nps, 33); assert.deepEqual(p.comments, ['More focus time please']);
  assert.equal(srv.surveysView(db, as(SYN.emp)).pulses[0].results, null, 'employees never see results');
  const cols = db.prepare('PRAGMA table_info(survey_responses)').all().map((x) => x.name);
  assert.ok(!cols.includes('user_id'), 'answers carry no user');
  const k = srv.surveyKpis(db, SYN.tenant);
  assert.equal(k.quality.avg, 4); assert.equal(k.nps.nps, 100); assert.equal(k.pulse.enps.nps, 33);
});

test('offboarding and training: owners tick their steps; completing switches the account off; training privacy', () => {
  const { db, as } = fresh();
  assert.throws(() => life.startOffboarding(db, as(SYN.emp), { user_id: SYN.peer, last_day: '2026-12-31' }), /Not permitted/);
  const { id } = life.startOffboarding(db, as(SYN.ops), { user_id: SYN.emp, last_day: '2026-12-31', kind: 'resignation' });
  const steps = life.offboardingView(db, as(SYN.emp)).items[0].steps;
  const mine = steps.find((s) => s.owner === 'leaver'); const hr = steps.find((s) => s.owner === 'hr');
  life.tickOffboardingStep(db, as(SYN.emp), mine.id, true);
  assert.throws(() => life.tickOffboardingStep(db, as(SYN.emp), hr.id, true), /Not permitted/);
  assert.throws(() => life.completeOffboarding(db, as(SYN.ops), id), /still open/);
  for (const s of steps) life.tickOffboardingStep(db, as(SYN.ops), s.id, true);
  life.completeOffboarding(db, as(SYN.ops), id);
  assert.equal(db.prepare('SELECT active FROM users WHERE id = ?').get(SYN.emp).active, 0);
  const t = life.saveTraining(db, as(SYN.senior), null, { title: 'PMP', kind: 'certification', hours: '35', expires_on: '2026-12-01' });
  assert.throws(() => life.trainingView(db, as(SYN.peer), SYN.senior), /Not permitted/);
  assert.throws(() => life.verifyTraining(db, as(SYN.senior), t.id), /Not permitted/);
  life.verifyTraining(db, as(SYN.ops), t.id);
  const sent = []; life.remindExpiringCertificates(db, SYN.tenant, (_db, n) => sent.push(n));
  assert.equal(sent[0].to, SYN.senior);
});

test('close-outs: team writes them, assets need Drive links, everyone reads the toolkit, KPI counts them', () => {
  const { db, as } = fresh();
  applyLibrary(db, as(SYN.ops), { clients: [{ key: 'acme', name_en: 'Acme' }], engagements: [{ key: 'e1', client: 'acme', title_en: 'Strategy', status: 'completed', year_from: 2025, project: 'Project Alpha — strategy' }] });
  const e = db.prepare("SELECT id FROM engagements WHERE key = 'e1'").get().id;
  assert.equal(clo.knowledgeKpi(db, SYN.tenant).pct, 0);
  assert.equal(clo.missingCloseouts(db, as(SYN.lead)).length, 1);
  assert.throws(() => clo.saveCloseout(db, as(SYN.peer), e, { went_well: 'x' }), /Not permitted/);
  assert.throws(() => clo.saveCloseout(db, as(SYN.emp), e, { went_well: 'x', assets: [{ title: 'KPI dictionary', kind: 'template', drive_url: 'https://evil.test/x' }] }), /Drive link/);
  clo.saveCloseout(db, as(SYN.emp), e, { went_well: 'Weekly steering', to_improve: 'Earlier data request', assets: [{ title: 'KPI dictionary', kind: 'template', drive_url: 'https://docs.google.com/spreadsheets/d/abc' }] });
  assert.equal(clo.toolkit(db, as(SYN.peer))[0].title, 'KPI dictionary');
  assert.equal(clo.knowledgeKpi(db, SYN.tenant).pct, 100);
  const kpis = strategyView(db, as(SYN.partner));
  assert.ok(kpis.kpis.length >= 0);
});
