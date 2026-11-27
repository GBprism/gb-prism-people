import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN } from './helpers.js';
import * as pc from '../src/domain/projectchanges.js';
import { applyActiveProjects } from '../src/imports/active-projects.js';

test('project changes: employee asks, the lead decides, the assignment follows', () => {
  const { db, as } = fresh();
  const E = as(SYN.emp);
  const ed = pc.myProjectsEditor(db, E);
  assert.ok(ed.mine.some((a) => a.project_id === 'prj_alpha'));
  assert.ok(!ed.running.some((p) => p.id === 'prj_alpha'), 'cannot ask to join a project already on');
  // join Beta? already on it (provisional) — so leave Alpha and correct the role on Beta instead
  const alpha = ed.mine.find((a) => a.project_id === 'prj_alpha');
  const beta = ed.mine.find((a) => a.project_id === 'prj_beta');
  assert.throws(() => pc.requestChanges(db, E, {}), /Nothing to send/);
  assert.equal(pc.requestChanges(db, E, { leave: [{ assignment_id: alpha.id, end_date: '2026-12-31' }], role: [{ assignment_id: beta.id, role: 'author' }] }).created, 2);
  // the lead of Alpha decides the Alpha change only; Beta's lead (am) decides Beta
  assert.deepEqual(pc.pendingFor(db, as(SYN.lead)).map((r) => r.kind), ['leave']);
  assert.deepEqual(pc.pendingFor(db, as(SYN.am)).map((r) => r.kind), ['role']);
  assert.deepEqual(pc.pendingFor(db, as(SYN.peer)), []);
  const leaveReq = pc.pendingFor(db, as(SYN.lead))[0];
  assert.throws(() => pc.decideChange(db, as(SYN.peer), leaveReq.id, { decision: 'approve' }), /Not permitted/);
  assert.throws(() => pc.decideChange(db, E, leaveReq.id, { decision: 'approve' }), /Not permitted/);
  assert.throws(() => pc.decideChange(db, as(SYN.lead), leaveReq.id, { decision: 'decline' }), /why/);
  pc.decideChange(db, as(SYN.lead), leaveReq.id, { decision: 'approve' });
  assert.equal(db.prepare('SELECT end_date FROM project_assignments WHERE id = ?').get(alpha.id).end_date, '2026-12-31');
  pc.decideChange(db, as(SYN.am), pc.pendingFor(db, as(SYN.am))[0].id, { decision: 'decline', note: 'You support on Beta' });
  assert.equal(db.prepare('SELECT role FROM project_assignments WHERE id = ?').get(beta.id).role, 'support');
  // join a project without a lead: partners / People Ops decide
  db.prepare("INSERT INTO projects (id, tenant_id, name, kind, status, register_status) VALUES ('prj_new', ?, 'New work', 'engagement', 'active', 'approved')").run(SYN.tenant);
  assert.throws(() => pc.requestChanges(db, E, { join: [{ project_id: 'prj_new' }] }), /Say what you do/);
  pc.requestChanges(db, E, { join: [{ project_id: 'prj_new', role: 'analyst', start_date: '2026-12-01' }] });
  const j = pc.pendingFor(db, as(SYN.partner)).find((r) => r.kind === 'join');
  pc.decideChange(db, as(SYN.partner), j.id, { decision: 'approve' });
  assert.ok(db.prepare("SELECT 1 FROM project_assignments WHERE project_id = 'prj_new' AND user_id = ? AND status = 'confirmed' AND start_date = '2026-12-01'").get(SYN.emp));
  // the email goes to the deciders, the result to the employee
  const mails = db.prepare("SELECT event, recipient_id FROM notification_outbox WHERE event LIKE 'project.change%'").all();
  assert.ok(mails.some((m) => m.event === 'project.change' && m.recipient_id === SYN.lead));
  assert.ok(mails.some((m) => m.event === 'project.change.approve' && m.recipient_id === SYN.emp));
});

test('active projects list: listed projects and people only; everything else completed', () => {
  const { db, as } = fresh();
  const r = applyActiveProjects(db, as(SYN.partner), { projects: [
    { name: 'Project Beta — feasibility', people: ['eli@example.test', 'Sara Senior'] },
    { name: 'Brand new work', client: 'New client', people: ['Pia Peer', 'nobody@example.test'] },
  ] }, { asOf: '2026-11-27' });
  assert.equal(db.prepare("SELECT status FROM projects WHERE id = 'prj_alpha'").get().status, 'completed');
  assert.equal(db.prepare("SELECT end_date FROM project_assignments WHERE id = 'asg_emp_alpha'").get().end_date, '2026-11-26');
  assert.equal(db.prepare("SELECT status FROM project_assignments WHERE id = 'asg_emp_beta'").get().status, 'confirmed');
  const nw = db.prepare("SELECT id FROM projects WHERE name = 'Brand new work'").get();
  assert.ok(db.prepare('SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ?').get(nw.id, SYN.peer));
  assert.ok(r.warnings.some((w) => /nobody@example.test/.test(w)));
  assert.ok(r.closed.some((c) => /Project Alpha/.test(c)));
});
