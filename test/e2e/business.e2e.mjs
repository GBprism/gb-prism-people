// Browser test: commercial, resource calendar, pipeline (won → project), surveys (pulse + public client page),
// training, offboarding and close-out. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN } from '../helpers.js';
import { createServer } from '../../src/server.js';
import { applyLibrary } from '../../src/domain/library.js';
import { createClientSurvey } from '../../src/domain/surveys.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

test('business screens end to end', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db, as } = fresh();
  applyLibrary(db, as(SYN.ops), { clients: [{ key: 'acme', name_en: 'Acme Bank', short: 'ACME' }], engagements: [{ key: 'e1', client: 'acme', title_en: 'Strategy', status: 'completed', year_from: 2025, project: 'Project Alpha — strategy' }] });
  db.prepare("UPDATE project_assignments SET end_date = '2027-12-31'").run(); db.prepare("UPDATE projects SET end_date = '2027-12-31'").run();
  const survey = createClientSurvey(db, as(SYN.lead), { project_id: 'prj_alpha', contact_name: 'Rania' });
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
    const pt = await pageAs(SYN.partner);
    // commercial: set a budget
    await pt.click('a.ws-link[title="Manager"]'); await pt.click('a.nav-item[href="#/commercial"]'); await pt.waitForSelector('.burn-cell');
    await pt.getByRole('button', { name: /Set budget|Open/ }).first().click();
    await pt.fill('#cb-fee', '20000'); await pt.fill('#cb-hours', '120');
    await pt.getByRole('button', { name: 'Save budget' }).click(); await pt.waitForSelector('text=Budget saved');
    assert.ok(db.prepare('SELECT 1 FROM project_budgets WHERE fee_x100 = 2000000').get());
    // pipeline: add, win, create the project
    await pt.goto(`${base}#/pipeline`); await pt.getByRole('button', { name: 'New opportunity' }).click();
    await pt.selectOption('#op-client', { label: 'Acme Bank' }); await pt.fill('#op-title', 'Digital strategy'); await pt.fill('#op-value', '40000');
    await pt.getByRole('button', { name: 'Add', exact: true }).click(); await pt.waitForSelector('.opp');
    await pt.locator('.opp', { hasText: 'Digital strategy' }).click(); await pt.selectOption('#op-stage', 'won');
    await pt.getByRole('button', { name: 'Save' }).click(); await pt.waitForSelector('text=Saved');
    await pt.getByRole('button', { name: /Won and lost/ }).click(); await pt.locator('.eng-item', { hasText: 'Digital strategy' }).getByRole('button', { name: 'Open' }).click();
    await pt.getByRole('button', { name: 'Create the project' }).click(); await pt.waitForFunction(() => location.hash.startsWith('#/projects'));
    assert.ok(db.prepare("SELECT 1 FROM projects WHERE name LIKE 'ACME – Digital strategy'").get());
    // surveys: open a pulse
    await pt.goto(`${base}#/surveys`); await pt.getByRole('button', { name: 'Open a team pulse' }).click(); await pt.waitForSelector('text=Pulse opened');
    // resource calendar renders
    await pt.goto(`${base}#/staffing`); await pt.waitForSelector('.wk-grid');
    await pt.getByRole('button', { name: '12 weeks' }).click(); await pt.waitForSelector('.staff-cell');
    // employee: answers the pulse from the inbox, adds training
    const emp = await pageAs(SYN.emp);
    await emp.goto(`${base}#/surveys`); await emp.getByRole('button', { name: /Answer/ }).click();
    await emp.locator('input[name="pq_enps"][value="8"]').check({ force: true });
    await emp.getByRole('button', { name: 'Send my answers' }).click(); await emp.waitForSelector('text=You answered');
    await emp.goto(`${base}#/training`); await emp.getByRole('button', { name: 'Add training' }).click();
    await emp.fill('#tr-title', 'Power BI'); await emp.fill('#tr-h', '12'); await emp.getByRole('button', { name: 'Save' }).click(); await emp.waitForSelector('text=Power BI');
    assert.equal(await emp.locator('a[href="#/commercial"]').count(), 0, 'employees never see Commercial');
    assert.equal(await emp.locator('.ws-switch').count(), 0, 'employees have no workspace switcher');
    // the lead writes the close-out from the inbox link
    const lead = await pageAs(SYN.lead);
    const e1 = db.prepare("SELECT id FROM engagements WHERE key = 'e1'").get().id;
    await lead.goto(`${base}#/library?closeout=${e1}`); await lead.waitForSelector('#co-well');
    await lead.fill('#co-well', 'Weekly steering with the CEO'); await lead.getByRole('button', { name: 'Add a reusable asset' }).click();
    await lead.fill('input[aria-label="Asset title"]', 'KPI dictionary'); await lead.fill('input[aria-label="Drive link"]', 'https://docs.google.com/spreadsheets/d/abc');
    await lead.getByRole('button', { name: 'Save close-out' }).click(); await lead.waitForSelector('text=Close-out saved');
    // People Ops starts an offboarding
    const ops = await pageAs(SYN.ops);
    await ops.goto(`${base}#/offboarding`); await ops.getByRole('button', { name: 'Start offboarding' }).click();
    await ops.selectOption('#ob-who', SYN.peer); await ops.fill('#ob-day', '2026-12-31'); await ops.getByRole('button', { name: 'Start', exact: true }).click();
    await ops.waitForSelector('.check-list');
    // the client answers without signing in
    const client = await (await browser.newContext()).newPage();
    await client.goto(`${base}survey/${survey.token}`); await client.waitForSelector('form');
    await client.locator('input[name="quality"][value="5"]').check({ force: true }); await client.locator('input[name="nps"][value="10"]').check({ force: true });
    await client.getByRole('button', { name: 'Send feedback' }).click(); await client.waitForSelector('text=Thank you');
    assert.ok(db.prepare('SELECT 1 FROM survey_responses r JOIN surveys s ON s.id = r.survey_id WHERE s.kind = ?').get('client'));
    // phone width: no sideways scroll on the new pages
    const ph = await pageAs(SYN.partner, { width: 390, height: 844 });
    for (const pg of ['commercial', 'staffing', 'pipeline', 'surveys', 'training', 'offboarding']) {
      await ph.goto(`${base}#/${pg}`); await ph.waitForTimeout(500);
      assert.ok(await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${pg} scrolls sideways`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
