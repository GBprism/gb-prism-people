// Browser test for the Library (clients, engagements, proposals, strategy) and linking an objective
// to a GB strategy KPI from the review page. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN } from '../helpers.js';
import { createServer } from '../../src/server.js';
import { applyLibrary } from '../../src/domain/library.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
const SHOTS = process.env.SHOTS;

const FILE = {
  clients: [{ key: 'acme', name_en: 'Acme Bank', name_ar: 'بنك أكمي', short: 'ACME', sector: 'Financial Services', country: 'Jordan' },
    { key: 'beta', name_en: 'Beta Authority', name_ar: 'هيئة بيتا', sector: 'Public Sector', country: 'Saudi Arabia' }],
  engagements: [
    { key: 'a1', client: 'acme', title_en: 'Corporate strategy', title_ar: 'الاستراتيجية المؤسسية', domain: 'Strategic Planning and Roadmap', service_line: 'Strategic Planning and Growth', scope_en: 'Five-year strategy and KPIs', scope_ar: 'استراتيجية خمسية ومؤشرات أداء', year_from: 2021, year_to: 2022, status: 'completed', team: ['Former Colleague'], drive_url: 'https://drive.google.com/drive/folders/abc' },
    { key: 'b1', client: 'beta', title_en: 'Policies and procedures', domain: 'Policies and Procedures', service_line: 'Business Process Re-engineering', scope_en: 'Shared services manuals', year_from: 2026, status: 'running', project: 'Project Alpha — strategy' },
  ],
  proposals: [{ key: 'p1', client: 'acme', title_en: 'Strategy refresh', submitted_on: '2026-02-01', outcome: 'won' }, { key: 'p2', client: 'beta', title_en: 'Org design', submitted_on: '2026-03-01', outcome: 'submitted' }],
  strategy: { objectives: [{ code: '1.1', theme: '1. Prepare', title_en: 'Rectify quality issues in delivery', title_ar: 'معالجة مشكلات الجودة' }, { code: '1.4', theme: '1. Prepare', title_en: 'Grow in markets' }],
    kpis: [{ code: 'K01', name_en: 'Quality index on projects delivered', name_ar: 'مؤشر الجودة', objectives: ['1.1'] }, { code: 'K16', name_en: 'Proposal hit rate', objectives: ['1.4'] }] },
};

test('library: filters, Arabic, proposals outcome, strategy link from the review page', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db, as } = fresh();
  applyLibrary(db, as(SYN.ops), FILE);
  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const errors = [];
  const pageAs = async (userId, viewport = { width: 1440, height: 900 }) => {
    const p = await (await browser.newContext({ viewport, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/401|403/.test(m.text())) errors.push(m.text()); });
    await p.goto(base);
    await p.evaluate(async (id) => { await fetch('/api/dev/login', { method: 'POST', headers: { 'X-Requested-With': 'prism' }, body: JSON.stringify({ userId: id }) }); }, userId);
    await p.reload(); await p.waitForSelector('.sidebar');
    return p;
  };
  try {
    // any colleague: sees the library, filters it, switches to Arabic, cannot edit
    const emp = await pageAs(SYN.emp);
    await emp.click('a.nav-item[href="#/library"]'); await emp.waitForSelector('.eng-list');
    assert.equal(await emp.locator('.eng-item').count(), 2);
    await emp.selectOption('select[aria-label="Country"]', 'Jordan');
    assert.equal(await emp.locator('.eng-item').count(), 1);
    assert.match(await emp.textContent('.eng-list'), /Former Colleague/);
    await emp.fill('input[type="search"]', 'nothing-like-this');
    assert.match(await emp.textContent('.library'), /Nothing matches/);
    await emp.fill('input[type="search"]', '');
    await emp.getByRole('button', { name: 'العربية' }).click();
    assert.equal(await emp.getAttribute('.library', 'dir'), 'rtl');
    assert.match(await emp.textContent('.eng-list'), /استراتيجية خمسية/);
    if (SHOTS) await emp.screenshot({ path: `${SHOTS}/library-ar.png`, fullPage: true });
    await emp.getByRole('button', { name: 'English' }).click();
    await emp.getByRole('button', { name: /Proposals/ }).first().click();
    assert.equal(await emp.locator('.eng-item select').count(), 0, 'colleagues cannot change outcomes');
    await emp.getByRole('button', { name: /Strategy KPIs/ }).click(); await emp.waitForSelector('.kpi-row');
    assert.match(await emp.textContent('.library'), /Proposal hit rate/);

    // linking an objective from my review page
    const plan = db.prepare("SELECT p.id FROM plans p JOIN cycles c ON c.id = p.cycle_id WHERE p.user_id = ? AND c.status != 'historical' ORDER BY c.year LIMIT 1").get(SYN.emp);
    await emp.goto(`${base}#/review/${plan.id}`); await emp.waitForSelector('.item-card');
    await emp.getByRole('button', { name: 'Link to strategy' }).first().click();
    await emp.locator('.drawer label', { hasText: 'K01 Quality index' }).first().click();
    await emp.getByRole('button', { name: 'Save links' }).click();
    await emp.waitForSelector('.kpi-links .tag');
    assert.match(await emp.textContent('.item-card'), /K01 Quality index/);

    // a partner: changes a proposal outcome and edits an engagement
    const pt = await pageAs(SYN.partner);
    await pt.goto(`${base}#/library?tab=proposals`); await pt.waitForSelector('.eng-item select');
    await pt.locator('.eng-item', { hasText: 'Org design' }).locator('select').selectOption('lost');
    await pt.waitForSelector('text=Outcome saved');
    assert.equal(db.prepare("SELECT outcome FROM proposals WHERE key = 'p2'").get().outcome, 'lost');
    await pt.getByRole('button', { name: /Engagements/ }).first().click();
    await pt.locator('.eng-title .link-btn').last().click();
    await pt.selectOption('#e-status', 'completed');
    await pt.getByRole('button', { name: 'Save' }).click();
    await pt.waitForSelector('text=Saved');
    assert.equal(db.prepare("SELECT status FROM engagements WHERE key = 'a1'").get().status, 'completed');
    if (SHOTS) { await pt.goto(`${base}#/library`); await pt.waitForSelector('.eng-list'); await pt.screenshot({ path: `${SHOTS}/library.png`, fullPage: true }); }

    // phone width: no horizontal scroll
    const ph = await pageAs(SYN.emp, { width: 390, height: 844 });
    await ph.goto(`${base}#/library?tab=clients`); await ph.waitForSelector('.client-card');
    assert.ok(await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
