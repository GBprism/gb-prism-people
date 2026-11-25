// Load all of GB's real data into Prism in one go, from a private folder (never committed):
//   <dir>/roster.csv               verified work emails (see setup-gb.js)
//   <dir>/gb-decisions.json        GB decisions (see config/gb-decisions.example.json)
//   <dir>/forms/*.xlsx             2026 PMS forms from Drive (the blank template and leavers are skipped)
//   <dir>/pms2025.json             "GB Team 2025 PMS" → PMS tab values (Salaries tab never read)
//   <dir>/leaveboard/*.xlsx        LeaveBoard exports (General situation, Annual situation, Attendance)
//   <dir>/reviewers-2026.xlsx      2026 PMS – Consultant Reviewers workbook
//   <dir>/hr-evidence.json         facts verified from email (insurer list, contracts, probation)
//   <dir>/onboarding-letters.json, checklists.json, policies-brand-expenses.json, brand/*.png  workplace content
//   <dir>/title-renames.json       GB decisions renaming job titles
//   <dir>/library.json             clients, engagements, proposals and GB strategy KPIs (see src/domain/library.js)
//
//   node scripts/load-gb-all.js --dir config/private/real [--db data/prism-people.db] [--cutover 2026-11-19] [--dry-run]
// --dry-run runs everything against a temporary copy of the database and prints the report.
// --cutover posts LeaveBoard opening balances at that date (GB decision I); without it only snapshots load.
// Safe to re-run: every step skips work already done.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/db.js';
import { loadActor } from '../src/domain/authz.js';
import { previewGbForms, applyGbForms } from '../src/imports/gbform.js';
import { previewHistoryRows, applyHistory } from '../src/imports/pms.js';
import { previewLeaveboard, applyLeaveboard, postOpeningBalances } from '../src/imports/leaveboard.js';
import { parseGbWorkbook, applyGbWorkbook, applyHrEvidence, applyProjectEvidence, applyReviewerOverrides, applyPhotos, applyServiceLines, applyTitleRenames, nameMatcher } from '../src/imports/gbworkbook.js';
import { officeAdmins, setOfficeAdmins } from '../src/domain/office.js';
import { sha256 } from '../src/imports/xlsx.js';
import { SERVICE_LINES } from '../src/domain/projects.js';
import { applyLibrary } from '../src/domain/library.js';
import { applyWorkplace } from '../src/domain/workplace.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const dir = arg('dir', 'config/private/real');
const dry = process.argv.includes('--dry-run');
const cutover = arg('cutover');
const has = (f) => fs.existsSync(path.join(dir, f));
let dbFile = arg('db', process.env.DB_FILE || 'data/prism-people.db');
if (dry) { const tmp = path.join(os.tmpdir(), `prism-dry-${process.pid}.db`); if (fs.existsSync(dbFile)) fs.copyFileSync(dbFile, tmp); dbFile = tmp; }
const log = (h, lines = []) => { console.log(`\n== ${h}`); for (const l of [].concat(lines)) console.log(`  ${l}`); };

// 1. roster, roles, templates, cycles, holidays, decisions
if (has('roster.csv')) {
  execFileSync(process.execPath, ['--no-warnings', 'scripts/setup-gb.js', '--roster', path.join(dir, 'roster.csv'), '--decisions', has('gb-decisions.json') ? path.join(dir, 'gb-decisions.json') : 'config/private/gb-decisions.json', '--db', dbFile], { stdio: 'inherit' });
}
const db = openDb(dbFile);
const opsRow = db.prepare("SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role IN ('people_ops','admin') WHERE u.active = 1 AND u.synthetic = 0 LIMIT 1").get();
if (!opsRow) { console.error('No People Ops / admin user — load the roster first'); process.exit(1); }
const actor = loadActor(db, opsRow.id);
const cycle = db.prepare("SELECT * FROM cycles WHERE tenant_id = ? AND year = 2026 AND status != 'historical'").get(actor.tenantId);

