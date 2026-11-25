// When the sign-in ends while the portal is open, the next action returns to the sign-in page (no error box).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN } from '../helpers.js';
import { createServer } from '../../src/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

test('expired session: back to sign-in, not an error', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db } = fresh();
  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext(); const p = await ctx.newPage();
    await p.goto(base);
    await p.evaluate(async (id) => { await fetch('/api/dev/login', { method: 'POST', headers: { 'X-Requested-With': 'prism' }, body: JSON.stringify({ userId: id }) }); }, SYN.emp);
    await p.reload(); await p.waitForSelector('.sidebar');
    await ctx.clearCookies(); // the session ends
    await p.click('a.nav-item[href="#/company"]');
    await p.waitForSelector('.signin, [class*="signin"], button:has-text("Sign in"), a:has-text("Sign in")', { timeout: 10000 });
    assert.equal(await p.locator('.alert.error').count(), 0);
  } finally { await browser.close(); srv.close(); }
});
