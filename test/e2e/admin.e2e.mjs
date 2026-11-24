// Browser smoke test for AI examples and the Admin pages (synthetic data only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN } from '../helpers.js';
import { createServer } from '../../src/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

test('admin pages and AI examples render on desktop and phone; roster edit and policy approval use drawers/modals', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db } = fresh();
  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const errors = []; const dialogs = [];
  const pageAs = async (userId, viewport) => {
    const p = await (await browser.newContext({ viewport })).newPage();
    p.on('pageerror', (e) => errors.push(e.message)); p.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    p.on('console', (m) => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errors.push(m.text()); });
    await p.goto(base);
    await p.evaluate(async (id) => { await fetch('/api/dev/login', { method: 'POST', headers: { 'X-Requested-With': 'prism' }, body: JSON.stringify({ userId: id }) }); }, userId);
    await p.reload(); await p.waitForSelector('.sidebar');
    return p;
  };
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const p = await pageAs(SYN.ops, viewport);
      for (const hash of ['#/admin/dashboard', '#/admin/roster', '#/admin/policy', '#/admin/reminders', '#/admin/ai', '#/admin/audit', '#/ai']) {
        await p.goto(base + hash); await p.waitForSelector('main .card, main .empty');
        assert.equal(await p.$('main .page.legacy'), null, `${hash} uses the new design`);
        assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no horizontal scroll on ${hash} at ${viewport.width}px`);
      }
    }
    const p = await pageAs(SYN.ops, { width: 1440, height: 900 });
    await p.goto(`${base}#/admin/roster`); await p.click('table.data tbody tr:has-text("Eli Employee")'); await p.waitForSelector('.drawer #re_title');
    await p.fill('#re_title', 'Senior Analyst'); await p.click('.drawer-footer button:has-text("Save")');
    await p.waitForFunction(() => !document.querySelector('.drawer'));
    assert.equal(db.prepare("SELECT title FROM employments WHERE user_id = ? AND effective_to IS NULL").get(SYN.emp).title, 'Senior Analyst');
    const partner = await pageAs(SYN.partner, { width: 1440, height: 900 });
    await partner.goto(`${base}#/admin/policy`).catch(() => {});
    const ops = await pageAs(SYN.ops, { width: 1440, height: 900 });
    await ops.goto(`${base}#/admin/policy`); await ops.click('button:has-text("Record GB approval")'); await ops.waitForSelector('.modal');
    await ops.click('.modal button:has-text("Cancel")');
    assert.equal(db.prepare("SELECT status FROM policy_versions WHERE version = 1").get().status, 'awaiting_confirmation');
    assert.deepEqual(dialogs, []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
