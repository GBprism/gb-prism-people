import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN } from './helpers.js';
import * as pc from '../src/domain/perf/cycle.js';
import * as po from '../src/domain/perf/outcomes.js';
import * as ph from '../src/imports/perf-history.js';

/** Two founders (like Layan and Ghaith): the synthetic partner and Uma (given the partner role here). */
function setup() {
  const ctx = fresh();
  const { db } = ctx;
  db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'partner')").run(SYN.unrelated);
  db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'admin')").run(SYN.ops);
  return { ...ctx, F1: ctx.as(SYN.partner), F2: ctx.as(SYN.unrelated) };
}
function approvedCycle({ db, as, F1, F2 }) {
  assert.throws(() => pc.launchCycle(db, F1, { year: 2027 }), /approve the performance policy/);
  pc.approvePolicy(db, F1);
  assert.equal(pc.currentPolicy(db, SYN.tenant).status, 'draft', 'one founder is not enough');
  pc.approvePolicy(db, F2);
  assert.equal(pc.currentPolicy(db, SYN.tenant).status, 'approved');
  const c = pc.launchCycle(db, F1, { year: 2027, dates: { reflection_due: '2027-12-10' } });
  return { cycleId: c.id, rid: db.prepare('SELECT id FROM perf_reviews WHERE cycle_id = ? AND user_id = ?').get(c.id, SYN.emp).id };
}

