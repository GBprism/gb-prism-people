// Browser test for the review page: self → manager → release → acknowledge (synthetic data only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN, rateAll } from '../helpers.js';
import { createServer } from '../../src/server.js';
import * as perf from '../../src/domain/performance.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
const PLAN = `plan_${SYN.emp}_2026`;

test('review page: autosave, modals instead of prompts, every stage, phone width', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db, as } = fresh();
  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const errors = []; const dialogs = [];
  const pageAs = async (userId, viewport = { width: 1440, height: 900 }) => {
    const p = await (await browser.newContext({ viewport })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    p.on('console', (m) => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errors.push(m.text()); });
    await p.goto(base);
    await p.evaluate(async (id) => { await fetch('/api/dev/login', { method: 'POST', headers: { 'X-Requested-With': 'prism' }, body: JSON.stringify({ userId: id }) }); }, userId);
    await p.reload(); await p.waitForSelector('.sidebar');
    return p;
  };
  let itemId = null;
  const item = () => db.prepare('SELECT * FROM plan_items WHERE id = ?').get(itemId);
  try {
    // employee: rate one item in the UI, autosave persists it
    const emp = await pageAs(SYN.emp);
    await emp.goto(`${base}#/review/${PLAN}`); await emp.waitForSelector('.review-layout .rating-seg');
    itemId = (await emp.$eval('.rating-seg input', (i) => i.name)).replace(/^self_/, '');
    const it = item();
    await emp.click(`label:has(> input[name="self_${it.id}"][value="4"])`);
    await emp.fill(`#why_${it.id}`, 'Delivered on time');
    await emp.waitForFunction(() => document.querySelector('.save-state')?.dataset.state === 'saved', null, { timeout: 5000 });
    assert.equal(item().self_rating, 4);
    // fill the rest server-side, then submit through the confirm modal
    perf.saveSelf(db, as(SYN.emp), PLAN, { items: rateAll(perf.planView(db, as(SYN.emp), PLAN).items, 'self', 4), summary: { strongest_outcomes: 'Alpha' } });
    await emp.reload(); await emp.waitForSelector('.review-bar');
    await emp.click('.review-bar button:has-text("Submit self-assessment")');
    await emp.click('.modal button:has-text("Submit")');
    await emp.waitForFunction(() => document.querySelector('.review-head .badge')?.textContent.includes('Manager review'));

    // manager: rate in the UI, finish server-side, submit
    const mgr = await pageAs(SYN.manager);
    await mgr.goto(`${base}#/review/${PLAN}`); await mgr.waitForSelector('.review-layout');
    await mgr.click(`label:has(> input[name="mgr_${it.id}"][value="3"])`);
    await mgr.waitForFunction(() => document.querySelector('.save-state')?.dataset.state === 'saved', null, { timeout: 5000 });
    assert.equal(item().manager_rating, 3);
    perf.saveManager(db, as(SYN.manager), PLAN, { items: rateAll(perf.planView(db, as(SYN.manager), PLAN).items, 'manager', 3), summary: { strengths: ['Reliable'], gaps: ['Clients'], next_action: 'Present' } });
    await mgr.reload(); await mgr.waitForSelector('.review-bar');
    // "Return to employee" asks for a reason in a modal; cancelling changes nothing
    await mgr.click('.review-bar button:has-text("Return to employee")'); await mgr.waitForSelector('.modal');
    await mgr.click('.modal button:has-text("Cancel")');
    await mgr.click('.review-bar button:has-text("Submit to partner calibration")'); await mgr.click('.modal button:has-text("Submit")');
    await mgr.waitForFunction(() => document.querySelector('.review-head .badge')?.textContent.includes('Partner calibration'));

    // partner releases
    const partner = await pageAs(SYN.partner);
    await partner.goto(`${base}#/review/${PLAN}`); await partner.waitForSelector('.review-bar');
    // the founders confirm first (one founder in the synthetic data); only then can the result be released
    assert.equal(await partner.locator('.review-bar button:has-text("Release result")').count(), 0);
    await partner.click('.review-bar button:has-text("Confirm final result")'); await partner.click('.modal button:has-text("Confirm")');
    await partner.waitForSelector('.review-bar button:has-text("Release result")');
    await partner.click('.review-bar button:has-text("Release result")'); await partner.click('.modal button:has-text("Release")');
    await partner.waitForFunction(() => document.querySelector('.review-head .badge')?.textContent.includes('Result released'));

    // employee acknowledges with an optional comment (no prompt() anywhere)
    await emp.goto(`${base}#/review/${PLAN}`); await emp.reload(); await emp.waitForSelector('.review-bar');
    await emp.click('.review-bar button:has-text("Acknowledge receipt")'); await emp.fill('#prompt-modal-input', 'Thanks');
    await emp.click('.modal button:has-text("Acknowledge")');
    await emp.waitForFunction(() => document.querySelector('.review-head .badge')?.textContent.includes('Acknowledged'));
    assert.equal(db.prepare('SELECT ack_comment FROM plans WHERE id = ?').get(PLAN).ack_comment, 'Thanks');

    const phone = await pageAs(SYN.manager, { width: 390, height: 844 });
    await phone.goto(`${base}#/review/${PLAN}`); await phone.waitForSelector('.review-layout');
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll at 390px');
    assert.deepEqual(dialogs, [], 'no browser prompt()/confirm() dialogs');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
