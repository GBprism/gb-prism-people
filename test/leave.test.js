import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN, withToday } from './helpers.js';
import * as leave from '../src/domain/leave.js';

const T = '2026-11-19';
const bal = (db, u, code, y = 2026) => leave.balance(db, 'gb', u, `lt_${code}`, y);

test('working-day breakdown: weekend, holiday, cross-year split', () => withToday(T, () => {
  const { db, as } = fresh();
  db.prepare("INSERT INTO holidays (id, tenant_id, calendar, date, name) VALUES ('h31','gb','JO','2026-12-31','Test holiday')").run();
  leave.adjustBalance(db, as(SYN.ops), { userId: SYN.emp, typeCode: 'AV', year: 2027, amountX100: 1400, note: '2027 entitlement (synthetic)' });
  const p = leave.previewRequest(db, as(SYN.emp), { typeCode: 'AV', start: '2026-12-30', end: '2027-01-04', coverUserId: SYN.senior });
  assert.deepEqual(p.calc.byYear, { 2026: 100, 2027: 200 });
  const notes = Object.fromEntries(p.calc.days.map((d) => [d.date, d.note]));
  assert.match(notes['2026-12-31'], /Public holiday/);
  assert.equal(notes['2027-01-01'], 'Weekend');
  assert.equal(p.blocking.length, 0, p.blocking.join());
  const r = leave.submitRequest(db, as(SYN.emp), { typeCode: 'AV', start: '2026-12-30', end: '2027-01-04', coverUserId: SYN.senior, clientKey: 'k1' });
  assert.equal(bal(db, SYN.emp, 'AV').pending_x100, -100);
  assert.equal(bal(db, SYN.emp, 'AV', 2027).pending_x100, -200);
  // retry with same client key returns the same request
  assert.equal(leave.submitRequest(db, as(SYN.emp), { typeCode: 'AV', start: '2026-12-30', end: '2027-01-04', coverUserId: SYN.senior, clientKey: 'k1' }).id, r.id);
}));

test('half days and overlap handling', () => withToday(T, () => {
  const { db, as } = fresh();
  const e = as(SYN.emp);
  leave.submitRequest(db, e, { typeCode: 'AV', start: '2026-12-06', end: '2026-12-06', startPortion: 'pm', endPortion: 'pm', coverUserId: SYN.senior });
  const am = leave.submitRequest(db, e, { typeCode: 'AV', start: '2026-12-06', end: '2026-12-06', startPortion: 'am', endPortion: 'am', coverUserId: SYN.senior });
  assert.equal(am.chargeable_x100, 50);
  assert.throws(() => leave.submitRequest(db, e, { typeCode: 'AV', start: '2026-12-06', end: '2026-12-07', coverUserId: SYN.senior }), (err) => /Overlaps/.test(err.details.join()));
}));

test('approval is transactional, idempotent and never self-approved', () => withToday(T, () => {
  const { db, as } = fresh();
  const r = leave.submitRequest(db, as(SYN.emp), { typeCode: 'AV', start: '2026-12-07', end: '2026-12-08', coverUserId: SYN.senior });
  assert.throws(() => leave.decideRequest(db, as(SYN.emp), r.id, { decision: 'approve' }), /own request/);
  assert.throws(() => leave.decideRequest(db, as(SYN.peer), r.id, { decision: 'approve' }), /Not permitted/);
  assert.throws(() => leave.decideRequest(db, as(SYN.manager), r.id, { decision: 'approve', rowVersion: 99 }), /changed/);
  leave.decideRequest(db, as(SYN.manager), r.id, { decision: 'approve', rowVersion: 1 });
  leave.decideRequest(db, as(SYN.manager), r.id, { decision: 'approve' }); // retry: no-op
  const b = bal(db, SYN.emp, 'AV');
  assert.equal(b.posted_x100, 1200);
  assert.equal(b.pending_x100, 0);
  assert.throws(() => leave.decideRequest(db, as(SYN.partner), r.id, { decision: 'decline', note: 'x' }), /already approved|Only the assigned/);
  // a manager's own request routes to their manager (partner), never to themself
  const own = leave.submitRequest(db, as(SYN.manager), { typeCode: 'AV', start: '2026-12-09', end: '2026-12-09', coverUserId: SYN.emp });
  assert.equal(own.approver_id, SYN.partner);
  // nobody above the partner → blocked until an approver is configured
  assert.throws(() => leave.submitRequest(db, as(SYN.partner), { typeCode: 'SL', start: '2026-12-09', end: '2026-12-09' }), (e) => /No employment|No approver/.test(e.message + (e.details || []).join()));
}));

test('cancellation of approved future leave posts a reversal; withdrawal releases the hold', () => withToday(T, () => {
  const { db, as } = fresh();
  const e = as(SYN.emp);
  const r = leave.submitRequest(db, e, { typeCode: 'AV', start: '2026-12-13', end: '2026-12-14', coverUserId: SYN.senior });
  leave.decideRequest(db, as(SYN.manager), r.id, { decision: 'approve' });
  assert.equal(bal(db, SYN.emp, 'AV').posted_x100, 1200);
  leave.cancelRequest(db, e, r.id, {});
  assert.equal(bal(db, SYN.emp, 'AV').posted_x100, 1400);
  leave.cancelRequest(db, e, r.id, {}); // idempotent
  assert.equal(bal(db, SYN.emp, 'AV').posted_x100, 1400);
  const w = leave.submitRequest(db, e, { typeCode: 'SL', start: '2026-12-15', end: '2026-12-15' });
  assert.equal(bal(db, SYN.emp, 'SL').projected_x100, 1300);
  leave.cancelRequest(db, e, w.id, {});
  assert.equal(bal(db, SYN.emp, 'SL').projected_x100, 1400);
  const ledger = db.prepare("SELECT kind FROM leave_ledger WHERE request_id = ?").all(r.id).map((x) => x.kind);
  assert.deepEqual(ledger.sort(), ['reservation', 'reservation_release', 'reversal', 'usage']);
}));

