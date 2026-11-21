// LeaveBoard → Prism cutover helpers.
//
//   node scripts/leave-cutover.js check [--db …]
//     Compares, for every active person, LeaveBoard's "Available" annual vacation in the latest
//     Annual Situation import with the balance Prism holds. Lists anyone missing, at 0 or different,
//     and whether time off is open. Exits 1 when something needs attention.
//
//   node scripts/leave-cutover.js grant --year 2027 (--file entitlements.csv | --days 14) [--dry-run] [--db …]
//     Posts each person's annual vacation entitlement for the year (GB decision E).
//     entitlements.csv: email,days   (people not in the file are skipped and listed)
import fs from 'node:fs';
import { openDb } from '../src/db.js';
import { loadActor } from '../src/domain/authz.js';
import { balance, leaveStatus, grantEntitlements } from '../src/domain/leave.js';
import { fmtX100 } from '../src/domain/decimal.js';

const [cmd] = process.argv.slice(2);
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const db = openDb(arg('db') || process.env.DB_FILE || 'data/prism-people.db');
const tenant = arg('tenant') || 'gb-advisory';
const av = db.prepare("SELECT * FROM leave_types WHERE tenant_id = ? AND code = 'AV'").get(tenant);
const people = db.prepare('SELECT id, name, email FROM users WHERE tenant_id = ? AND active = 1 ORDER BY name').all(tenant);
const pad = (s, n) => String(s).padEnd(n);

if (cmd === 'check') {
  const st = leaveStatus(db, tenant);
  const batch = db.prepare("SELECT id, filename, generated_at, applied_at FROM import_batches WHERE tenant_id = ? AND kind = 'leaveboard_annual_situation' AND status = 'applied' ORDER BY applied_at DESC LIMIT 1").get(tenant);
  console.log(`Cutover: ${st.cutover || '(not set)'} · Prism time off is ${st.live ? 'OPEN' : 'closed'} · approver ${st.approver || '(per manager)'}`);
  console.log(`Latest Annual Situation import: ${batch ? `${batch.filename}, generated ${batch.generated_at || '?'}, applied ${batch.applied_at}` : 'NONE'}\n`);
  const year = Number((st.cutover || new Date().toISOString()).slice(0, 4));
  let problems = 0;
  console.log(`${pad('Person', 24)}${pad('LeaveBoard', 12)}${pad(`Prism ${year}`, 12)}${pad(`Prism ${year + 1}`, 12)}Check`);
  for (const p of people) {
    const lb = batch && db.prepare("SELECT raw_value FROM vendor_snapshot_values WHERE batch_id = ? AND user_id = ? AND category = ? AND metric = 'Available'").get(batch.id, p.id, av.vendor_label || av.name);
    const opening = db.prepare("SELECT SUM(amount_x100) a FROM leave_ledger WHERE tenant_id = ? AND user_id = ? AND type_id = ? AND kind = 'opening' AND effective_date = ?").get(tenant, p.id, av.id, st.cutover || '').a;
    const now = balance(db, tenant, p.id, av.id, year); const next = balance(db, tenant, p.id, av.id, year + 1);
    const flags = [];
    if (!lb) flags.push('not in LeaveBoard export');
    else if (opening == null) flags.push('opening balance NOT posted');
    else if (Math.round(Number(lb.raw_value) * 100) !== opening) flags.push(`opening ${fmtX100(opening)} ≠ LeaveBoard ${lb.raw_value}`);
    if (lb && Number(lb.raw_value) === 0) flags.push('0 days in LeaveBoard – confirm');
    if (!next.posted_x100) flags.push(`no ${year + 1} entitlement yet`);
    if (flags.some((f) => !/no \d{4} entitlement|not in LeaveBoard/.test(f))) problems++;
    console.log(`${pad(p.name, 24)}${pad(lb ? lb.raw_value : '—', 12)}${pad(fmtX100(now.posted_x100), 12)}${pad(fmtX100(next.posted_x100), 12)}${flags.length ? flags.join('; ') : 'OK'}`);
  }
  console.log(problems ? `\n${problems} person(s) need attention before time off opens.` : '\nAll opening balances match LeaveBoard.');
  process.exit(problems ? 1 : 0);
}

if (cmd === 'grant') {
  const year = Number(arg('year'));
  const ops = db.prepare("SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role IN ('people_ops','admin') WHERE u.tenant_id = ? AND u.active = 1 LIMIT 1").get(tenant);
  let rows; const skipped = [];
  if (arg('file')) {
    const lines = fs.readFileSync(arg('file'), 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(',').map((x) => x.trim()));
    const byEmail = Object.fromEntries(lines.map(([e, d]) => [e.toLowerCase(), d]));
    rows = people.filter((p) => byEmail[p.email.toLowerCase()]).map((p) => ({ userId: p.id, days: byEmail[p.email.toLowerCase()] }));
    skipped.push(...people.filter((p) => !byEmail[p.email.toLowerCase()]).map((p) => p.name));
  } else if (arg('days')) rows = people.map((p) => ({ userId: p.id, days: arg('days') }));
  else { console.error('Pass --file entitlements.csv or --days N'); process.exit(1); }
  if (process.argv.includes('--dry-run')) {
    for (const r of rows) console.log(`${pad(people.find((p) => p.id === r.userId).name, 24)}${r.days} days`);
    if (skipped.length) console.log(`Skipped (not in file): ${skipped.join(', ')}`);
    console.log('(dry run — nothing posted)'); process.exit(0);
  }
  const out = grantEntitlements(db, loadActor(db, ops.id), { year, rows, note: `${year} annual vacation entitlement (GB decision E)` });
  for (const o of out) console.log(`${pad(o.name, 24)}${fmtX100(o.days_x100)} days ${o.created ? 'posted' : '(already posted)'}`);
  if (skipped.length) console.log(`Skipped (not in file): ${skipped.join(', ')}`);
  process.exit(0);
}
console.log('Usage: leave-cutover.js check | grant --year YYYY (--file f.csv | --days N) [--dry-run]');
