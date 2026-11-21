// Browser smoke test for Admin → Imports (Upload → Check format → Review & fix → Import).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN, xlsx } from '../helpers.js';
import { createServer } from '../../src/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

test('imports: a first-time user can import a LeaveBoard export end to end', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db } = fresh();
  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const head = ['Employee', 'Working', 'Worked', 'Sick leave', 'Work From Home', 'Annual Vacation', 'Compensation of Overtime', 'Overtime', 'Wedding Leave'];
  const buf = await xlsx({ Data: [head, ['Eli Employe', 230, 223, 6, 12, 12, 1, 3, 0], ['Unknown Person', 231, 229.5, 0.5, 5, 15, 1, 0, 0], [null, 461, 452.5, 6.5, 17, 27, 2, 3, 0]], Details: [['https://leaveboard.com/'], ['generated.on : 2026-11-19T10:03:55.815Z']] });
  const browser = await chromium.launch(); const errors = [];
  try {
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base);
    await p.evaluate(async (id) => { await fetch('/api/dev/login', { method: 'POST', headers: { 'X-Requested-With': 'prism' }, body: JSON.stringify({ userId: id }) }); }, SYN.ops);
    await p.goto(`${base}#/admin/imports`); await p.reload();
    await p.waitForSelector('.dropzone');
    assert.ok(await p.$('text=No imports yet'));
    // 1 Upload
    await p.setInputFiles('#imp-file', { name: 'General-situation-2026-11-19.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: buf });
    // 2 Check format: auto-detected LeaveBoard, asks only for the report dates
    await p.waitForSelector('.source-card[aria-checked="true"]');
    assert.match(await p.$eval('.source-card[aria-checked="true"]', (e) => e.textContent), /LeaveBoard export/);
    assert.ok(await p.$('#imp-from') && await p.$('#imp-to'));
    assert.equal(await p.$('#imp-cycle'), null);
    await p.fill('#imp-from', '2026-01-01'); await p.fill('#imp-to', '2026-11-19');
    await p.click('text=Check file');
    // 3 Review & fix: summary bar, problem rows first, totals reconciled
    await p.waitForSelector('.summary-bar');
    assert.match(await p.$eval('.summary-bar', (e) => e.textContent), /1 row ready · 1 needs attention · 1 skipped/);
    assert.match(await p.$eval('section.card:has(h2:text-is("Rows")) table.data tbody tr', (e) => e.textContent), /Needs matching/);
    assert.equal(await p.$$eval('text=Reconciled', (els) => els.length), 8);
    await p.click('text=Import 1 valid row only');
    // 4 Import: result card
    await p.waitForSelector('text=Import finished');
    assert.ok(await p.$('text=Reverse import'));
    await p.click('text=Import another file');
    await p.waitForSelector('text=Recent imports');
    assert.match(await p.$eval('table.data tbody', (e) => e.textContent), /General-situation-2026-11-19\.xlsx.*Imported/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