test('notice rule and retroactive requests need an approved exception', () => withToday(T, () => {
  const { db, as } = fresh();
  const e = as(SYN.emp);
  assert.throws(() => leave.submitRequest(db, e, { typeCode: 'AV', start: '2026-11-24', end: '2026-11-24', coverUserId: SYN.senior }), (x) => /notice/.test(x.details.join()));
  const r = leave.submitRequest(db, e, { typeCode: 'AV', start: '2026-11-24', end: '2026-11-24', coverUserId: SYN.senior, exceptionReason: 'Family event' });
  assert.throws(() => leave.decideRequest(db, as(SYN.manager), r.id, { decision: 'approve' }), /exception/);
  leave.decideRequest(db, as(SYN.manager), r.id, { decision: 'approve', approveException: true });
  assert.throws(() => leave.submitRequest(db, e, { typeCode: 'SL', start: '2026-11-17', end: '2026-11-17' }), (x) => /Retroactive/.test(x.details.join()));
  assert.ok(leave.submitRequest(db, e, { typeCode: 'SL', start: '2026-11-17', end: '2026-11-17', exceptionReason: 'Was ill, reported by phone' }));
}));

test('off-site work: separate monthly quota, probation rule, leave balances untouched', () => withToday(T, () => {
  const { db, as } = fresh();
  const e = as(SYN.emp);
  const before = bal(db, SYN.emp, 'AV');
  leave.submitRequest(db, e, { typeCode: 'WFH', start: '2026-12-06', end: '2026-12-09' }); // Sun–Wed = 4 days
  assert.throws(() => leave.submitRequest(db, e, { typeCode: 'WFH', start: '2026-12-13', end: '2026-12-13' }), (x) => /quota/.test(x.details.join()));
  assert.ok(leave.submitRequest(db, e, { typeCode: 'WFH', start: '2027-01-03', end: '2027-01-03' })); // new month
  assert.deepEqual(bal(db, SYN.emp, 'AV'), before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leave_ledger WHERE type_id = 'lt_WFH'").get().n, 0);
  assert.throws(() => leave.submitRequest(db, as(SYN.newbie), { typeCode: 'WFH', start: '2026-12-06', end: '2026-12-06' }), (x) => /probation/.test(x.details.join()));
}));

test('project coverage warning and availability-only team calendar', () => withToday(T, () => {
  const { db, as } = fresh();
  db.prepare("UPDATE project_assignments SET end_date = '2026-12-31'").run();
  const s = leave.submitRequest(db, as(SYN.senior), { typeCode: 'AV', start: '2026-12-20', end: '2026-12-22', coverUserId: SYN.lead, reason: 'Private family matter' });
  leave.decideRequest(db, as(SYN.manager), s.id, { decision: 'approve' });
  const p = leave.previewRequest(db, as(SYN.emp), { typeCode: 'AV', start: '2026-12-21', end: '2026-12-21', coverUserId: SYN.lead });
  assert.ok(p.warnings.some((w) => /Sara Senior also away/.test(w)));
  const cal = leave.teamCalendar(db, as(SYN.emp), { from: '2026-12-01', to: '2026-12-31' });
  assert.equal(cal[0].availability, 'Away');
  assert.equal(JSON.stringify(cal).includes('Private family'), false);
  assert.equal(JSON.stringify(cal).includes('Annual'), false);
  // reasons: owner, approver and ops only
  assert.equal(leave.requestView(db, as(SYN.peer), s), null);
  assert.equal(leave.requestView(db, as(SYN.manager), s).reason, 'Private family matter');
  assert.equal(leave.requestView(db, as(SYN.otherUser), s), null);
}));

test('carryover capped at 10 days and expiry of unused carryover', () => withToday('2027-10-05', () => {
  const { db, as } = fresh();
  const ops = as(SYN.ops);
  leave.adjustBalance(db, ops, { userId: SYN.emp, typeCode: 'AV', year: 2026, amountX100: 200, note: 'Synthetic top-up' }); // 16 days left
  const c = leave.runCarryover(db, ops, { fromYear: 2026 });
  assert.equal(c.find((x) => x.userId === SYN.emp).carry_x100, 1000);
  leave.runCarryover(db, ops, { fromYear: 2026 }); // idempotent
  assert.equal(bal(db, SYN.emp, 'AV', 2027).posted_x100, 1000);
  assert.equal(bal(db, SYN.emp, 'AV', 2026).posted_x100, 600);
  // use 3 days of 2027 before September expiry → 7 days expire
  db.prepare("INSERT INTO leave_ledger (tenant_id, user_id, type_id, period_year, kind, amount_x100, effective_date, entry_key, created_at) VALUES ('gb', ?, 'lt_AV', 2027, 'usage', -300, '2027-03-01', 'test-use', 'x')").run(SYN.emp);
  const ex = leave.runCarryoverExpiry(db, ops, { year: 2027 });
  assert.equal(ex.expired.find((x) => x.userId === SYN.emp).expired_x100, 700);
  leave.runCarryoverExpiry(db, ops, { year: 2027 });
  assert.equal(bal(db, SYN.emp, 'AV', 2027).posted_x100, 0);
}));