test('cycle: policy needs both founders; goals agreed; results hidden from the employee until both founders confirm and release', () => {
  const ctx = setup(); const { db, as, F1, F2 } = ctx;
  const { cycleId, rid } = approvedCycle(ctx);
  assert.ok(!db.prepare('SELECT 1 FROM perf_reviews WHERE cycle_id = ? AND user_id IN (?, ?)').get(cycleId, SYN.partner, SYN.unrelated), 'founders are not reviewed by the score');
  const E = as(SYN.emp); const M = as(SYN.manager);
  pc.saveGoals(db, E, rid, { goals: [{ kind: 'delivery', text: 'Own the N-2 structure deliverable on Alpha' }, { kind: 'growth', text: 'Lead one client workshop' }] });
  assert.throws(() => pc.saveGoals(db, E, rid, { goals: [1, 2, 3, 4].map(() => ({ kind: 'delivery', text: 'x' })) }), /Up to three/);
  assert.throws(() => pc.agreeGoals(db, E, rid), /review manager agrees/);
  pc.agreeGoals(db, M, rid);
  // a change after agreement is a request the manager approves
  pc.saveGoals(db, E, rid, { goals: [{ kind: 'delivery', text: 'Own the RACI deliverable (assignment moved)' }], reason: 'Moved to Beta in May' });
  const ch = pc.reviewView(db, M, rid).goal_changes.find((x) => x.status === 'pending');
  pc.decideGoalChange(db, M, ch.id, { approve: true });
  assert.match(pc.reviewView(db, E, rid).goals.find((g) => g.kind === 'delivery').text, /RACI/);
  // kickoff from staffing, coaching in June = career conversation
  const cand = pc.reviewView(db, E, rid).kickoff_candidates; assert.ok(cand.length);
  pc.saveKickoff(db, E, { assignment_id: cand[0].assignment_id, role: 'Analyst', owns: 'N-2 chart', good_looks_like: 'Signed off by the client sponsor' });
  assert.throws(() => pc.saveCoaching(db, E, rid, { month: 6, strength: 'a', improvement: 'b', next_assignment: 'c' }), /review manager records/);
  pc.saveCoaching(db, M, rid, { month: 6, strength: 'Clear analysis', improvement: 'Escalate risks earlier', next_assignment: 'Run workshop 3', due_on: '2027-09-30' });
  assert.equal(pc.reviewView(db, E, rid).coaching[0].career, 1);
  // annual
  pc.setCycleStage(db, F1, cycleId, 'annual');
  assert.throws(() => pc.saveReflection(db, E, rid, { accomplishments: [] }, { submit: true }), /at least one accomplishment/);
  pc.saveReflection(db, E, rid, { accomplishments: [{ text: 'Delivered N-2 structure', link: 'https://docs.google.com/x' }], growth: 'Client facilitation', next: 'Own a workstream' }, { submit: true });
  pc.saveRatings(db, M, rid, { ratings: [{ dimension: 'delivery', score: 4, evidence: 'N-2 accepted first time', rationale: 'Frequently exceeds' }, { dimension: 'ownership', score: 4, evidence: 'Flagged data risk early', rationale: 'Exceeds' },
    { dimension: 'communication', score: 3, evidence: 'Snapshot from lead', rationale: 'Reliably meets' }, { dimension: 'contribution', score: null }] });
  assert.throws(() => pc.submitManager(db, M, rid), /Contribution to GB Advisory: not rated|score, evidence and rationale/);
  pc.saveRatings(db, M, rid, { ratings: [{ dimension: 'contribution', score: 3, evidence: 'Reusable KPI dictionary', rationale: 'Meets' }] });
  pc.submitManager(db, M, rid);
  // the employee still sees nothing scored
  const mine = pc.reviewView(db, E, rid);
  assert.equal(mine.ratings, undefined); assert.equal(mine.preview, undefined); assert.equal(mine.released, null); assert.equal(mine.leadership_note, undefined);
  assert.throws(() => pc.calibrate(db, M, rid, { dimension: 'delivery', score: 5, rationale: 'x' }), /founders/);
  pc.calibrate(db, F1, rid, { dimension: 'communication', score: 3, rationale: 'Consistent with peers' });
  const done = pc.finishCalibration(db, F1, rid, { note: 'Discussed with Ghaith' });
  assert.equal(done.score, '3.65'); assert.equal(done.band, 'Meets');
  // both founders must confirm the same version
  pc.founderApprove(db, F1, rid);
  assert.throws(() => pc.releaseReview(db, F1, rid), /Both founders/);
  pc.founderApprove(db, F2, rid);
  pc.releaseReview(db, F2, rid);
  const after = pc.reviewView(db, E, rid);
  assert.equal(after.released.score, '3.65'); assert.equal(after.released.band, 'Meets'); assert.equal(after.leadership_note, undefined);
  assert.equal(db.prepare("SELECT body FROM notification_outbox WHERE event = 'perf.released'").get().body.includes('3.65'), false, 'no score in the email');
  pc.acknowledgeReview(db, E, rid, { kind: 'correction', note: 'Contribution misses the proposal I co-wrote' });
  // amendment: audited, back to approval by both founders, then re-released
  pc.amendReview(db, F1, rid, { reason: 'Proposal co-authorship verified', ratings: [{ dimension: 'contribution', score: 4 }] });
  assert.equal(pc.reviewView(db, E, rid).released.score, '3.65', 'the employee keeps seeing the published version until re-release');
  pc.founderApprove(db, F1, rid); pc.founderApprove(db, F2, rid); pc.releaseReview(db, F1, rid);
  assert.equal(pc.reviewView(db, E, rid).released.score, '3.80');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM perf_amendments WHERE review_id = ?').get(rid).n, 1);
  // isolation: a colleague and an unrelated manager see nothing
  assert.throws(() => pc.reviewView(db, as(SYN.peer), rid), /Not found/);
  assert.throws(() => pc.reviewView(db, as(SYN.lead), rid), /Not found/);
  const adminOnly = pc.reviewView(db, as(SYN.ops), rid);
  assert.equal(adminOnly.relation, 'admin'); assert.equal(adminOnly.ratings, undefined);
});

