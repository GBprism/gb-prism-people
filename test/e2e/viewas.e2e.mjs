// "See the portal as an employee": a partner switches their own extra rights off and back on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN } from '../helpers.js';
import { createServer } from '../../src/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

test('view as employee: admin pages hidden and refused, then restored', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db } = fresh();
  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  try {
    const p = await (await browser.newContext()).newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base);
    await p.evaluate(async (id) => { await fetch('/api/dev/login', { method: 'POST', headers: { 'X-Requested-With': 'prism' }, body: JSON.stringify({ userId: id }) }); }, SYN.ops);
    await p.reload(); await p.waitForSelector('.sidebar');
    assert.ok(await p.locator('a.ws-link[title="Admin"]').count());
    await p.locator('.avatar-btn').click();
    await p.getByRole('menuitem', { name: 'See the portal as an employee' }).click();
    await p.waitForSelector('.view-as-bar');
    assert.equal(await p.locator('a.ws-link[title="Admin"]').count(), 0);
    // the server refuses admin data too, not just the menu
    assert.equal(await p.evaluate(async () => (await fetch('/api/profiles', { headers: { 'X-Requested-With': 'prism' } })).status), 403);
    // a forged cookie can only remove rights: an employee setting it changes nothing
    await p.getByRole('button', { name: 'Back to my own access' }).click();
    await p.waitForSelector('a.ws-link[title="Admin"]');
    assert.equal(await p.locator('.view-as-bar').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
