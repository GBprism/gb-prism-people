// Accessibility smoke test: every page, every role — form fields have labels, buttons and links
// have names, images have alt text, one h1 per page, no duplicate ids (synthetic data only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN } from '../helpers.js';
import { createServer } from '../../src/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

const PAGES = {
  [SYN.emp]: ['#/', '#/timeoff', '#/history', `#/review/plan_${SYN.emp}_2026`, '#/projects', '#/ai', '#/profile'],
  [SYN.manager]: ['#/inbox', `#/review/plan_${SYN.emp}_2026`],
  [SYN.ops]: ['#/people', '#/admin/dashboard', '#/admin/roster', '#/admin/imports', '#/admin/policy', '#/admin/reminders', '#/admin/ai', '#/admin/audit'],
};

test('accessibility basics on every page', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db } = fresh();
  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const problems = [];
  try {
    for (const [userId, hashes] of Object.entries(PAGES)) {
      const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
      await p.goto(base);
      await p.evaluate(async (id) => { await fetch('/api/dev/login', { method: 'POST', headers: { 'X-Requested-With': 'prism' }, body: JSON.stringify({ userId: id }) }); }, userId);
      for (const hash of hashes) {
        await p.goto(base + hash); await p.reload(); await p.waitForSelector('main .card, main .empty, main .review'); await p.waitForTimeout(200);
        const found = await p.evaluate(() => {
          const out = []; const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || el.textContent || '').trim();
          for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
            const labelled = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
            if (!labelled) out.push(`unlabelled ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.name ? '[' + el.name + ']' : ''}`);
          }
          for (const el of document.querySelectorAll('button, a[href]')) if (!name(el) && !el.querySelector('img[alt]:not([alt=""])')) out.push(`nameless ${el.tagName.toLowerCase()} ${el.className}`);
          for (const el of document.querySelectorAll('img')) if (!el.hasAttribute('alt')) out.push(`img without alt ${el.src}`);
          const h1 = document.querySelectorAll('main h1').length; if (h1 !== 1) out.push(`${h1} h1 elements`);
          const ids = {}; for (const el of document.querySelectorAll('[id]')) ids[el.id] = (ids[el.id] || 0) + 1;
          for (const [id, n] of Object.entries(ids)) if (n > 1) out.push(`duplicate id ${id}`);
          return out;
        });
        for (const f of found) problems.push(`${hash}: ${f}`);
      }
    }
  } finally { await browser.close(); srv.close(); }
  assert.deepEqual([...new Set(problems)], []);
});