test('N/A and insufficient evidence', () => {
  const ctx = setup(); const { db, as, F1, F2 } = ctx;
  const { cycleId, rid } = approvedCycle(ctx);
  const M = as(SYN.manager); const E = as(SYN.emp);
  assert.throws(() => pc.agreeGoals(db, M, rid), /at least one priority/);
  pc.setCycleStage(db, F1, cycleId, 'annual');
  pc.saveReflection(db, E, rid, { accomplishments: [{ text: 'x' }], growth: 'y', next: 'z' }, { submit: true });
  pc.saveRatings(db, M, rid, { ratings: [{ dimension: 'delivery', score: 4, evidence: 'e', rationale: 'r' }, { dimension: 'ownership', score: 4, evidence: 'e', rationale: 'r' }, { dimension: 'communication', score: 3, evidence: 'e', rationale: 'r' },
    { dimension: 'contribution', na: true, na_reason: 'No internal work was assigned this year' }] });
  pc.submitManager(db, M, rid);
  assert.throws(() => pc.finishCalibration(db, F1, rid), /Approve or reject not applicable/);
  assert.throws(() => pc.approveNa(db, M, rid, 'contribution'), /founder/);
  pc.approveNa(db, F2, rid, 'contribution');
  const s = pc.finishCalibration(db, F1, rid);
  assert.equal(s.score, '3.76');
  // a second person closes as insufficient evidence
  const r2 = db.prepare('SELECT id FROM perf_reviews WHERE cycle_id = ? AND user_id = ?').get(cycleId, SYN.senior).id;
  pc.saveReflection(db, as(SYN.senior), r2, { accomplishments: [{ text: 'x' }], growth: 'y', next: 'z' }, { submit: true });
  pc.saveRatings(db, M, r2, { ratings: [{ dimension: 'delivery', insufficient: true, rationale: 'Only on internal work since March' }, { dimension: 'ownership', score: 3, evidence: 'e', rationale: 'r' }, { dimension: 'communication', score: 3, evidence: 'e', rationale: 'r' }, { dimension: 'contribution', score: 3, evidence: 'e', rationale: 'r' }] });
  pc.submitManager(db, M, r2);
  assert.throws(() => pc.finishCalibration(db, F1, r2), /insufficient/);
  pc.finishCalibration(db, F1, r2, { insufficientReason: 'Not enough observed delivery this year' });
  const v = pc.reviewView(db, F1, r2); assert.equal(v.stored.outcome, 'insufficient'); assert.equal(v.stored.score, null);
});

test('snapshots: triggers are deduplicated, due in five working days, shared only when submitted', () => {
  const ctx = setup(); const { db, as } = ctx;
  approvedCycle(ctx);
  const today = '2027-03-15';
  db.prepare("UPDATE project_assignments SET start_date = '2026-09-01' WHERE user_id = ? AND project_id = 'prj_alpha'").run(SYN.emp);
  db.prepare("UPDATE projects SET status = 'active', end_date = NULL WHERE id = 'prj_alpha'").run();
  db.prepare("UPDATE project_assignments SET end_date = NULL WHERE project_id = 'prj_alpha'").run();
  db.prepare("INSERT INTO deliverables (id, tenant_id, project_id, title, milestone, status, owner_id, review_passed_at) VALUES ('d1', ?, 'prj_alpha', 'N-2', 'Client workshop', 'ready', ?, ?)").run(SYN.tenant, SYN.emp, '2027-03-14T10:00:00Z');
  const n1 = pc.runSnapshotTriggers(db, SYN.tenant, today);
  const n2 = pc.runSnapshotTriggers(db, SYN.tenant, today);
  assert.equal(n2, 0, 'running again creates nothing');
  const open = db.prepare("SELECT * FROM perf_snapshots WHERE user_id = ? AND project_id = 'prj_alpha'").all(SYN.emp);
  assert.equal(open.length, 1, 'milestone and quarterly on the same project and observer → one request');
  assert.ok(n1 >= 1);
  assert.equal(open[0].observer_id, SYN.lead); assert.equal(open[0].due_on, '2027-03-22');
  // the employee cannot read it before it is submitted
  assert.throws(() => pc.getSnapshot(db, as(SYN.emp), open[0].id), /Not found/);
  assert.throws(() => pc.saveSnapshot(db, as(SYN.emp), open[0].id, { rating: 'above' }), /Only the person asked/);
  assert.throws(() => pc.saveSnapshot(db, as(SYN.lead), open[0].id, { rating: 'above' }, { submit: true }), /what they owned/);
  pc.saveSnapshot(db, as(SYN.lead), open[0].id, { owned: 'N-2 chart', example: 'Workshop pack', impact: 'Client approved in one round', development: 'Quantify options', rating: 'above' }, { submit: true });
  assert.equal(pc.getSnapshot(db, as(SYN.emp), open[0].id).rating, 'above');
  pc.snapshotResponse(db, as(SYN.emp), open[0].id, { context: 'The pack was co-written with Sara', correction: true });
  assert.ok(db.prepare("SELECT 1 FROM notification_outbox WHERE event = 'perf.snapshot_correction'").get());
  db.prepare("UPDATE perf_snapshots SET submitted_at = '2027-03-16T09:00:00Z' WHERE id = ?").run(open[0].id);
  // a submitted snapshot in the last 30 days suppresses another automatic one for the same project
  db.prepare("INSERT INTO deliverables (id, tenant_id, project_id, title, milestone, status, owner_id, review_passed_at) VALUES ('d2', ?, 'prj_alpha', 'N-3', 'Draft', 'ready', ?, ?)").run(SYN.tenant, SYN.emp, '2027-03-20T10:00:00Z');
  assert.equal(pc.runSnapshotTriggers(db, SYN.tenant, '2027-03-21'), 0);
});

