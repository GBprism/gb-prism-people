import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN } from './helpers.js';
import { createServer } from '../src/server.js';
import { myWeek, projectOverview } from '../src/domain/myweek.js';
import { calendar } from '../src/domain/staffing.js';

const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

async function serve(db) {
  const srv = createServer(db, { devLogin: true }); await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const as = async (userId) => {
    const r = await fetch(`${base}/api/dev/login`, { method: 'POST', headers: { 'X-Requested-With': 'prism' }, body: JSON.stringify({ userId }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return async (path) => { const x = await fetch(base + path, { headers: { cookie, 'X-Requested-With': 'prism' } }); return { status: x.status, body: await x.json() }; };
  };
  return { as, close: () => srv.close() };
}

test('my week: personal tasks only, onboarding leads for a new joiner, agenda from own records', () => {
  const { db, as } = fresh();
  db.prepare('UPDATE employments SET hire_date = ? WHERE user_id = ?').run(iso(-2), SYN.newbie);
  db.prepare("INSERT INTO onboarding_items (id, tenant_id, key, title, stage, owner, action, position) VALUES ('o1', ?, 'k1', 'Set up your laptop', 'day1', 'new_joiner', 'setup', 1)").run(SYN.tenant);
  const nj = myWeek(db, as(SYN.newbie));
  assert.equal(nj.mode, 'onboarding');
  assert.equal(nj.attention[0].link, '#/onboarding');
  // a long-standing employee does not see onboarding; their review step leads instead
  const emp = myWeek(db, as(SYN.emp), { reviewNext: { label: 'Complete your 2026 year-end review self-assessment', due: iso(10), link: '#/review/x' } });
  assert.equal(emp.onboarding, null); assert.equal(emp.mode, 'review');
  assert.ok(emp.week.some((w) => w.kind === 'deadline' && w.link === '#/review/x'));
  // milestones on my projects show; projects I am not on do not
  db.prepare("INSERT INTO deliverables (id, tenant_id, project_id, title, milestone, due_date, status) VALUES ('dx', ?, 'prj_alpha', 'Draft', 'Client workshop', ?, 'in_progress')").run(SYN.tenant, iso(4));
  assert.ok(myWeek(db, as(SYN.emp)).week.some((w) => w.title === 'Client workshop'));
  assert.ok(!myWeek(db, as(SYN.peer)).week.some((w) => w.title === 'Client workshop'));
  // timesheet nags only for months when timesheets were in use
  const last = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); })();
  assert.ok(!myWeek(db, as(SYN.emp)).attention.some((a) => a.link === `#/timesheet?m=${last}`));
  db.prepare("INSERT INTO timesheet_months (user_id, month, tenant_id, status) VALUES (?, ?, ?, 'approved')").run(SYN.peer, last, SYN.tenant);
  assert.ok(myWeek(db, as(SYN.emp)).attention.some((a) => a.link === `#/timesheet?m=${last}`));
});

test('project page: basics for everyone on a running project; deliverables, team and timeline for the team only', () => {
  const { db, as } = fresh();
  db.prepare("INSERT INTO deliverables (id, tenant_id, project_id, title, due_date, status) VALUES ('dy', ?, 'prj_alpha', 'Draft', ?, 'in_progress')").run(SYN.tenant, iso(3));
  const mine = projectOverview(db, as(SYN.emp), 'prj_alpha');
  assert.equal(mine.full, true); assert.equal(mine.me.role, 'analyst'); assert.equal(mine.next.id, 'dy');
  assert.equal(mine.can.commercial, false, 'no budget link for a consultant');
  const other = projectOverview(db, as(SYN.peer), 'prj_alpha');
  assert.equal(other.full, false); assert.deepEqual(other.deliverables, []); assert.deepEqual(other.team, []); assert.equal(other.me, null);
  assert.equal(projectOverview(db, as(SYN.partner), 'prj_alpha').can.commercial, true);
  db.prepare("UPDATE projects SET status = 'closed' WHERE id = 'prj_alpha'").run();
  assert.throws(() => projectOverview(db, as(SYN.peer), 'prj_alpha'), /Not permitted/);
});

test('inbox scope: approvals of other people’s work go to Manager, own tasks to Home', async () => {
  const { db } = fresh();
  db.prepare("INSERT INTO project_assignments (id, tenant_id, project_id, user_id, role, status) VALUES ('asg_t', ?, 'prj_alpha', ?, 'analyst', 'tentative')").run(SYN.tenant, SYN.peer);
  const s = await serve(db);
  try {
    const lead = await s.as(SYN.lead);
    const team = (await lead('/api/inbox?scope=team')).body.items;
    assert.ok(team.some((i) => i.kind === 'Confirm team'));
    const week = (await lead('/api/my-week')).body;
    assert.ok(!week.attention.some((a) => /Confirm team/.test(`${a.title} ${a.detail}`)));
    assert.ok(week.team_waiting >= 1);
    const me = (await (await s.as(SYN.emp))('/api/me')).body;
    assert.equal(me.nav.manager, false, 'a consultant with no reports, reviews or projects to lead has no Manager workspace');
    assert.equal((await (await s.as(SYN.manager))('/api/me')).body.nav.manager, true);
  } finally { s.close(); }
});

test('resource calendar: day-level spans and away days, never leave reasons', () => {
  const { db, as } = fresh();
  const v = calendar(db, as(SYN.emp), { weeks: 4 });
  const row = v.people.find((p) => p.id === SYN.emp);
  assert.ok(row.spans.some((s) => s.project_id === 'prj_alpha'));
  assert.ok(Array.isArray(row.away));
  for (const a of row.away) assert.deepEqual(Object.keys(a).sort(), ['date', 'share']);
  assert.ok(Array.isArray(v.weeks[0].days));
});