// 2. 2026 PMS forms
if (has('forms') && cycle) {
  const files = fs.readdirSync(path.join(dir, 'forms')).filter((f) => f.endsWith('.xlsx') && !/template/i.test(f))
    .map((f) => ({ filename: f, buffer: fs.readFileSync(path.join(dir, 'forms', f)) }));
  // forms are named "<work-email name>-2026_….xlsx" (several have a blank name cell): register that name as a verified alias
  for (const f of files) {
    const stem = (/^(.+?)-20\d\d_/.exec(f.filename) || [])[1]; if (!stem) continue;
    const u = db.prepare("SELECT id FROM users WHERE tenant_id = ? AND lower(email) LIKE lower(?) || '@%'").get(actor.tenantId, stem);
    if (u) db.prepare("INSERT OR IGNORE INTO identity_aliases (id, tenant_id, user_id, source, alias, verified) VALUES (?,?,?, 'pms_form', ?, 1)").run(`al_form_${u.id}`, actor.tenantId, u.id, stem);
  }
  const b = await previewGbForms(db, actor, { cycleId: cycle.id, files });
  if (b.status === 'applied') log('2026 forms', 'already imported');
  else {
    try { const r = applyGbForms(db, actor, b.id); log('2026 forms', [`${r.plans_created} plans created, ${r.plans_updated} updated, ${r.items} items, ${r.needs_review} need review`, ...b.summary.plans.map((p) => `${p.person || p.file}: ${p.items} items${p.issues.length ? ` · ${p.issues.length} issue(s)` : ''}`)]); }
    catch (e) { log('2026 forms', `not applied: ${e.message}`); }
  }
}

// 3. 2025 history (PMS tab values only)
if (has('pms2025.json')) {
  const rows = JSON.parse(fs.readFileSync(path.join(dir, 'pms2025.json'), 'utf8')).map((r) => r.map((v) => ({ v })));
  const sha = sha256(Buffer.from(JSON.stringify(rows)));
  const ex = db.prepare("SELECT id, status FROM import_batches WHERE tenant_id = ? AND file_sha256 = ?").get(actor.tenantId, sha);
  if (ex?.status === 'applied') log('2025 history', 'already imported');
  else {
    const b = ex || previewHistoryRows(db, actor, { filename: 'GB Team 2025 PMS – PMS tab', sha, sheetName: 'PMS', rows, year: 2025, precision: 1 });
    const r = applyHistory(db, actor, b.id);
    log('2025 history', `${r.plans} closed reviews, ${r.skipped_existing} already there, ${r.review} need a name match`);
  }
}

// 4. LeaveBoard exports
if (has('leaveboard')) {
  const lines = []; let annual = null;
  for (const f of fs.readdirSync(path.join(dir, 'leaveboard')).filter((x) => x.endsWith('.xlsx')).sort()) {
    try {
      const b = await previewLeaveboard(db, actor, { filename: f, buffer: fs.readFileSync(path.join(dir, 'leaveboard', f)) });
      if (b.kind === 'leaveboard_annual_situation') annual = b.id;
      if (b.status === 'applied') { lines.push(`${f}: already imported`); continue; }
      const r = applyLeaveboard(db, actor, b.id, { cutover });
      lines.push(`${f}: ${r.kind} · ${r.snapshot_values} values, ${r.attendance_days} attendance days, ${r.requests} requests, ${r.skipped_for_review} for review`);
    } catch (e) { lines.push(`${f}: ${e.message}`); }
  }
  if (cutover && annual) {
    try { const r = postOpeningBalances(db, actor, { batchId: annual, cutover }); lines.push(`Opening balances at ${cutover}: ${JSON.stringify(r)}`); } catch (e) { lines.push(`Opening balances: ${e.message}`); }
  } else lines.push('Opening balances not posted (pass --cutover once GB sets the cutover date)');
  log('LeaveBoard', lines);
}

