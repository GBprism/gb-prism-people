import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN } from './helpers.js';
import { createProject, confirmAssignment, restoreAssignment, setProjectLead } from '../src/domain/projects.js';

const add = (db, project, user, status = 'tentative') => {
  const id = `asg_t_${user}_${project}`;
  db.prepare("INSERT INTO project_assignments (id, tenant_id, project_id, user_id, role, status, source) VALUES (?, 'gb', ?, ?, 'Analysis', ?, 'test')").run(id, project, user, status);
  return id;
};

test('assignments: lead confirms the team, partner confirms the lead, rejection removes an unconfirmed lead', () => {
  const { db, as } = fresh();
  const p = createProject(db, as(SYN.ops), { name: 'Gamma', kind: 'engagement', leadUserId: SYN.lead });
  const team = add(db, p, SYN.emp); const leadOwn = add(db, p, SYN.lead); const wrong = add(db, p, SYN.peer, 'provisional');
  assert.throws(() => confirmAssignment(db, as(SYN.peer), team), /Only the project lead/);
  assert.equal(confirmAssignment(db, as(SYN.lead), team).status, 'confirmed');
  assert.throws(() => confirmAssignment(db, as(SYN.lead), leadOwn), /your own assignment/);
  assert.throws(() => confirmAssignment(db, as(SYN.manager), leadOwn), /Only the project lead/);
  assert.equal(confirmAssignment(db, as(SYN.partner), leadOwn).status, 'confirmed');
  assert.throws(() => confirmAssignment(db, as(SYN.partner), team, { decision: 'reject' }), /Only the project lead|cannot be removed/);
  assert.throws(() => confirmAssignment(db, as(SYN.lead), wrong, { decision: 'reject' }), /why/);
  const { removed } = confirmAssignment(db, as(SYN.lead), wrong, { decision: 'reject', note: 'only copied on emails' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM project_assignments WHERE id = ?').get(wrong).n, 0);
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action = 'assignment.reject' AND entity_id = ?").get(wrong));
  assert.throws(() => confirmAssignment(db, as(SYN.lead), team, { decision: 'reject', note: 'x' }), /cannot be removed/);
  // a mistaken removal is restored exactly as it was, once
  assert.throws(() => restoreAssignment(db, as(SYN.emp), removed), /Only the project lead/);
  restoreAssignment(db, as(SYN.lead), removed);
  assert.equal(db.prepare('SELECT status FROM project_assignments WHERE id = ?').get(wrong).status, 'provisional');
  assert.throws(() => restoreAssignment(db, as(SYN.lead), removed), /Already restored/);
  // partners set a missing lead; others cannot
  const q = createProject(db, as(SYN.ops), { name: 'No lead yet', kind: 'engagement' });
  assert.throws(() => setProjectLead(db, as(SYN.lead), q, SYN.lead), /Not permitted/);
  setProjectLead(db, as(SYN.partner), q, SYN.senior);
  assert.equal(db.prepare('SELECT lead_user_id FROM projects WHERE id = ?').get(q).lead_user_id, SYN.senior);
});

test('inbox: leads see "Confirm team"; partners see projects awaiting approval', async () => {
  const { createServer } = await import('../src/server.js');
  const { db, as } = fresh();
  const p = createProject(db, as(SYN.ops), { name: 'Delta', kind: 'engagement', leadUserId: SYN.lead });
  add(db, p, SYN.emp);
  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = async (userId) => {
    const r = await fetch(`${base}/api/dev/login`, { method: 'POST', headers: { 'X-Requested-With': 'prism', 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return async (path) => (await fetch(base + path, { headers: { cookie, 'X-Requested-With': 'prism' } })).json();
  };
  try {
    const lead = await (await login(SYN.lead))('/api/inbox');
    assert.ok(lead.items.some((i) => i.kind === 'Confirm team' && /Delta \(1 person\)/.test(i.title) && i.link === `#/projects?p=${p}`));
    const partner = await (await login(SYN.partner))('/api/inbox');
    assert.ok(partner.items.some((i) => i.kind === 'Approve projects'));
    const emp = await (await login(SYN.emp))('/api/inbox');
    assert.ok(!emp.items.some((i) => ['Confirm team', 'Approve projects'].includes(i.kind)));
  } finally { srv.close(); }
});
