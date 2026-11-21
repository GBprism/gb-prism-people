// Load the GB "2026 PMS – Consultant Reviewers" workbook (Employee Profiles, Reviewer Matrix,
// 2026 Project Log). The workbook holds personal data: keep it in config/private or upload it
// straight to the server; never commit it.
//   node scripts/load-gb-workbook.js --file config/private/reviewers-2026.xlsx [--evidence config/private/real/hr-evidence.json] [--cycle <id>] [--db data/prism-people.db] [--dry-run]
import fs from 'node:fs';
import { openDb } from '../src/db.js';
import { loadActor } from '../src/domain/authz.js';
import { parseGbWorkbook, applyGbWorkbook, applyHrEvidence } from '../src/imports/gbworkbook.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const file = arg('file');
if (!file || !fs.existsSync(file)) { console.error('Pass --file <workbook.xlsx>'); process.exit(1); }
const db = openDb(arg('db', process.env.DB_FILE || 'data/prism-people.db'));
const ops = db.prepare("SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role IN ('people_ops','admin') WHERE u.active = 1 ORDER BY u.synthetic LIMIT 1").get();
if (!ops) { console.error('No People Ops / admin user found'); process.exit(1); }
const parsed = await parseGbWorkbook(fs.readFileSync(file));
console.log(`Read ${parsed.profiles.length} profiles, ${parsed.matrix.length} reviewer rows, ${parsed.log.length} project-log rows`);
const rep = applyGbWorkbook(db, loadActor(db, ops.id), parsed, { cycleId: arg('cycle'), dry: process.argv.includes('--dry-run') });
for (const [k, title] of [['profiles', 'HR profiles'], ['reviewers', 'Reviewers (2026 cycle)'], ['projects', 'Project register'], ['skipped', 'Skipped']]) {
  console.log(`\n== ${title} (${rep[k].length})`); for (const l of rep[k]) console.log(`  ${l}`);
}
const evFile = arg('evidence');
if (evFile) {
  const ev = applyHrEvidence(db, loadActor(db, ops.id), JSON.parse(fs.readFileSync(evFile, 'utf8')), { dry: process.argv.includes('--dry-run') });
  console.log(`\n== Evidence from email (${ev.updated.length})`); for (const l of [...ev.updated, ...ev.skipped]) console.log(`  ${l}`);
}
if (rep.dry) console.log('\n(dry run — nothing written)');
