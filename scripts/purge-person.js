// Remove every trace of a person who is not (or no longer) in the portal, e.g. a former employee
// whose rows were staged by an import. Reports by default; --apply deletes.
//   node scripts/purge-person.js --match "Muhyeddin" --match "Beretar" [--db …] [--apply]
// Deletes matching rows from staging and lookup tables (import rows, aliases, vendor snapshots,
// AI usage and seat leads) and scrubs the name from the stored GB decisions note. It never touches a
// real user account, reviews or leave records: if the name belongs to an active user it stops.
// The exclusion list in the GB decisions (exclude_people) is kept on purpose — it keeps them out.
import { openDb, J, audit } from '../src/db.js';

const args = process.argv.slice(2);
const pats = args.flatMap((a, i) => (a === '--match' ? [args[i + 1]] : [])).filter(Boolean);
const apply = args.includes('--apply');
const dbArg = args[args.indexOf('--db') + 1];
if (!pats.length) { console.error('Pass at least one --match "Name"'); process.exit(1); }
const db = openDb(args.includes('--db') ? dbArg : process.env.DB_FILE || 'data/prism-people.db');
const like = (col) => `(${pats.map(() => `${col} LIKE ?`).join(' OR ')})`;
const vals = pats.map((p) => `%${p}%`);

const users = db.prepare(`SELECT id, name, active FROM users WHERE ${like('name')} OR ${like('email')}`).all(...vals, ...vals);
if (users.some((u) => u.active)) { console.error(`Stopped: an active user matches (${users.map((u) => u.name).join(', ')}). Deactivate them first.`); process.exit(1); }

const DELETE_FROM = ['import_rows', 'identity_aliases', 'vendor_snapshot_values', 'ai_usage_rows', 'ai_seat_attributions'];
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
const found = [];
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info("${t}")`).all().filter((c) => /TEXT/i.test(c.type) || c.type === '').map((c) => c.name);
  if (!cols.length) continue;
  const where = cols.map((c) => like(`"${c}"`)).join(' OR ');
  const n = db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE ${where}`).get(...cols.flatMap(() => vals)).n;
  if (n) found.push({ t, n, where, cols });
}
if (!found.length) { console.log('Nothing found — already clean.'); process.exit(0); }
for (const f of found) console.log(`${f.t}: ${f.n} row(s) ${DELETE_FROM.includes(f.t) ? '→ delete' : f.t === 'settings' ? '→ keep the exclusion list (it keeps them out); remove the name from the note' : '→ left as is (review)'}`);
if (!apply) { console.log('\n(report only — add --apply to remove)'); process.exit(0); }

const re = new RegExp(pats.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
db.exec('BEGIN IMMEDIATE');
try {
  for (const f of found) {
    if (DELETE_FROM.includes(f.t)) db.prepare(`DELETE FROM "${f.t}" WHERE ${f.where}`).run(...f.cols.flatMap(() => vals));
    if (f.t === 'settings') {
      for (const s of db.prepare(`SELECT rowid, key, value_json FROM settings WHERE ${like('value_json')}`).all(...vals)) {
        const v = JSON.parse(s.value_json);
        if (typeof v.exclude_note === 'string') v.exclude_note = v.exclude_note.split(/;\s*/).filter((x) => !re.test(x)).join('; ') || 'Former employees are excluded';
        db.prepare('UPDATE settings SET value_json = ? WHERE rowid = ?').run(J(v), s.rowid);
      }
    }
  }
  const tenant = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get()?.id;
  audit(db, { tenantId: tenant, actorId: null, action: 'data.purge_person', entity: 'person', entityId: null, reason: 'Former employee removed from staged data', after: { tables: found.map((f) => f.t) } });
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }
console.log('\nDone. Run again without --apply to confirm nothing is left in the deletable tables.');