test('promotion: gates, low dimension, development needs an assignment, override recorded; role never changes by itself', () => {
  const ctx = setup(); const { db, as, F1, F2 } = ctx;
  const { cycleId, rid } = approvedCycle(ctx);
  const M = as(SYN.manager); const E = as(SYN.emp);
  pc.setCycleStage(db, F1, cycleId, 'annual');
  pc.saveReflection(db, E, rid, { accomplishments: [{ text: 'x' }], growth: 'y', next: 'z' }, { submit: true });
  const r = (d, sc) => ({ dimension: d, score: sc, evidence: 'e', rationale: 'r' });
  pc.saveRatings(db, M, rid, { ratings: [r('delivery', 5), r('ownership', 5), r('communication', 2), r('contribution', 5)] });
  pc.submitManager(db, M, rid); pc.finishCalibration(db, F1, rid); pc.founderApprove(db, F1, rid); pc.founderApprove(db, F2, rid); pc.releaseReview(db, F1, rid);
  assert.throws(() => po.savePromotion(db, as(SYN.peer), null, { user_id: SYN.emp }), /founders and the review manager/);
  const c = po.savePromotion(db, M, null, { user_id: SYN.emp, outcome_kind: 'title', target_title: 'Senior Consultant', scope_from: '2027-01-01', scope_to: '2027-08-01', economic: 'Covers a workstream lead on Alpha', pay_within_band: true });
  assert.equal(c.score, '4.40');
  assert.equal(c.eligibility.eligible, false); assert.match(c.eligibility.blocking.join(), /below 3/);
  assert.equal(c.eligibility.gates.find((g) => g.key === 'time_in_grade').state, 'not_set');
  assert.throws(() => po.setReadiness(db, M, c.id, { readiness: 'ready' }), /rationale/);
  po.setReadiness(db, M, c.id, { readiness: 'ready', rationale: 'Leads the workstream since January' });
  assert.throws(() => po.approvePromotion(db, M, c.id, {}), /founder/);
  assert.throws(() => po.approvePromotion(db, F1, c.id, { approved_title: 'Senior Consultant', approved_scope: 'Workstream lead', effective_on: '2028-01-01' }), /override needs/);
  po.approvePromotion(db, F1, c.id, { approved_title: 'Senior Consultant', approved_scope: 'Workstream lead', effective_on: '2028-01-01', override: { clause: 'People System 4.2', reason: 'Communication improved after Q3 coaching', review_on: '2028-06-30' } });
  assert.equal(db.prepare('SELECT title FROM employments WHERE user_id = ? AND effective_to IS NULL').get(SYN.emp).title, 'Consultant', 'the roster is not changed by the case');
  // development needed requires a concrete assignment, sponsor and review date when scope was not shown
  const d = po.savePromotion(db, M, null, { user_id: SYN.senior, outcome_kind: 'grade', target_title: 'Assistant Manager' });
  assert.throws(() => po.setReadiness(db, M, d.id, { readiness: 'development', rationale: 'No chance to lead yet' }), /assignment, a sponsor and a review date/);
  po.savePromotion(db, M, d.id, { opportunity_assignment: 'Lead the Beta diagnostic', sponsor_id: SYN.partner, review_on: '2028-03-31' });
  po.setReadiness(db, M, d.id, { readiness: 'development', rationale: 'No chance to lead yet' });
  po.setReadiness(db, F1, d.id, { readiness: 'deferred', rationale: 'Business reasons: utilisation' });
});

