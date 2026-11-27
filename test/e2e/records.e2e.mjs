// Employee records in a browser (synthetic data): the admin creates records from GB People, asks an
// employee for their details; the employee fills only their personal fields; the admin applies them.
// Partners, managers and employees cannot open the records page or its data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN } from '../helpers.js';
import { createServer } from '../../src/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

test('employee records: admin only; employees complete their own details', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db } = fresh();
  db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'admin')").run(SYN.ops);
  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const errors = [];
  const pageAs = async (userId, viewport = { width: 1440, height: 950 }) => {
    const p = await (await browser.newContext({ viewport })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/40[0-9]/.test(m.text())) errors.push(m.text()); });
    await p.goto(base);
    await p.evaluate(async (id) => { await fetch('/api/dev/login', { method: 'POST', headers: { 'X-Requested-With': 'prism' }, body: JSON.stringify({ userId: id }) }); }, userId);
    await p.reload(); await p.waitForSelector('.sidebar');
    return p;
  };
  try {
    const admin = await pageAs(SYN.ops);
    await admin.click('a.ws-link[title="Admin"]'); await admin.click('a.nav-item[href="#/admin/records"]');
    await admin.getByRole('button', { name: /Create \d+ records from GB People/ }).click(); await admin.waitForSelector('table.data tbody tr');
    await admin.click('button.link-btn:has-text("Eli Employee")'); await admin.waitForSelector('#hr-basic_salary');
    assert.equal(await admin.inputValue('#hr-title_ar'), 'مستشار');
    await admin.fill('#hr-basic_salary', '900'); await admin.fill('#hr-mobile_allowance', '20'); await admin.fill('#hr-transport_allowance', '50');
    assert.match(await admin.textContent('.gross'), /970\.000 JOD/);
    await admin.getByRole('button', { name: 'Save record' }).click(); await admin.waitForSelector('text=Record saved');
    await admin.getByRole('button', { name: 'Ask employees for their details' }).click();
    await admin.locator('.drawer .check-list label', { hasText: 'Eli Employee' }).locator('input').check();
    await admin.getByRole('button', { name: 'Send the request' }).click(); await admin.waitForSelector('text=/Asked \\d+/');
    // export is a spreadsheet
    const x = await admin.evaluate(async () => { const r = await fetch('/api/hr-records/export'); return [r.status, r.headers.get('content-type')]; });
    assert.deepEqual(x, [200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);

    // the employee completes their record from Home, sees no pay or grade
    const emp = await pageAs(SYN.emp);
    await emp.waitForSelector('.home-attn');
    await emp.locator('.home-attn a', { hasText: /Complete (your employee record|my record)/ }).first().click();
    await emp.waitForSelector('#hr-name_ar');
    assert.equal(await emp.locator('#hr-basic_salary, #hr-grade').count(), 0);
    await emp.fill('#hr-name_ar', 'إيلي الموظف'); await emp.fill('#hr-mobile', '+962 79 123 4567'); await emp.fill('#hr-iban', 'JO94 CBJO 0010 0000 0000 0131 0003 02');
    await emp.selectOption('#hr-marital_status', 'Single');
    await emp.getByRole('button', { name: 'Send to the admin' }).click(); await emp.waitForSelector('text=Sent to the admin');
    // others cannot reach the records, by link or API
    for (const who of [SYN.partner, SYN.manager, SYN.emp]) {
      const p = who === SYN.emp ? emp : await pageAs(who);
      assert.equal(await p.locator('a[href="#/admin/records"]').count(), 0);
      const st = await p.evaluate(async () => (await fetch('/api/hr-records', { headers: { 'X-Requested-With': 'prism' } })).status);
      assert.equal(st, 403);
    }
    // the admin reviews and applies
    await admin.goto(`${base}#/admin/records?u=${SYN.emp}`); await admin.reload(); await admin.waitForSelector('.review-box');
    assert.match(await admin.textContent('.review-box'), /إيلي الموظف/);
    await admin.getByRole('button', { name: 'Apply the ticked details' }).click(); await admin.waitForSelector('text=Applied');
    await admin.waitForSelector('#hr-iban'); assert.equal(await admin.inputValue('#hr-iban'), 'JO94CBJO0010000000000131000302');
    assert.equal(await admin.inputValue('#hr-basic_salary'), '900');
    // phone width
    const ph = await pageAs(SYN.emp, { width: 390, height: 844 }); await ph.goto(`${base}#/my-record`); await ph.waitForSelector('#hr-name_ar');
    assert.ok(await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
