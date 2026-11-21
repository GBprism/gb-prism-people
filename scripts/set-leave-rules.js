// GB leave rules that are decisions, not data:
//   node scripts/set-leave-rules.js --approver layan@gb-advisory.com --cutover 2026-12-31 [--db data/prism-people.db]
// --approver  one person approves every employee's leave; their own requests go to their manager/backup.
// --escalate-days N  the backup approver (the approver's manager) sees requests after N days, or at once when the approver is on leave (default 2).
// --cutover   LeaveBoard stays the system of record up to this date. Prism opens time-off requests once
//             opening balances are posted at the cutover (load-gb-all.js --cutover <date> with a year-end export).
import { openDb, J, audit } from '../src/db.js';
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const db = openDb(arg('db') || process.env.DB_FILE || 'data/prism-people.db');
const tenant = arg('tenant') || 'gb-advisory';
const set = (k, v) => db.prepare('INSERT INTO settings (tenant_id, key, value_json) VALUES (?,?,?) ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json').run(tenant, k, J(v));
const email = arg('approver');
if (email) {
  const u = db.prepare('SELECT id, name FROM users WHERE tenant_id = ? AND lower(email) = lower(?) AND active = 1').get(tenant, email);
  if (!u) { console.error(`No active user ${email}`); process.exit(1); }
  set('leave_approver', u.id); audit(db, { tenantId: tenant, actorId: null, action: 'settings.leave_approver', entity: 'settings', entityId: 'leave_approver', after: { email } });
  const open = db.prepare("SELECT COUNT(*) n FROM leave_requests WHERE tenant_id = ? AND state = 'submitted' AND approver_id != ? AND user_id != ?").get(tenant, u.id, u.id).n;
  if (open) db.prepare("UPDATE leave_requests SET approver_id = ? WHERE tenant_id = ? AND state = 'submitted' AND user_id != ?").run(u.id, tenant, u.id);
  console.log(`Leave approver: ${u.name}${open ? ` (${open} pending request(s) moved to them)` : ''}`);
}
const cutover = arg('cutover');
if (cutover) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutover)) { console.error('--cutover must be yyyy-mm-dd'); process.exit(1); }
  set('leave_cutover', cutover); audit(db, { tenantId: tenant, actorId: null, action: 'settings.leave_cutover', entity: 'settings', entityId: 'leave_cutover', after: { cutover } });
  const live = db.prepare("SELECT 1 FROM leave_ledger WHERE tenant_id = ? AND kind = 'opening' LIMIT 1").get(tenant);
  console.log(`LeaveBoard cutover: ${cutover} — Prism time off is ${live ? 'open (opening balances posted)' : 'closed until opening balances are posted at the cutover'}`);
}
const esc = arg('escalate-days');
if (esc) {
  if (!/^\d+$/.test(esc)) { console.error('--escalate-days must be a whole number'); process.exit(1); }
  set('leave_escalate_days', Number(esc)); console.log(`Backup approver sees requests after ${esc} day(s), or at once when the approver is away`);
}
if (!email && !cutover && !esc) console.log('Nothing to do: pass --approver, --cutover and/or --escalate-days');
