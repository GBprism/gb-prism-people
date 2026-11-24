// Browser smoke test for the phase 5 screens (synthetic data only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN } from '../helpers.js';
import { createServer } from '../../src/server.js';
import * as leave from '../../src/domain/leave.js';
import { createProject } from '../../src/domain/projects.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

test('phase 5 screens: time off, request decision, inbox, projects, my reviews', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db, as } = fresh();
  const future = new Date(Date.now() + 30 * 864e5); while ([5, 6].includes(future.getDay())) future.setDate(future.getDate() + 1);
  const d = future.toISOString().slice(0, 10);
  const req = leave.submitRequest(db, as(SYN.emp), { typeCode: 'AV', start: d, end: d, coverUserId: SYN.senior, clientKey: 'e2e' });
  const prj = createProject(db, as(SYN.ops), { name: 'Omega review', kind: 'engagement', leadUserId: SYN.lead });
  db.prepare("INSERT INTO project_assignments (id, tenant_id, project_id, user_id, role, status, source) VALUES ('asg_e2e', 'gb', ?, ?, 'Analysis', 'tentative', 'test')").run(prj, SYN.emp);
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
    await p.reload(); await p.waitForSelector('.sidebar');
    return p;
  };
  const noScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  try {
    const emp = await pageAs(SYN.emp);
    await emp.goto(`${base}#/timeoff`); await emp.waitForSelector('.leave-form');
    assert.match(await emp.textContent('main'), /Waiting for approval/);
    await emp.fill('#f_start', d); await emp.fill('#f_end', d);
    await emp.waitForSelector('.leave-sum'); // live preview
    await emp.goto(`${base}#/history`); await emp.waitForSelector('table.data, .empty');

    const approver = db.prepare('SELECT approver_id FROM leave_requests WHERE id = ?').get(req.id).approver_id;
    const mgr = await pageAs(approver);
    await mgr.goto(`${base}#/inbox`); await mgr.waitForSelector('.task-list');
    assert.match(await mgr.textContent('.task-list'), /Time-off request/);
    await mgr.click('.task-list a[href^="#/request/"]'); await mgr.waitForSelector('.request-head');
    await mgr.click('button:has-text("Decline")'); // a note is required to decline
    assert.equal(db.prepare('SELECT state FROM leave_requests WHERE id = ?').get(req.id).state, 'submitted');
    await mgr.click('button:has-text("Approve")'); await mgr.waitForFunction(() => location.hash === '#/inbox');
    assert.equal(db.prepare('SELECT state FROM leave_requests WHERE id = ?').get(req.id).state, 'approved');

    const lead = await pageAs(SYN.lead);
    await lead.goto(`${base}#/projects?p=${prj}`); await lead.waitForSelector(`#project-${prj}`);
    await lead.click(`#project-${prj} button:has-text("Confirm")`); await lead.waitForTimeout(300);
    assert.equal(db.prepare("SELECT status FROM project_assignments WHERE id = 'asg_e2e'").get().status, 'confirmed');

    const partner = await pageAs(SYN.partner);
    await partner.goto(`${base}#/projects?status=candidate`); await partner.waitForSelector(`#project-${prj}`);
    await partner.click(`#project-${prj} .card-actions button:has-text("Approve")`); await partner.waitForTimeout(300);
    assert.equal(db.prepare('SELECT register_status FROM projects WHERE id = ?').get(prj).register_status, 'approved');

    for (const hash of ['#/timeoff', '#/inbox', '#/projects', '#/history']) {
      const m = await pageAs(SYN.manager, { width: 390, height: 844 });
      await m.goto(base + hash); await m.waitForSelector('main .card, main .empty');
      assert.ok(await noScroll(m), `no horizontal scroll on ${hash} at 390px`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
