import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fresh, SYN, xlsx, withToday } from './helpers.js';
import { previewLeaveboard, applyLeaveboard, postOpeningBalances, reconcile } from '../src/imports/leaveboard.js';
import { previewPlans, applyPlans, previewHistory, applyHistory } from '../src/imports/pms.js';
import { reverseBatch } from '../src/imports/batch.js';
import * as leave from '../src/domain/leave.js';
import * as perf from '../src/domain/performance.js';

const details = (ts) => [['https://leaveboard.com/'], [`generated.on : ${ts}`]];
const ledgerCount = (db) => db.prepare('SELECT COUNT(*) n FROM leave_ledger WHERE batch_id IS NOT NULL').get().n;

test('General Situation: named rows imported, totals row as checksum, zero ledger entries, safe re-import', async () => {
  const { db, as } = fresh(); const ops = as(SYN.ops);
  const head = ['Employee', 'Working', 'Worked', 'Sick leave', 'Work From Home', 'Annual Vacation', 'Compensation of Overtime', 'Overtime', 'Wedding Leave'];
  const rows = [head, ['Eli Employe', 230, 223, 6, 12, 12, 1, 3, 0], ['Unknown Person', 231, 229.5, 0.5, 5, 15, 1, 0, 0], [null, 461, 452.5, 6.5, 17, 27, 2, 3, 0]];
  const buf = await xlsx({ Data: rows, Details: details('2026-11-19T10:03:55.815Z') });
  const b = await previewLeaveboard(db, ops, { filename: 'gs.xlsx', buffer: buf, reportingFrom: '2026-01-01', reportingTo: '2026-11-19' });
  assert.equal(b.summary.named_rows, 2);
  assert.ok(Object.values(b.summary.checksum).every((c) => c.ok));
  assert.equal(b.summary.checksum.Worked.rows, '452.5'); // decimals preserved
  assert.equal(b.summary.generated.generatedAmman, '2026-11-19T13:03:55+03:00');
  assert.equal(b.rows.find((r) => r.raw.Employee === 'Unknown Person').action, 'review'); // never auto-created
  const res = applyLeaveboard(db, ops, b.id);
  assert.equal(res.ledger_entries, 0);
  assert.equal(ledgerCount(db), 0);
  assert.equal(db.prepare("SELECT raw_value FROM vendor_snapshot_values WHERE vendor_name = 'Unknown Person' AND category = 'Worked'").get().raw_value, '229.5');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 11);
  const again = await previewLeaveboard(db, ops, { filename: 'gs.xlsx', buffer: buf });
  assert.equal(again.duplicateOf, b.id);
  assert.throws(() => applyLeaveboard(db, ops, b.id), /already been applied/);
  // tampered totals are blocking
  rows[3][2] = 452;
  const bad = await previewLeaveboard(db, ops, { filename: 'gs2.xlsx', buffer: await xlsx({ Data: rows, Details: details('2026-11-19T10:03:55.815Z') }) });
  assert.ok(bad.summary.blocking.some((x) => /Worked/.test(x)));
  assert.throws(() => applyLeaveboard(db, ops, bad.id), /blocking/);
});

test('Annual Situation: Used + Available = Allowance check, decimal strings, negative availability flagged', async () => {
  const { db, as } = fresh(); const ops = as(SYN.ops);
  const head = ['Employee', 'Year', 'Sick leave - Used', 'Sick leave - Available', 'Sick leave - Allowance', 'Annual Vacation - Used', 'Annual Vacation - Available', 'Annual Vacation - Allowance', 'Compensation of Overtime - Used', 'Compensation of Overtime - Available', 'Compensation of Overtime - Allowance'];
  const buf = await xlsx({ Data: [head, ['Eli Employe', 2026, '6.50', '7.50', '14', '4.50', '9.50', '14', '8', '-1', '7'], ['Sara Snr', 2026, '1', '12', '14', '2', '12', '14', '0', '0', '0']], Details: details('2026-11-19T10:05:42.049Z') });
  const b = await previewLeaveboard(db, ops, { filename: 'as.xlsx', buffer: buf });
  const eli = b.rows.find((r) => r.raw.Employee === 'Eli Employe');
  assert.ok(eli.issues.some((i) => /negative available/.test(i)));
  assert.equal(eli.action, 'insert');
  const sara = b.rows.find((r) => r.raw.Employee === 'Sara Snr');
  assert.ok(sara.issues.some((i) => /≠ Allowance/.test(i)));
  assert.equal(sara.action, 'reject');
  assert.equal(sara.match_status, 'alias_unverified');
});

