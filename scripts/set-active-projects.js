// GB's list of what is running now and who is on it. The list is authoritative from --as-of (default today):
//   node scripts/set-active-projects.js --file config/private/real/active-projects.json --by layan@gb-advisory.com [--db …] [--apply]
// Without --apply it only prints what would change (nothing is saved).
import fs from 'node:fs';
import { openDb } from '../src/db.js';
import { loadActor } from '../src/domain/authz.js';
import { applyActiveProjects } from '../src/imports/active-projects.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const db = openDb(arg('db') || process.env.DB_FILE || 'data/prism-people.db');
const tenant = arg('tenant') || 'gb-advisory';
const file = JSON.parse(fs.readFileSync(arg('file') || 'config/private/real/active-projects.json', 'utf8'));
const by = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND lower(email) = lower(?) AND active = 1').get(tenant, arg('by') || '');
if (!by) { console.error('Pass --by <email of an active partner or People Ops user>'); process.exit(1); }
const actor = loadActor(db, by.id);
if (!actor.roles.has('partner') && !actor.roles.has('people_ops') && !actor.roles.has('admin')) { console.error('--by must be a partner or People Ops'); process.exit(1); }
const apply = process.argv.includes('--apply');
let report;
db.exec('BEGIN');
try { report = applyActiveProjects(db, actor, file, { asOf: arg('as-of') || file.as_of || undefined }); db.exec(apply ? 'COMMIT' : 'ROLLBACK'); } catch (e) { db.exec('ROLLBACK'); console.error(e.message); process.exit(1); }
const section = (t, rows) => { if (rows.length) { console.log(`\n${t}`); for (const r of rows) console.log(`  ${r}`); } };
section('Active projects', report.projects); section('People', report.people); section('No longer running (marked completed)', report.closed);
section('Library', report.library);
section('Still "running" in the Library but not on your list (not changed — update in Library if finished)', report.library_still_running);
section('Check', report.warnings);
console.log(apply ? '\nSaved.' : '\nDry run: nothing saved. Add --apply to save.');
