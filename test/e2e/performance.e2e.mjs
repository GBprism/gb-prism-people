// The performance process in a browser, synthetic people and amounts only:
// both founders approve the policy → cycle starts → employee sets priorities → manager agrees and coaches →
// annual reflection → manager ratings → founder calibration → BOTH founders confirm → release → employee
// reads and acknowledges. Before release the employee sees no rating. Compensation is refused to the admin
// role alone; the history import works as a dry run with an unmatched person skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN } from '../helpers.js';
import { createServer } from '../../src/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
const CSV = 'employee,work_email,review_year,sent_at_amman,effective_month,communicated_outcome,new_title,previous_monthly_salary_jod,new_monthly_salary_jod,bonus_months_of_base_salary,source_message_id,source_url,communicated_email_body\n'
  + 'Eli Employee,eli@example.test,2025,2026-01-13T17:00:00+03:00,2026-01,Salary increase + bonus,,480,600,1,m1,https://x,"Dear Eli,\nSalary increase: +25%"\n'
  + 'Gone Person,gone@example.test,2025,2026-01-13T17:00:00+03:00,2026-01,Salary increase,,500,550,,m2,https://x,"Dear G"\n';

test('performance process: employee → manager → founders, private release', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db } = fresh();
  db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'partner')").run(SYN.unrelated); // second founder
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
  const go = async (p, hash) => { await p.goto(base + hash); await p.reload(); await p.waitForSelector('main .card, main .empty, main .banner'); };
  const rid = () => db.prepare('SELECT id FROM perf_reviews WHERE user_id = ?').get(SYN.emp).id;
  try {
    // both founders approve the policy; one founder starts the cycle
    const f1 = await pageAs(SYN.partner); const f2 = await pageAs(SYN.unrelated);
    await go(f1, '#/admin/performance'); await f1.getByRole('button', { name: 'Approve this policy' }).click(); await f1.waitForSelector('text=Approved');
    await go(f2, '#/admin/performance'); await f2.getByRole('button', { name: 'Approve this policy' }).click(); await f2.waitForSelector('text=/Policy v1 — approved/');
    await f1.reload(); await f1.waitForSelector('#cy-y'); await f1.fill('#cy-y', '2027'); await f1.getByRole('button', { name: 'Start the cycle' }).click(); await f1.waitForSelector('text=Cycle started');
    // employee sets priorities from Home
    const emp = await pageAs(SYN.emp);
    await emp.waitForSelector('.home-attn'); assert.match(await emp.textContent('.home-attn'), /Agree up to three priorities/);
    await go(emp, '#/performance'); await emp.fill('#g-delivery', 'Own the N-2 deliverable on Alpha'); await emp.fill('#g-growth', 'Facilitate a client workshop');
    await emp.getByRole('button', { name: 'Save priorities' }).click(); await emp.waitForSelector('text=Saved');
    // manager agrees, records June coaching
    const mgr = await pageAs(SYN.manager);
    await go(mgr, '#/manager/performance'); await mgr.click('a:has-text("Eli Employee")'); await mgr.waitForSelector('text=Priorities');
    await mgr.getByRole('button', { name: 'Agree priorities' }).click(); await mgr.waitForSelector('text=/Agreed/');
    await mgr.getByRole('button', { name: 'Record coaching' }).click(); await mgr.selectOption('#c-m', '6');
    await mgr.fill('#c-s', 'Clear structure'); await mgr.fill('#c-i', 'Escalate data risks earlier'); await mgr.fill('#c-n', 'Run workshop 3'); await mgr.getByRole('button', { name: 'Save', exact: true }).click(); await mgr.waitForSelector('text=career conversation');
    // annual: founder opens reflections; employee reflects
    await go(f1, '#/admin/performance'); await f1.getByRole('button', { name: 'Open annual reviews' }).click(); await f1.waitForSelector('text=Reflections opened');
    await go(emp, '#/performance'); await emp.fill('textarea[aria-label="Accomplishment 1"]', 'Delivered the N-2 structure, accepted first time'); await emp.fill('#rf-g', 'Workshop facilitation'); await emp.fill('#rf-n', 'Own a workstream');
    await emp.getByRole('button', { name: 'Submit to my review manager' }).click(); await emp.waitForSelector('text=Submitted');
    // manager rates 4, 4, 3, 3 with evidence
    await go(mgr, `#/performance/review/${rid()}`);
    for (const [label, sc] of [['Delivery quality and problem-solving', 4], ['Ownership and reliability', 4], ['Communication and professional judgment', 3], ['Contribution to GB Advisory', 3]]) {
      await mgr.selectOption(`select[aria-label="${label} score"]`, String(sc)); await mgr.fill(`textarea[aria-label="${label} evidence"]`, 'Snapshot and deliverable'); await mgr.fill(`textarea[aria-label="${label} rationale"]`, 'As observed');
    }
    await mgr.getByRole('button', { name: 'Send to calibration' }).click(); await mgr.waitForSelector('text=Sent to the founders');
    // the employee sees no rating yet
    await go(emp, '#/performance'); assert.ok(!/3\.65/.test(await emp.textContent('main'))); assert.equal(await emp.locator('.perf-score').count(), 0);
    // founder 1 calibrates and confirms; release is blocked until founder 2 confirms
    await go(f1, `#/performance/review/${rid()}`); await f1.getByRole('button', { name: 'Finish calibration' }).click(); await f1.waitForSelector('text=/3\\.65 — Meets/');
    await f1.getByRole('button', { name: 'Confirm this result' }).click(); await f1.waitForSelector('text=Confirmed');
    assert.equal(await f1.getByRole('button', { name: 'Release to the employee' }).count(), 0);
    await go(f2, '#/admin/calibration'); assert.match(await f2.textContent('.calib'), /3\.65/);
    await go(f2, `#/performance/review/${rid()}`); await f2.getByRole('button', { name: 'Confirm this result' }).click(); await f2.waitForSelector('text=Confirmed');
    await f2.getByRole('button', { name: 'Release to the employee' }).click(); await f2.waitForSelector('text=Released privately');
    // employee reads and acknowledges
    await go(emp, '#/performance'); await emp.waitForSelector('.perf-score'); assert.match(await emp.textContent('.perf-score'), /3\.65\s*Meets/);
    await emp.getByRole('button', { name: 'Acknowledge receipt' }).click(); await emp.waitForSelector('text=/Acknowledged on/');
    // a colleague cannot open the review
    const peer = await pageAs(SYN.peer);
    assert.equal(await peer.evaluate(async (id) => (await fetch(`/api/performance/reviews/${id}`, { headers: { 'X-Requested-With': 'prism' } })).status, rid()), 404);
    // compensation: admin role alone is refused; founders see it
    const ops = await pageAs(SYN.ops);
    assert.equal(await ops.locator('a[href="#/admin/compensation"]').count(), 0);
    assert.equal(await ops.evaluate(async () => (await fetch('/api/compensation', { headers: { 'X-Requested-With': 'prism' } })).status), 403);
    // founder names the admin as compensation administrator → history import (dry run, unmatched skipped)
    await f1.evaluate(async (id) => fetch('/api/compensation/admins', { method: 'POST', headers: { 'X-Requested-With': 'prism', 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) }), SYN.ops);
    await ops.reload(); await go(ops, '#/admin/pms-history');
    await ops.setInputFiles('#imp-csv', { name: '2025_outcomes.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await ops.waitForSelector('text=needs mapping'); assert.match(await ops.textContent('main'), /Gone Person/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM comp_records').get().n, 0, 'nothing saved by the dry run');
    await ops.getByRole('button', { name: 'Import these records' }).click(); await ops.waitForSelector('text=/Imported 1 · skipped 1/');
    await go(f1, '#/admin/compensation'); assert.match(await f1.textContent('main'), /Communicated \(email\)/);
    // phone
    const ph = await pageAs(SYN.emp, { width: 390, height: 844 }); await go(ph, '#/performance');
    assert.ok(await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