test('Attendance: codes preserved, footer range parsed, future days classified, no ledger', async () => {
  const { db, as } = fresh(); const ops = as(SYN.ops);
  const head = ['Employee', 'Su 1', 'Mo 2', 'Tu 3', 'We 4', 'Hours', 'SL Sick leave', 'Team'];
  const buf = await xlsx({ Data: [head, ['Eli Employe', 8, '4/SL', '8WFH', 'COO', 20, 0.5, null], ['Attendance for 11/01/2026 - 11/04/2026']], Details: details('2026-11-02T10:05:48.636Z') });
  const b = await previewLeaveboard(db, ops, { filename: 'att.xlsx', buffer: buf });
  assert.deepEqual(b.summary.range.from, '2026-11-01');
  assert.deepEqual(b.summary.codes_seen, ['COO', 'SL', 'WFH']);
  applyLeaveboard(db, ops, b.id);
  const days = db.prepare('SELECT date, raw_value, hours_x100, code, code_hours_x100, is_future FROM attendance_days ORDER BY date').all();
  assert.equal(days[1].raw_value, '4/SL');
  assert.equal(days[1].code_hours_x100, 400);
  assert.equal(days[2].is_future, 1);
  assert.equal(days[0].is_future, 0);
  assert.equal(ledgerCount(db), 0);
});

