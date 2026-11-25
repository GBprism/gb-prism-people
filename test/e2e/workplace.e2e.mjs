// Browser test for expenses, timesheet, letters, policies, checklists sign-off and company profile (synthetic data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN } from '../helpers.js';
import { createServer } from '../../src/server.js';
import { applyWorkplace } from '../../src/domain/workplace.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

test('workplace: expense with receipt, timesheet, letter, policy, deliverable checklist', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db, as } = fresh();
  db.prepare("INSERT OR REPLACE INTO settings (tenant_id, key, value_json) VALUES (?, 'expense_approver', ?)").run(SYN.tenant, JSON.stringify(SYN.partner));
  applyWorkplace(db, as(SYN.ops), {
    letters: [{ key: 'experience_letter', title: 'Experience Letter', fields: ['today', 'employee_name', 'join_date'], body: 'To whom it may concern,\n{{employee_name}} joined on {{join_date}}.' }],
    checklists: { general: [{ key: 'brand', title: 'Branding', items: ['Footer date updated', 'No other client names'] }], specific: [{ key: 'pp', deliverable_type: 'P&P manual', title: 'P&P manual', items: ['Policies numbered'] }] },
    policies: [{ key: 'claude', category: 'AI', title: 'Claude usage', version: '1', summary: 'How we use Claude.', rules: ['Start with Sonnet'] }],
    onboarding: [{ key: 'nda', title: 'NDA', stage: 'day1', owner: 'new_joiner', action: 'sign' }],
  });
  const pid = db.prepare('SELECT id FROM projects WHERE lead_user_id = ? LIMIT 1').get(SYN.lead).id;
  db.prepare("INSERT INTO deliverables (id, tenant_id, project_id, title) VALUES ('dlv_e2e', ?, ?, 'Procurement manual')").run(SYN.tenant, pid);
  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const errors = [];
  const pageAs = async (userId, viewport = { width: 1440, height: 900 }) => {
    const p = await (await browser.newContext({ viewport })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/401|403|400/.test(m.text())) errors.push(m.text()); });
    await p.goto(base);
    await p.evaluate(async (id) => { await fetch('/api/dev/login', { method: 'POST', headers: { 'X-Requested-With': 'prism' }, body: JSON.stringify({ userId: id }) }); }, userId);
    await p.reload(); await p.waitForSelector('.sidebar');
    return p;
  };
  try {
    const emp = await pageAs(SYN.emp);
    // expenses: claim → line with receipt → submit
    await emp.click('a.nav-item[href="#/expenses"]'); await emp.getByRole('button', { name: 'New claim' }).click();
    await emp.fill('#nc-title', 'Client workshop'); await emp.getByRole('button', { name: 'Create claim' }).click();
    await emp.waitForSelector('#ex-date');
    await emp.fill('#ex-date', '2026-03-02'); await emp.selectOption('#ex-cat', 'Taxi/Bus/Tube/Tram'); await emp.fill('#ex-desc', 'Taxi to client');
    await emp.fill('#ex-amt', '12.5'); await emp.setInputFiles('#ex-file', { name: 'taxi.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%receipt\n') });
    await emp.getByRole('button', { name: 'Add expense' }).click();
    await emp.waitForSelector('text=12.50 JOD');
    await emp.getByRole('button', { name: 'Submit for approval' }).click();
    await emp.waitForSelector('text=Awaiting approval');
    assert.equal(db.prepare("SELECT status FROM expense_claims WHERE title = 'Client workshop'").get().status, 'submitted');
    // timesheet drafts itself; edit a cell; submit
    await emp.click('a.nav-item[href="#/timesheet"]'); await emp.waitForSelector('.ts-grid');
    const cell = emp.locator('.ts-cell').first(); await cell.fill('6');
    await emp.waitForSelector('.save-state:text("Saved")');
    await emp.getByRole('button', { name: 'Submit month' }).click(); await emp.waitForSelector('text=Submitted');
    // letter request and policy acknowledgement
    await emp.click('a.nav-item[href="#/letters"]'); await emp.fill('#lr-why', 'Visa application'); await emp.getByRole('button', { name: 'Send request' }).click();
    await emp.waitForSelector('.eng-item:has-text("Experience letter")');
    await emp.click('a.nav-item[href="#/policies"]'); await emp.getByRole('button', { name: /I have read this/ }).click(); await emp.waitForSelector('text=Acknowledged');
    await emp.goto(`${base}#/company`); await emp.waitForSelector('a[href="/api/cv/all"]');
    const cv = await emp.evaluate(async (id) => { const r = await fetch(`/api/cv/${id}`); return [r.status, r.headers.get('content-type')]; }, SYN.emp);
    assert.deepEqual(cv, [200, 'application/vnd.openxmlformats-officedocument.presentationml.presentation']);

    // approver approves the expense; People Ops prepares the letter
    const pt = await pageAs(SYN.partner);
    await pt.goto(`${base}#/expenses?tab=approve`); await pt.locator('.eng-item .link-btn').first().click();
    await pt.getByRole('link', { name: /View/ }).first().waitFor();
    await pt.locator('.drawer').getByRole('button', { name: 'Approve' }).click(); await pt.waitForSelector('text=regular and fair business');
    assert.equal(db.prepare("SELECT status FROM expense_claims WHERE title = 'Client workshop'").get().status, 'approved');
    const ops = await pageAs(SYN.ops);
    await ops.goto(`${base}#/letters`); await ops.getByRole('button', { name: 'Prepare' }).click();
    await ops.waitForSelector('.letter-preview'); assert.match(await ops.textContent('.letter-preview'), /joined on/);
    await ops.getByRole('button', { name: 'Mark issued' }).click(); await ops.waitForSelector('.eng-item:has-text("Issued")');

    // the project lead submits a deliverable only after ticking every checklist item
    const lead = await pageAs(SYN.lead);
    await lead.goto(`${base}#/projects`); await lead.locator(`#project-${pid} .deliverable`, { hasText: "Procurement manual" }).getByRole("button", { name: "Submit for review" }).click();
    await lead.selectOption('#sd-type', 'P&P manual');
    await lead.getByRole('button', { name: /I checked everything/ }).click(); await lead.waitForSelector('text=/left/');
    for (const box of await lead.locator('.drawer fieldset input[type=checkbox]').all()) await box.check();
    await lead.getByRole('button', { name: /I checked everything/ }).click();
    await lead.waitForSelector('text=checklists confirmed');
    assert.equal(db.prepare("SELECT status FROM deliverables WHERE id = 'dlv_e2e'").get().status, 'submitted');

    // phone width: no horizontal scroll on the new pages
    const ph = await pageAs(SYN.emp, { width: 390, height: 844 });
    for (const pg of ['timesheet', 'expenses', 'letters', 'policies', 'checklists', 'company', 'onboarding']) {
      await ph.goto(`${base}#/${pg}`); await ph.waitForTimeout(400);
      assert.ok(await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${pg} scrolls sideways`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
