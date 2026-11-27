// Browser smoke test for the app shell. Run: npm run test:e2e
// Uses the globally installed Playwright; skips cleanly if it is not available.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN } from '../helpers.js';
import { createServer } from '../../src/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

test('shell: sidebar by role, breadcrumbs, ⌘K palette, collapse, mobile drawer, no errors', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db } = fresh();
  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const errors = [];
  const pageAs = async (userId, viewport = { width: 1440, height: 900 }) => {
    const p = await (await browser.newContext({ viewport })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) errors.push(m.text()); });
    await p.goto(base);
    await p.evaluate(async (id) => { await fetch('/api/dev/login', { method: 'POST', headers: { 'X-Requested-With': 'prism' }, body: JSON.stringify({ userId: id }) }); }, userId);
    await p.reload(); await p.waitForSelector('.sidebar');
    return p;
  };
  try {
    // employee: four destinations, no workspace switcher; Home is current
    const emp = await pageAs(SYN.emp);
    const labels = await emp.$$eval('.sidebar .nav-group .nav-label', (els) => els.map((e) => e.textContent));
    assert.deepEqual(labels, ['Home', 'My Work', 'My Growth', 'Company']);
    assert.equal(await emp.locator('.ws-switch').count(), 0);
    assert.equal(await emp.$eval('.nav-item[aria-current="page"] .nav-label', (e) => e.textContent), 'Home');
    assert.match(await emp.$eval('.home-hero h1', (e) => e.textContent), /^Good (morning|afternoon|evening), Eli$/);
    // ⌘K / Ctrl+K palette → Time off
    await emp.keyboard.press('Control+k');
    await emp.waitForSelector('.palette');
    await emp.keyboard.type('time off');
    await emp.keyboard.press('Enter');
    await emp.waitForFunction(() => location.hash === '#/timeoff');
    await emp.waitForSelector('.section-tab[aria-current="page"]');
    assert.equal(await emp.$eval('.section-tab[aria-current="page"]', (e) => e.textContent), 'Requests');
    assert.equal(await emp.$eval('.nav-item[aria-current="page"] .nav-label', (e) => e.textContent), 'My Work');
    // collapse persists across reload
    await emp.click('button.nav-item[aria-label="Collapse sidebar"]');
    await emp.reload(); await emp.waitForSelector('.app-shell');
    assert.ok(await emp.$eval('.app-shell', (e) => e.classList.contains('collapsed')));
    // People Ops: workspace switcher with Admin; admin pages switch the sidebar
    const ops = await pageAs(SYN.ops);
    assert.deepEqual(await ops.$$eval('.ws-link .nav-label', (els) => els.map((e) => e.textContent)), ['My workspace', 'Manager', 'Admin']);
    await ops.click('a.ws-link[title="Admin"]'); await ops.waitForSelector('.nav-group-label');
    assert.equal(await ops.$eval('.nav-group-label', (e) => e.textContent), 'Admin');
    await ops.goto(`${base}#/admin/imports`); await ops.waitForSelector('.page-header h1');
    assert.equal(await ops.$eval('.page-header h1', (e) => e.textContent), 'Imports');
    // mobile: drawer opens from the menu button; no horizontal scroll
    const mob = await pageAs(SYN.manager, { width: 390, height: 844 });
    assert.equal(await mob.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await mob.click('button[aria-label="Open menu"]');
    assert.ok(await mob.$eval('.app-shell', (e) => e.classList.contains('nav-open')));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