test('compensation: founders and named admins only; admin role alone is refused; release is opt-in and pay never in emails', () => {
  const ctx = setup(); const { db, as, F1 } = ctx;
  approvedCycle(ctx);
  assert.throws(() => po.listComp(db, as(SYN.ops)), /Compensation is for/);
  assert.throws(() => po.listComp(db, as(SYN.manager)), /Compensation is for/);
  const { id } = po.saveCompProposal(db, F1, null, { user_id: SYN.emp, year: 2028, prior: 700, proposed: 800, bonus_type: 'months', bonus_months: 1.5, effective: '2028-01' });
  const row = po.listComp(db, F1).rows.find((r) => r.id === id);
  assert.equal(row.increase, 100); assert.equal(row.increase_pct, 14.3); assert.equal(row.bonus_value, 1200); assert.match(row.band_position, /not configured/);
  po.compAdmins(db, F1, [SYN.ops]);
  assert.ok(po.listComp(db, as(SYN.ops)).rows.length);
  assert.throws(() => po.approveComp(db, as(SYN.ops), id), /founder/);
  po.approveComp(db, F1, id);
  assert.throws(() => po.releaseComp(db, F1, id), /does not release compensation/);
  assert.deepEqual(po.myOutcome(db, as(SYN.emp)).compensation, []);
  const raw = db.prepare('SELECT data_enc FROM comp_records WHERE id = ?').get(id).data_enc;
  assert.ok(!raw.includes('800'), 'amounts encrypted at rest');
});

const CSV = '﻿employee,work_email,review_year,sent_at_amman,effective_month,communicated_outcome,new_title,previous_monthly_salary_jod,new_monthly_salary_jod,bonus_months_of_base_salary,source_message_id,source_url,communicated_email_body\n'
  + 'Eli Employee,ELI@example.test ,2025,2026-01-13T17:00:00+03:00,2026-01,Promotion + salary increase + bonus,Senior Consultant,480,600,1,m1,https://x,"Dear Eli,\n\nSalary increase: +25% (from JOD 480 to JOD 600)\nThanks"\n'
  + 'Sara Senior,sara@example.test,2025,2026-01-13T17:00:00+03:00,2026-01,Promotion + salary increase,,800,900,,m2,https://x,"Dear Sara, +10% raise"\n'
  + 'Former Person,former@example.test,2025,2026-01-13T17:00:00+03:00,2026-01,Salary increase + bonus,,600,700,1,m3,https://x,"Dear F"\n';

