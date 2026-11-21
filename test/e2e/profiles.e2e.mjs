// Browser test for My profile and the People directory (synthetic data only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN } from '../helpers.js';
import { createServer } from '../../src/server.js';
import { updateProfile } from '../../src/domain/profiles.js';
import { createProject } from '../../src/domain/projects.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
const SHOTS = process.env.SHOTS; // a scratch folder; never commit screenshots of real people

test('profiles: my profile, people directory, drawer edit, no errors', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db, as } = fresh();
  const ops = as(SYN.ops);
  updateProfile(db, ops, SYN.emp, { level: 'Business Analyst (Grade 1)', age_recorded: 24, age_recorded_on: '2025-12-01', probation_status: 'Ended Jan 2026 (email)', contract_status: 'Not verified',
    social_security_status: 'Policy: yes – confirm', medical_insurance_status: 'Not on file', gym_stipend_status: 'Eligible from Jan 2026', projects_summary: 'Alpha assessment – Contributor; Beta manuals – Contributor',
    proposals_summary: 'Gamma technical proposal (owner, Sep)', gaps: 'DOB; insurance enrollment' }, { source: 'Synthetic example' });
  updateProfile(db, ops, SYN.senior, { level: 'Senior Consultant', contract_status: 'Yes (2024)', medical_insurance_status: 'Enrolled', gym_stipend_status: 'Eligible', social_security_status: 'Yes' });
  const prj = createProject(db, ops, { name: 'Alpha assessment', kind: 'engagement', leadUserId: SYN.senior });
  db.prepare("INSERT INTO project_assignments (id, tenant_id, project_id, user_id, role, status, start_date, end_date, source) VALUES ('asg_x', ?, ?, ?, 'Assessment report; roadmap', 'tentative', '2026-01-01', '2026-02-28', 'Synthetic')").run(SYN.tenant, prj, SYN.emp);
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
    const emp = await pageAs(SYN.emp);
    await emp.goto(`${base}#/profile`); await emp.waitForSelector('.profile .kv');
    const text = await emp.textContent('.profile');
    assert.match(text, /Business Analyst \(Grade 1\)/); assert.match(text, /24 \(as of Dec 2025\)/); assert.match(text, /Alpha assessment/); assert.match(text, /Lead to confirm/);
    assert.equal(await emp.$('a.nav-item[href="#/people"]'), null);
    if (SHOTS) await emp.screenshot({ path: `${SHOTS}/my-profile.png`, fullPage: true });

    const o = await pageAs(SYN.ops);
    await o.goto(`${base}#/people`); await o.waitForSelector('table.data tbody tr');
    if (SHOTS) await o.screenshot({ path: `${SHOTS}/people.png`, fullPage: true });
    await o.click('table.data tbody tr:has-text("Eli Employee")'); await o.waitForSelector('.drawer .kv'); await o.waitForTimeout(500);
    if (SHOTS) await o.screenshot({ path: `${SHOTS}/people-drawer.png` });
    await o.click('.drawer-footer button:has-text("Edit")'); await o.fill('#pf_medical_insurance_status', 'Enrolled (Dec 2026)');
    await o.click('.drawer-footer button:has-text("Save")'); await o.waitForSelector('.drawer .kv');
    assert.match(await o.textContent('.drawer'), /Enrolled \(Dec 2026\)/);

    const m = await pageAs(SYN.emp, { width: 390, height: 844 });
    await m.goto(`${base}#/profile`); await m.waitForSelector('.profile .kv');
    assert.ok(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll on phone');
    if (SHOTS) await m.screenshot({ path: `${SHOTS}/my-profile-mobile.png`, fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
