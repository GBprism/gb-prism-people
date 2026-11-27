// Browser test of the redesigned workspace through three real flows (synthetic data only):
//   1. a new joiner completes their next onboarding step from Home
//   2. a consultant checks their next project milestone and submits their timesheet
//   3. a project lead goes from their own goals to team approvals and the resource calendar
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN } from '../helpers.js';
import { createServer } from '../../src/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

test('workspace flows: new joiner, consultant, project lead', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db } = fresh();
  const T = SYN.tenant;
  // new joiner started three days ago, with three onboarding steps (two are theirs)
  db.prepare('UPDATE employments SET hire_date = ? WHERE user_id = ?').run(iso(-3), SYN.newbie);
  const item = db.prepare("INSERT INTO onboarding_items (id, tenant_id, key, title, stage, owner, action, position) VALUES (?,?,?,?,?,?,?,?)");
  item.run('ob1', T, 'laptop', 'Set up your laptop and Google account', 'day1', 'new_joiner', 'setup', 1);
  item.run('ob2', T, 'handbook', 'Read the employee handbook', 'week1', 'new_joiner', 'read', 2);
  item.run('ob3', T, 'contract', 'Sign your contract', 'day1', 'hr', 'sign', 3);
  // a dated milestone on Project Alpha, and a colleague waiting for the lead to confirm them
  db.prepare("INSERT INTO deliverables (id, tenant_id, project_id, workstream, title, milestone, due_date, status) VALUES ('dl_draft', ?, 'prj_alpha', 'Strategy', 'Strategy draft v1', 'Draft deliverable', ?, 'in_progress')").run(T, iso(5));
  db.prepare("INSERT INTO project_assignments (id, tenant_id, project_id, user_id, role, status) VALUES ('asg_peer_alpha', ?, 'prj_alpha', ?, 'analyst', 'tentative')").run(T, SYN.peer);

  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const errors = [];
  const pageAs = async (userId, viewport = { width: 1440, height: 900 }) => {
    const p = await (await browser.newContext({ viewport })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errors.push(m.text()); });
    await p.goto(base);
    await p.evaluate(async (id) => { await fetch('/api/dev/login', { method: 'POST', headers: { 'X-Requested-With': 'prism' }, body: JSON.stringify({ userId: id }) }); }, userId);
    await p.reload(); await p.waitForSelector('.home-hero');
    return p;
  };
  try {
    // 1 ---- new joiner: Home leads with onboarding; one click to the step; progress moves
    const nj = await pageAs(SYN.newbie);
    assert.match(await nj.textContent('.focus'), /Onboarding · 0 of 3 done/);
    assert.match(await nj.textContent('.focus-title'), /Set up your laptop/);
    await nj.getByRole('link', { name: 'Continue onboarding' }).click();
    await nj.waitForFunction(() => location.hash === '#/onboarding');
    await nj.getByRole('button', { name: 'Mark done' }).first().click(); await nj.waitForSelector('text=1 of 3 steps done');
    await nj.click('a.nav-item[href="#/"]'); await nj.waitForSelector('.focus');
    assert.match(await nj.textContent('.focus'), /1 of 3 done/);
    assert.match(await nj.textContent('.focus-title'), /Read the employee handbook/);

    // 2 ---- consultant: next milestone from Home → project page; then the timesheet
    const emp = await pageAs(SYN.emp);
    assert.match(await emp.textContent('.home-projects'), /Draft deliverable/);
    await emp.click('.home-projects a[href="#/project/prj_alpha"]'); await emp.waitForSelector('.next-tile');
    assert.match(await emp.textContent('.next-tile'), /Draft deliverable/);
    assert.match(await emp.textContent('.proj-facts'), /Leo Lead/);
    assert.equal(await emp.$eval('.nav-item[aria-current="page"] .nav-label', (e) => e.textContent), 'My Work');
    await emp.click('a.section-tab[href="#/timesheet"]'); await emp.waitForSelector('.ts-grid');
    await emp.locator('.ts-cell').first().fill('7'); await emp.waitForSelector('.save-state:text("Saved")');
    await emp.getByRole('button', { name: 'Submit month' }).click(); await emp.waitForSelector('text=Submitted');
    // phone width: Home stacks without sideways scroll
    const phone = await pageAs(SYN.emp, { width: 390, height: 844 });
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Home scrolls sideways on a phone');
    const order = await phone.$$eval('.home-attn, .home-week, .home-projects', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    assert.ok(order[0] < order[1] && order[1] < order[2], 'attention, then this week, then projects');

    // 3 ---- project lead: own goals on Home → Manager → approvals → resource calendar
    const lead = await pageAs(SYN.lead);
    assert.match(await lead.textContent('.focus-title'), /self-assessment/);
    assert.equal(await lead.locator('.home-attn :text("Confirm team")').count(), 0, 'team approvals stay out of personal Home');
    await lead.locator('.focus-actions a').click(); await lead.waitForFunction(() => location.hash.startsWith('#/review/'));
    await lead.waitForSelector('.nav-item[aria-current="page"]');
    assert.equal(await lead.$eval('.nav-item[aria-current="page"] .nav-label', (e) => e.textContent), 'My Growth');
    await lead.click('a.ws-link[title="Manager"]'); await lead.waitForSelector('.approvals');
    assert.match(await lead.textContent('.approvals'), /Confirm team/);
    await lead.click('a.nav-item[href="#/staffing"]'); await lead.waitForSelector('.wk-grid');
    assert.match(await lead.textContent('.wk-grid'), /Project Alpha/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