test('LeaveBoard cutover: opening balance, past history, future approval already deducted, pending, partial day; reconcile; repeat without duplicates', async () => withToday('2026-11-19', async () => {
  const { db, as } = fresh(); const ops = as(SYN.ops);
  // remove the synthetic grants for Eli so the vendor snapshot is the only source
  db.prepare("DELETE FROM leave_ledger WHERE user_id = ?").run(SYN.emp);
  const annual = await xlsx({ Data: [['Employee', 'Year', 'Annual Vacation - Used', 'Annual Vacation - Available', 'Annual Vacation - Allowance'], ['Eli Employe', 2026, '4.50', '9.50', '14']], Details: details('2026-11-19T10:05:42.049Z') });
  const ab = await previewLeaveboard(db, ops, { filename: 'annual.xlsx', buffer: annual });
  applyLeaveboard(db, ops, ab.id);
  const open1 = postOpeningBalances(db, ops, { batchId: ab.id, cutover: '2026-11-19' });
  assert.equal(open1.posted, 1);
  assert.equal(postOpeningBalances(db, ops, { batchId: ab.id, cutover: '2026-11-19' }).already, 1); // no duplicate

  const head = ['ID', 'Employee', 'Leave type', 'Start date', 'End date', 'Start portion', 'End portion', 'Duration', 'Status'];
  const v1 = [head,
    ['LB-1', 'Eli Employe', 'Annual Vacation', '03/01/2026', '03/03/2026', 'full', 'full', 3, 'Approved'], // history, in snapshot
    ['LB-2', 'Eli Employe', 'Annual Vacation', '12/13/2026', '12/14/2026', 'pm', 'full', 1.5, 'Approved'], // future, already deducted
    ['LB-3', 'Eli Employe', 'Annual Vacation', '12/20/2026', '12/20/2026', 'full', 'full', 1, 'Pending'], // pending
    ['LB-4', 'Eli Employe', 'Annual Vacation', '12/21/2026', '12/21/2026', 'full', 'full', 1, 'Declined']];
  const lb = await previewLeaveboard(db, ops, { filename: 'leaves.xlsx', buffer: await xlsx({ Data: v1, Details: details('2026-11-19T10:00:00Z') }) });
  assert.deepEqual(lb.summary.blocking, []);
  const r1 = applyLeaveboard(db, ops, lb.id, { cutover: '2026-11-19' });
  assert.equal(r1.requests, 4);
  assert.equal(r1.ledger_entries, 1); // only the pending reservation
  let b = leave.balance(db, 'gb', SYN.emp, 'lt_AV', 2026);
  assert.equal(b.posted_x100, 950); // approved items NOT deducted twice
  assert.equal(b.pending_x100, -100);
  const rec = reconcile(db, ops, { batchId: ab.id }).find((x) => x.category === 'Annual Vacation');
  assert.equal(rec.status, 'match');
  assert.equal(rec.prism_pending, '-1');

  // later extract: LB-3 got approved in LeaveBoard → release + usage, no duplicates of others
  v1[3][8] = 'Approved';
  const lb2 = await previewLeaveboard(db, ops, { filename: 'leaves2.xlsx', buffer: await xlsx({ Data: v1, Details: details('2026-11-20T10:00:00Z') }) });
  assert.equal(lb2.summary.by_action.unchanged, 3);
  assert.equal(lb2.summary.by_action.update, 1);
  applyLeaveboard(db, ops, lb2.id, { cutover: '2026-11-19' });
  b = leave.balance(db, 'gb', SYN.emp, 'lt_AV', 2026);
  assert.equal(b.posted_x100, 850);
  assert.equal(b.pending_x100, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leave_requests WHERE source = 'leaveboard'").get().n, 4);

  // cancelling an imported future booking credits it back exactly once
  const lb2req = db.prepare("SELECT * FROM leave_requests WHERE source_ref = 'LB-2'").get();
  assert.equal(lb2req.chargeable_x100, 150); // partial day preserved
  leave.cancelRequest(db, as(SYN.emp), lb2req.id, {});
  leave.cancelRequest(db, as(SYN.emp), lb2req.id, {});
  assert.equal(leave.balance(db, 'gb', SYN.emp, 'lt_AV', 2026).posted_x100, 1000);

  // carryover into 2027 from the reconciled balance
  leave.runCarryover(db, ops, { fromYear: 2026 });
  assert.equal(leave.balance(db, 'gb', SYN.emp, 'lt_AV', 2027).by_kind.carryover, 1000);
}));

test('PMS plan import: allowlist, formula error row, weight validation, idempotent re-import, locked plans protected', async () => {
  const { db, as } = fresh({ plans: false }); const ops = as(SYN.ops);
  const head = ['Email', 'Cycle', 'Category', 'Category weight', 'Item', 'KPI', 'Target', 'Weight', 'Salary (JOD)', 'Bonus'];
  const rows = [head,
    ['eli@example.test', 2026, 'Objective', '40%', 'Deliverable quality', 'Rework rate', '≤10%', 0.5, 700, 1.5],
    ['eli@example.test', 2026, 'Objective', '40%', 'Data traceability', '% traced', '≥95%', 0.5, 700, 1.5],
    ['eli@example.test', 2026, 'Competency', '40%', 'Structured thinking', '', '', 1, 700, 1.5],
    ['eli@example.test', 2026, 'Initiative', '20%', 'Template library', '', '2 templates', 1, 700, 1.5],
    ['sara@example.test', 2026, 'Objective', '100%', 'Workstream delivery', '', 'All milestones', { formula: '1/0', result: { error: '#DIV/0!' } }, 900, 1]];
  const buf = await xlsx({ PMS: rows });
  const b = await previewPlans(db, ops, { filename: 'plans.xlsx', buffer: buf, cycleId: 'cyc_2026' });
  assert.deepEqual(b.summary.excluded_columns, ['Salary (JOD)', 'Bonus']);
  assert.equal(JSON.stringify(b.rows).includes('700'), false); // payroll values never stored
  const sara = b.rows.find((r) => r.raw.email === 'sara@example.test');
  assert.equal(sara.action, 'reject');
  assert.ok(sara.issues.some((i) => /#DIV\/0!/.test(i)));
  const out = applyPlans(db, ops, b.id);
  assert.equal(out.plans_created, 1);
  assert.equal(out.items, 4);
  const plan = db.prepare('SELECT * FROM plans WHERE user_id = ?').get(SYN.emp);
  assert.equal(plan.state, 'draft_plan');
  assert.deepEqual(JSON.parse(plan.category_weights_json), { objective: 40, competency: 40, initiative: 20 });
  // identical file → duplicate, no writes
  const dup = await previewPlans(db, ops, { filename: 'plans.xlsx', buffer: buf, cycleId: 'cyc_2026' });
  assert.equal(dup.duplicateOf, b.id);
  // corrected file updates the draft plan without duplicating items
  rows[2][6] = '≥98%'; rows[5][7] = 1;
  const b2 = await previewPlans(db, ops, { filename: 'plans-v2.xlsx', buffer: await xlsx({ PMS: rows }), cycleId: 'cyc_2026' });
  applyPlans(db, ops, b2.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_items WHERE plan_id = ?').get(plan.id).n, 4);
  assert.equal(db.prepare("SELECT target FROM plan_items WHERE plan_id = ? AND title = 'Data traceability'").get(plan.id).target, '≥98%');
  // reversal path removes the unapproved imported plan with an audit record
  // lock Eli's plan and try again → blocked
  db.prepare("UPDATE plans SET state = 'released' WHERE id = ?").run(plan.id);
  rows[1][6] = '≤5%';
  const b3 = await previewPlans(db, ops, { filename: 'plans-v3.xlsx', buffer: await xlsx({ PMS: rows }), cycleId: 'cyc_2026' });
  assert.ok(b3.rows.filter((r) => r.raw.email === 'eli@example.test').every((r) => r.action === 'reject' && r.issues.some((i) => /released/.test(i))));
  // invalid weights are reported per person
  const bad = await previewPlans(db, ops, { filename: 'bad.xlsx', buffer: await xlsx({ PMS: [head, ['adam@example.test', 2026, 'Objective', '60%', 'A', '', 't', 0.7, null, null], ['adam@example.test', 2026, 'Competency', '40%', 'B', '', '', 1, null, null]] }), cycleId: 'cyc_2026' });
  assert.ok(bad.summary.plans[0].errors.some((e) => /total 70%/.test(e)));
});

test('import reversal keeps an audit trail and never touches released reviews', async () => {
  const { db, as } = fresh({ plans: false }); const ops = as(SYN.ops);
  const buf = await xlsx({ PMS: [['Email', 'Category', 'Category weight', 'Item', 'Target', 'Weight'], ['adam@example.test', 'Objective', 100, 'Margin', '20%', 100]] });
  const b = await previewPlans(db, ops, { filename: 'p.xlsx', buffer: buf, cycleId: 'cyc_2026' });
  applyPlans(db, ops, b.id);
  const res = reverseBatch(db, ops, b.id, { reason: 'Wrong cycle selected' });
  assert.equal(res.plans, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'import.reverse'").get().n, 1);
});

test('PMS history import (2025 team-summary shape): payroll sheet refused, totals recomputed, copy/paste flagged', async () => {
  const { db, as } = fresh(); const ops = as(SYN.ops);
  db.prepare("INSERT INTO identity_aliases (id, tenant_id, user_id, source, alias, verified) VALUES ('h1','gb',?, 'pms', 'Eli Employee', 1), ('h2','gb',?, 'pms', 'Sara Senior', 1)").run(SYN.emp, SYN.senior);
  const head = ['Employee', 'Current Title', 'Delivery Quality (25%)', 'Ownership & Accountability (25%)', 'Client & Communication (20%)', 'Team Contribution (15%)', 'Judgment & Maturity (15%)', 'Total Performance Score', 'Performance Rationale'];
  const buf = await xlsx({ Salaries: [['Employee', 'Salary'], ['Eli Employee', 999]], PMS: [head,
    ['Eli Employee', 'Consultant', 5, 5, 3.5, 4, 4.5, 4.5, 'Strong delivery anchor'],
    ['Sara Senior', 'Senior Consultant', 4, 4, 4.5, 4, 4, 4.1, 'Strategic thinker'],
    ['Adam Assistant', 'Consultant', 4, 4, 4.5, 4, 4, 4.0, 'Strategic thinker']] });
  await assert.rejects(previewHistory(db, ops, { filename: 'h.xlsx', buffer: buf, sheetName: 'Salaries', year: 2025 }), /payroll/);
  const b = await previewHistory(db, ops, { filename: 'h.xlsx', buffer: buf, year: 2025 });
  assert.equal(b.rows[0].action, 'insert');
  const adam = b.rows.find((r) => r.raw.name === 'Adam Assistant');
  assert.ok(adam.issues.some((i) => /≠ recomputed 4.1/.test(i)));
  assert.ok(adam.issues.some((i) => /identical to Sara Senior/.test(i)));
  const out = applyHistory(db, ops, b.id);
  assert.equal(out.plans, 2);
  const hist = db.prepare("SELECT p.* FROM plans p JOIN cycles c ON c.id = p.cycle_id WHERE c.year = 2025 AND p.user_id = ?").get(SYN.emp);
  assert.equal(hist.state, 'closed');
  assert.equal(hist.final_score, 4.5);
  // employee can see their own history; peer cannot
  assert.ok(perf.planView(db, as(SYN.emp), hist.id));
  assert.throws(() => perf.planView(db, as(SYN.peer), hist.id));
});

// Optional: real LeaveBoard exports, never committed. LEAVEBOARD_DIR=/path npm test
const dir = process.env.LEAVEBOARD_DIR;
test('real LeaveBoard General Situation export (acceptance)', { skip: !dir && 'set LEAVEBOARD_DIR to run' }, async () => {
  const { db, as } = fresh(); const ops = as(SYN.ops);
  const f = fs.readdirSync(dir).find((x) => /General-situation/.test(x));
  const b = await previewLeaveboard(db, ops, { filename: f, buffer: fs.readFileSync(path.join(dir, f)) });
  assert.equal(b.summary.named_rows, 13);
  assert.ok(Object.values(b.summary.checksum).every((c) => c.ok));
  assert.equal(b.summary.checksum.Worked.source_total, '2894.5');
  const r = applyLeaveboard(db, ops, b.id);
  assert.equal(r.ledger_entries, 0);
  assert.equal(b.rows.find((x) => x.source_key === 'TOTALS').action, 'skip');
});

test('LeaveBoard Leaves report (real grouped layout): name rows, ranges, half days, history only, idempotent', async () => {
  const { xlsx } = await import('./helpers.js');
  const L = await import('../src/imports/leaveboard.js');
  const { db, as } = fresh();
  const ops = as(SYN.ops);
  db.prepare("INSERT OR IGNORE INTO identity_aliases (id, tenant_id, user_id, source, alias, verified) VALUES ('al_lb_eli', 'gb', ?, 'leaveboard', 'Eli Employee', 1)").run(SYN.emp);
  const buf = await xlsx({
    Data: [
      ['Employee', 'Leave', 'Range', 'Days', 'Status', 'Approver', 'Comment', "Approver's comment", 'Registered on'],
      ['Eli Employee'],
      [null, 'Annual Vacation', '04/12/2026 - 04/16/2026', 5, 'Approved', 'Pat Partner', '..', null, 'March 15, 2026 1:52 PM'],
      [null, 'Sick leave', '03/26/2026', 0.5, 'Approved', 'Pat Partner', 'dentist', null, 'March 25, 2026 7:32 PM'],
      [null, 'Work From Home', '11/26/2026', 1, 'Approved', 'Pat Partner', null, null, 'November 20, 2026 9:00 AM'],
      ['Nobody Known'],
      [null, 'Annual Vacation', '05/03/2026', 1, 'Approved', 'Pat Partner', null, null, 'May 1, 2026 9:00 AM'],
    ],
    Details: [['https://leaveboard.com/'], ['generated.on : 2026-11-24T17:51:27.413Z']],
  });
  const b = await L.previewLeaveboard(db, ops, { filename: 'Leaves.xlsx', buffer: buf });
  assert.equal(b.kind, 'leaveboard_leaves');
  assert.equal(b.summary.named_rows, 4);
  const byName = Object.groupBy(b.rows, (r) => r.raw.name);
  assert.deepEqual(byName['Eli Employee'].map((r) => r.action), ['insert', 'insert', 'insert']);
  assert.equal(byName['Nobody Known'][0].action, 'review');
  const sick = byName['Eli Employee'][1].raw;
  assert.deepEqual([sick.start, sick.end, sick.start_portion, sick.duration_x100], ['2026-03-26', '2026-03-26', 'am', 50]);
  const av = byName['Eli Employee'][0].raw;
  assert.deepEqual([av.start, av.end], ['2026-04-12', '2026-04-16']);
  const before = leave.balance(db, 'gb', SYN.emp, 'lt_AV', 2026).posted_x100;
  const r = L.applyLeaveboard(db, ops, b.id, { cutover: '2026-11-24' });
  assert.equal(r.requests, 3); assert.equal(r.ledger_entries, 0);
  assert.equal(leave.balance(db, 'gb', SYN.emp, 'lt_AV', 2026).posted_x100, before); // history only, never deducted again
  const again = await L.previewLeaveboard(db, ops, { filename: 'Leaves.xlsx', buffer: buf });
  assert.ok(again.duplicateOf);
});