test('historical import: dry run, exact email match, unmatched skipped unless mapped, flags, idempotent, no profile changes', () => {
  const ctx = setup(); const { db, as, F1 } = ctx;
  const A = as(SYN.ops);
  assert.throws(() => ph.previewOutcomeCsv(db, A, { filename: 'x.csv', text: CSV }), /admin role and compensation access/);
  po.compAdmins(db, F1, [SYN.ops]);
  assert.throws(() => ph.previewOutcomeCsv(db, F1, { filename: 'x.csv', text: CSV }), /admin role/);
  const p = ph.previewOutcomeCsv(db, A, { filename: 'x.csv', text: CSV });
  const by = Object.fromEntries(p.rows.map((r) => [r.name_in_source, r]));
  assert.equal(by['Eli Employee'].status, 'ready'); assert.equal(by['Former Person'].status, 'needs mapping');
  assert.equal(by['Eli Employee'].flags.length, 0, '+25% reconciles to 480 → 600');
  assert.ok(by['Sara Senior'].flags.some((f) => /no new title/.test(f)));
  assert.ok(by['Sara Senior'].flags.some((f) => /quotes 10% but the amounts give 12.5%/.test(f)));
  assert.equal(p._data, undefined, 'raw bodies are not returned to the browser');
  const before = db.prepare('SELECT title FROM employments WHERE user_id = ? AND effective_to IS NULL').get(SYN.emp).title;
  const rep = ph.applyBatch(db, A, p.id, { mappings: {} });
  assert.equal(rep.imported, 2); assert.ok(rep.skipped.some((s) => /Former Person/.test(s)));
  assert.equal(db.prepare('SELECT title FROM employments WHERE user_id = ? AND effective_to IS NULL').get(SYN.emp).title, before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE event LIKE 'comp.%'").get().n, 0);
  assert.throws(() => ph.applyBatch(db, A, p.id), /already applied/);
  const again = ph.previewOutcomeCsv(db, A, { filename: 'x.csv', text: CSV });
  assert.equal(again.duplicate, true);
  const edited = ph.previewOutcomeCsv(db, A, { filename: 'y.csv', text: CSV.replace('Thanks', 'Thank you') });
  assert.equal(edited.rows.find((r) => r.name_in_source === 'Eli Employee').status, 'already imported', 'keyed by year + message id');
  const hist = po.listComp(db, F1).rows.find((r) => r.source === 'email' && r.person === 'Eli Employee');
  assert.equal(hist.approved, 600); assert.equal(hist.quoted_pct, 25); assert.equal(hist.status, 'historical');
  assert.match(po.compMessage(db, F1, hist.id).body, /Dear Eli/);
});

test('worksheet import: header found below the top, allow-listed columns only (Age never read), reconciled against the email', async () => {
  const ctx = setup(); const { db, as, F1 } = ctx; const A = as(SYN.ops);
  po.compAdmins(db, F1, [SYN.ops]);
  ph.applyBatch(db, A, ph.previewOutcomeCsv(db, A, { filename: 'x.csv', text: CSV }).id);
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Sheet1');
  ws.getRow(10).values = [, , , , , , 'Employee Name', 'Current Title', 'New Title', 'Joining Date', 'Years with GB Advisory', 'Age', 'Years of Relevant Experience', '2024 Salary (JOD)', '2025 Salary (Current)', '2024 Increase %', 'Overall Performance Rating', 'Suggested 2025 Increase', '2026 Salary', 'Suggested 2026 Bonus'];
  ws.getRow(11).values = [, , , , , , 'Eli Employee', 'Consultant', 'Senior Consultant', new Date('2024-01-01'), 2, 99, 3, 450, 480, 0.05, 4.1, '25%', 650, 1];
  ws.getRow(12).values = [, , , , , , 'Nobody Here', 'Consultant', '', new Date('2024-01-01'), 2, 98, 3, 450, 500, 0.05, 3.2, '10%', 550, 0.5];
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const p = await ph.previewWorksheet(db, A, { filename: 'Bonuses.xlsx', buffer: buf });
  assert.ok(p.ignored_columns.includes('Age'));
  assert.ok(!JSON.stringify(p).includes('99'), 'the age value is never read');
  const eli = p.rows.find((r) => r.name_in_source === 'Eli Employee');
  assert.ok(eli.flags.some((f) => /650 differs from the communicated 600/.test(f)));
  assert.ok(eli.flags.some((f) => /does not reconcile/.test(f)), '25% of 480 is 600, not 650');
  assert.equal(p.rows.find((r) => r.name_in_source === 'Nobody Here').status, 'needs mapping');
  assert.ok(p.rows.find((r) => r.name_in_source === 'Nobody Here').flags.some((f) => /communication unverified/.test(f)));
  const rep = ph.applyBatch(db, A, p.id, { mappings: { [p.rows.find((r) => r.name_in_source === 'Nobody Here').key]: 'skip' } });
  assert.equal(rep.imported, 1);
  const rows = po.listComp(db, F1, { year: 2025 }).rows.filter((r) => r.person === 'Eli Employee');
  assert.deepEqual(rows.map((r) => r.source).sort(), ['email', 'worksheet'], 'both versions kept');
  assert.equal(rows.find((r) => r.source === 'email').approved, 600, 'the communicated decision is unchanged');
});
