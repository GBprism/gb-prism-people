import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN, withToday } from './helpers.js';
import * as leave from '../src/domain/leave.js';
import * as msg from '../src/domain/messages.js';
import * as gym from '../src/domain/gym.js';
import * as claude from '../src/domain/claude.js';
import { reports } from '../src/domain/reports.js';
import * as ev from '../src/domain/events.js';

test('leave: the project manager approves first, then the final approver; PM sees no balance and cannot cancel', () => withToday('2026-11-01', () => {
  const { db, as } = fresh();
  // the employee is on Project Alpha (lead: SYN.lead) all year
  const r = leave.submitRequest(db, as(SYN.emp), { typeCode: 'AV', start: '2026-11-16', end: '2026-11-17', coverUserId: SYN.senior });
  assert.equal(r.stage, 'pm'); assert.equal(r.pm_id, SYN.lead);
  ev.leaveChanged(db, r);
  assert.ok(db.prepare("SELECT 1 FROM notification_outbox WHERE event = 'leave.pm' AND recipient_id = ?").get(SYN.lead), 'the PM is emailed first');
  const v = leave.requestView(db, as(SYN.lead), r);
  assert.equal(v.can_decide, true); assert.equal(v.can_cancel, false);
  assert.throws(() => leave.cancelRequest(db, as(SYN.lead), r.id, { reason: 'x' }), /Only GB/);
  const afterPm = leave.decideRequest(db, as(SYN.lead), r.id, { decision: 'approve', note: 'Fine for the project' });
  assert.equal(afterPm.stage, 'final'); assert.equal(afterPm.state, 'submitted');
  assert.throws(() => leave.decideRequest(db, as(SYN.lead), r.id, { decision: 'approve' }), /already decided|Only the assigned/);
  const approver = afterPm.approver_id;
  const done = leave.decideRequest(db, as(approver), r.id, { decision: 'approve' });
  assert.equal(done.state, 'approved');
  // the final approver can cancel it, with a reason; days come back
  const c = leave.cancelRequest(db, as(approver), r.id, { reason: 'Booked by mistake' });
  assert.equal(c.state, 'cancelled');
  // the PM can decline on their own step
  const r2 = leave.submitRequest(db, as(SYN.emp), { typeCode: 'AV', start: '2026-11-23', end: '2026-11-23', coverUserId: SYN.senior });
  assert.equal(leave.decideRequest(db, as(SYN.lead), r2.id, { decision: 'decline', note: 'Client workshop that day' }).state, 'declined');
}));

test('messages: only members read a conversation; unread counts; groups from a project', () => {
  const { db, as } = fresh();
  const { id } = msg.directWith(db, as(SYN.emp), SYN.senior);
  assert.equal(msg.directWith(db, as(SYN.senior), SYN.emp).id, id, 'one direct conversation per pair');
  msg.sendMessage(db, as(SYN.emp), id, 'Hi — can you review slide 4?');
  assert.equal(msg.unreadCount(db, as(SYN.senior)), 1);
  for (const who of [SYN.partner, SYN.ops, SYN.peer]) assert.throws(() => msg.readMessages(db, as(who), id), /Not permitted/);
  assert.equal(msg.readMessages(db, as(SYN.senior), id).messages[0].body, 'Hi — can you review slide 4?');
  assert.equal(msg.unreadCount(db, as(SYN.senior)), 0);
  const g = msg.createGroup(db, as(SYN.lead), { title: 'Alpha team', projectId: 'prj_alpha' });
  const members = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(g.id).map((r) => r.user_id).sort();
  assert.deepEqual(members, [SYN.emp, SYN.lead, SYN.senior].sort());
  assert.throws(() => msg.sendMessage(db, as(SYN.emp), g.id, '   '), /Write a message/);
});

test('gym allowance: registration document required; approved by People Ops, never by yourself', () => {
  const { db, as } = fresh();
  const PDF = Buffer.from('%PDF-1.4\n');
  assert.throws(() => gym.submitGym(db, as(SYN.emp), { gym_name: 'Gym', valid_from: '2026-01-01', valid_to: '2026-12-31' }, null, 'x'), /Attach/);
  const g = gym.submitGym(db, as(SYN.emp), { gym_name: 'Fitness First', valid_from: '2026-01-01', valid_to: '2026-12-31' }, PDF, 'reg.pdf');
  assert.throws(() => gym.decideGym(db, as(SYN.peer), g.id, { decision: 'approve' }), /Not permitted/);
  assert.throws(() => gym.gymFile(db, as(SYN.peer), g.id), /Not permitted/);
  gym.decideGym(db, as(SYN.ops), g.id, { decision: 'approve' });
  assert.match(db.prepare('SELECT gym_stipend_status s FROM employee_profiles WHERE user_id = ?').get(SYN.emp).s, /Eligible/);
  const own = gym.submitGym(db, as(SYN.ops), { gym_name: 'X', valid_from: '2026-01-01', valid_to: '2026-06-30' }, PDF, 'r.pdf');
  assert.throws(() => gym.decideGym(db, as(SYN.ops), own.id, { decision: 'approve' }), /Someone else/);
});

test('Claude accounts and reports: everyone sees seats; only partners / People Ops edit and see reports', () => {
  const { db, as } = fresh();
  assert.throws(() => claude.saveAccount(db, as(SYN.emp), null, { seat_email: 'x@gb.test' }), /Not permitted/);
  const { id } = claude.saveAccount(db, as(SYN.ops), null, { seat_email: 'seat1@gb.test', users: [{ user_id: SYN.emp, project_id: 'prj_alpha', working_on: 'Strategy deck' }] });
  const v = claude.claudeView(db, as(SYN.peer));
  assert.equal(v.active, 1); assert.equal(v.accounts[0].users[0].project, 'Project Alpha — strategy');
  claude.setMyWork(db, as(SYN.emp), id, { working_on: 'KPI cascade' });
  assert.throws(() => claude.setMyWork(db, as(SYN.peer), id, { working_on: 'x' }), /not on this account/);
  assert.throws(() => reports(db, as(SYN.emp)), /Not permitted/);
  const r = reports(db, as(SYN.partner), { year: 2026 });
  assert.ok(r.people.headcount > 0); assert.equal(r.claude.active, 1);
});