// 5. reviewer workbook (profiles, reviewers, project log) and 6. email evidence
const titleRenames = has('title-renames.json') ? JSON.parse(fs.readFileSync(path.join(dir, 'title-renames.json'), 'utf8')).renames || {} : {};
if (has('reviewers-2026.xlsx')) {
  const rep = applyGbWorkbook(db, actor, await parseGbWorkbook(fs.readFileSync(path.join(dir, 'reviewers-2026.xlsx'))), { titleRenames });
  log(`HR profiles (${rep.profiles.length})`, rep.profiles); log(`Reviewers (${rep.reviewers.length})`, rep.reviewers);
  log(`Project register (${rep.projects.length} lines)`, rep.projects); log(`Skipped (${rep.skipped.length})`, rep.skipped);
}
if (has('reviewer-overrides.json')) log('Reviewer decisions', applyReviewerOverrides(db, actor, JSON.parse(fs.readFileSync(path.join(dir, 'reviewer-overrides.json'), 'utf8'))));
// hr-evidence.json (email) first, then the other hr-evidence-*.json reviews in name order — later files win
for (const f of fs.readdirSync(dir).filter((x) => /^hr-evidence.*\.json$/.test(x)).sort((a, b) => (a === 'hr-evidence.json' ? -1 : b === 'hr-evidence.json' ? 1 : a.localeCompare(b)))) {
  const ev = applyHrEvidence(db, actor, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  log(`HR facts from ${f} (${ev.updated.length})`, [...ev.updated, ...ev.skipped]);
}
for (const f of fs.readdirSync(dir).filter((x) => /^projects-evidence.*\.json$/.test(x)).sort()) {
  const ev = applyProjectEvidence(db, actor, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  log(`Projects from ${f} (${ev.projects.length} projects, ${ev.assignments.length} assignments)`, [...ev.projects, ...ev.assignments, ...ev.skipped.map((x) => `skipped: ${x}`)]);
}

if (Object.keys(titleRenames).length) log('Job titles (GB decisions)', applyTitleRenames(db, actor, titleRenames));
if (has('photos')) log('Photos', applyPhotos(db, actor, fs.readdirSync(path.join(dir, 'photos')).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort()
  .map((f) => ({ filename: f, buffer: fs.readFileSync(path.join(dir, 'photos', f)) }))));
if (has('service-lines.json')) log('Service lines', applyServiceLines(db, actor, JSON.parse(fs.readFileSync(path.join(dir, 'service-lines.json'), 'utf8')), SERVICE_LINES));
// 7. knowledge library (clients, engagements, proposals) and GB strategy KPIs — after the projects so links resolve
if (has('library.json')) {
  const r = applyLibrary(db, actor, JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8')));
  log('Library and strategy', [`${r.clients} clients, ${r.engagements} engagements, ${r.proposals} proposals, ${r.objectives} objectives, ${r.kpis} KPIs`, r.kept ? `${r.kept} rows edited in the portal kept as they are` : null, ...r.problems].filter(Boolean));
}
// 8. workplace content: letter templates, deliverable checklists, AI policies, onboarding and the brand kit
{
  const read = (f) => (has(f) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null);
  const ol = read('onboarding-letters.json'); const cl = read('checklists.json'); const pb = read('policies-brand-expenses.json');
  if (ol || cl || pb || has('hr-policies.json')) {
    const brand = (pb?.brand_files || []).filter((b) => has(b.file)).map((b, i) => ({ label: `GB Advisory logo ${i + 1}`, variant: b.variant, orientation: b.orientation, filename: path.basename(b.file), buffer: fs.readFileSync(path.join(dir, b.file)) }));
    const r = applyWorkplace(db, actor, { letters: ol?.letters || [], onboarding: ol?.onboarding || [], checklists: cl || undefined, policies: [...(pb?.ai_policies || []).map((p) => ({ ...p, category: 'AI' })), ...(read('hr-policies.json')?.policies || [])], brand });
    log('Workplace content', `${r.letters} letter templates, ${r.checklists} checklists, ${r.policies} policies, ${r.onboarding} onboarding steps, ${r.brand} brand files`);
  }
}
// 9. who keeps the office expenses and company documents (only until someone is chosen in the portal)
if (has('office.json')) {
  const want = JSON.parse(fs.readFileSync(path.join(dir, 'office.json'), 'utf8')).office_admins || [];
  if (officeAdmins(db, actor.tenantId).length) log('Office administrators', 'already chosen in the portal — left as is');
  else {
    const match = nameMatcher(db.prepare('SELECT id, name FROM users WHERE tenant_id = ? AND active = 1').all(actor.tenantId).map((u) => ({ ...u, aliases: [] })));
    const ids = want.map((n) => match(n)?.id).filter(Boolean);
    setOfficeAdmins(db, actor, ids);
    log('Office administrators', want.map((n) => `${n}: ${match(n) ? 'assigned' : 'not on the roster'}`));
  }
}

const n = (sql) => db.prepare(sql).get(actor.tenantId).n;
log('Totals', [`people ${n('SELECT COUNT(*) n FROM users WHERE tenant_id = ? AND active = 1')}`, `profiles ${n('SELECT COUNT(*) n FROM employee_profiles WHERE tenant_id = ?')}`,
  `2026 plans ${n("SELECT COUNT(*) n FROM plans p JOIN cycles c ON c.id = p.cycle_id WHERE p.tenant_id = ? AND c.year = 2026")}`, `2025 reviews ${n("SELECT COUNT(*) n FROM plans p JOIN cycles c ON c.id = p.cycle_id WHERE p.tenant_id = ? AND c.year = 2025")}`,
  `projects ${n('SELECT COUNT(*) n FROM projects WHERE tenant_id = ?')}`, `synthetic users ${n('SELECT COUNT(*) n FROM users WHERE tenant_id = ? AND synthetic = 1')}`]);
if (dry) { db.close(); fs.rmSync(dbFile, { force: true }); console.log('\n(dry run — the real database was not changed)'); }
