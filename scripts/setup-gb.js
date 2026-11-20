// Bootstrap the real GB Advisory workspace (run once, after GB sign-off).
//   node scripts/setup-gb.js --roster roster.csv [--decisions config/private/gb-decisions.json] [--db data/prism-people.db]
// roster.csv columns: email,name,title,role_family,manager_email,backup_email,country,hire_date,probation_end,roles,aliases
//   aliases: semicolon list of other spellings (LeaveBoard names, form file-name prefixes)
//   roles: semicolon list of partner|people_ops|admin (employee is implicit)
// Loads: role templates (config/gb-role-templates-2026.json, status=candidate),
// candidate leave types and policy (status=awaiting_confirmation), 2026/2027 cycles.
// It never imports reviews, balances or leave history — use the Import center.
import fs from 'node:fs';
import { openDb, tx, uid, J } from '../src/db.js';
import { DEFAULT_SCORING } from '../src/domain/scoring.js';
import { CANDIDATE_POLICY } from '../src/domain/leave.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const db = openDb(arg('db', process.env.DB_FILE || 'data/prism-people.db'));
const TENANT = arg('tenant', 'gb-advisory');
const cfg = JSON.parse(fs.readFileSync(new URL('../config/gb-role-templates-2026.json', import.meta.url)));
const decisionsPath = arg('decisions', 'config/private/gb-decisions.json');
if (!fs.existsSync(decisionsPath)) { console.error(`Missing ${decisionsPath} — copy config/gb-decisions.example.json and fill it in`); process.exit(1); }
const decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
const holidays = JSON.parse(fs.readFileSync(new URL('../config/holidays-JO.json', import.meta.url)));
const rosterFile = arg('roster');
if (!rosterFile) { console.error('Provide --roster roster.csv (verified work emails only)'); process.exit(1); }
const rows = fs.readFileSync(rosterFile, 'utf8').trim().split(/\r?\n/).map((l) => l.split(',').map((x) => x.trim()));
const head = rows.shift();
const rec = rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] || null])))
  .filter((r) => !decisions.exclude_people.includes((r.email || '').toLowerCase()))
  .map((r) => ({ ...r, title: decisions.titles[(r.email || '').toLowerCase()] || r.title }));
for (const r of rec) if (!/^[^@\s]+@[^@\s]+$/.test(r.email || '')) { console.error('Invalid email for', r.name); process.exit(1); }

tx(db, () => {
  if (!db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(TENANT)) db.prepare("INSERT INTO tenants (id, name) VALUES (?, 'GB Advisory')").run(TENANT);
  const idOf = {};
  for (const r of rec) {
    const ex = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND lower(email) = lower(?)').get(TENANT, r.email);
    idOf[r.email.toLowerCase()] = ex?.id || uid('u_');
    if (!ex) db.prepare('INSERT INTO users (id, tenant_id, email, name) VALUES (?,?,?,?)').run(idOf[r.email.toLowerCase()], TENANT, r.email.toLowerCase(), r.name);
    for (const role of (r.roles || '').split(';').filter(Boolean)) db.prepare('INSERT OR IGNORE INTO user_roles VALUES (?,?)').run(idOf[r.email.toLowerCase()], role);
    // admin-confirmed spellings used in LeaveBoard exports and PMS form file names
    for (const a of (r.aliases || '').split(';').map((x) => x.trim()).filter(Boolean)) for (const src of ['leaveboard', 'pms_form', 'pms'])
      db.prepare('INSERT OR IGNORE INTO identity_aliases (id, tenant_id, user_id, source, alias, verified) VALUES (?,?,?,?,?,1)').run(uid('al_'), TENANT, idOf[r.email.toLowerCase()], src, a);
  }
  for (const r of rec) {
    const id = idOf[r.email.toLowerCase()];
    if (db.prepare('SELECT 1 FROM employments WHERE user_id = ? AND effective_to IS NULL').get(id)) continue;
    db.prepare(`INSERT INTO employments (id, tenant_id, user_id, title, role_family, manager_id, backup_approver_id, country, hire_date, probation_end, effective_from)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(uid('emp_'), TENANT, id, r.title, r.role_family || 'consultant', idOf[(r.manager_email || '').toLowerCase()] ?? null,
      idOf[(r.backup_email || '').toLowerCase()] ?? null, r.country || 'JO', r.hire_date, r.probation_end, r.hire_date || '2026-01-01');
  }
  for (const t of cfg.templates) db.prepare(`INSERT OR IGNORE INTO role_templates (id, tenant_id, role_family, version, category_weights_json, starter_items_json, status, source_note) VALUES (?,?,?,1,?,?,'candidate',?)`)
    .run(`tpl_${TENANT}_${t.role_family}`, TENANT, t.role_family, J(t.weights), J(t.items), cfg._source);
  const scoring = { ...DEFAULT_SCORING, thresholds: cfg.bands.map(({ min, label }) => ({ min, label })), precision: decisions.scoring.precision, status: decisions.scoring.status };
  for (const [date, name] of holidays.holidays) db.prepare('INSERT OR IGNORE INTO holidays (id, tenant_id, calendar, date, name) VALUES (?,?,?,?,?)').run(uid('hol_'), TENANT, holidays.calendar, date, name);
  const setting = (k, v) => db.prepare('INSERT INTO settings (tenant_id, key, value_json) VALUES (?,?,?) ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json').run(TENANT, k, J(v));
  setting('decision_initiatives_2026', { rule: decisions.initiatives['2026'], note: decisions.initiatives['2026_note'] });
  setting('decisions', decisions);
  for (const seat of decisions.claude_seats) for (const email of seat.users) {
    if (db.prepare('SELECT 1 FROM ai_seat_attributions WHERE tenant_id = ? AND seat_email = ? AND candidate_name = ? AND evidence_type = ?').get(TENANT, seat.seat, email, 'owner_statement')) continue;
    db.prepare(`INSERT INTO ai_seat_attributions (id, tenant_id, tool, seat_email, user_id, candidate_name, evidence_type, evidence_detail, confidence, status, confirmed_by, confirmed_at, source, created_at)
        VALUES (?,?, 'claude', ?, ?, ?, 'owner_statement', ?, 'high', 'confirmed', ?, datetime('now'), 'gb-decisions.json', datetime('now'))`)
      .run(uid('seat_'), TENANT, seat.seat, idOf[email] ?? null, email, seat.note || 'Confirmed by the Claude Primary Owner on 2026-11-19', idOf[decisions.partners[0]] ?? null);
  }
  for (const p of decisions.partners) if (idOf[p]) db.prepare("INSERT OR IGNORE INTO user_roles VALUES (?, 'partner')").run(idOf[p]);
  const c26 = decisions.cycle_2026;
  db.prepare("INSERT OR IGNORE INTO cycles (id, tenant_id, year, name, status, self_due, manager_due, calibration_due, scoring_json) VALUES (?,?,2026,'2026 year-end review','open',?,?,?,?)")
    .run(`cyc_${TENANT}_2026`, TENANT, c26.self_due, c26.manager_due, c26.calibration_due, J(scoring));
  db.prepare("INSERT OR IGNORE INTO cycles (id, tenant_id, year, name, status, self_due, scoring_json) VALUES (?,?,2027,'2027 plan','planning','2027-02-15',?)").run(`cyc_${TENANT}_2027`, TENANT, J(scoring));
  const LT = [['AV', 'Annual vacation', 'leave', 1, 'Annual Vacation', 1], ['SL', 'Sick leave', 'leave', 1, 'Sick leave', 0], ['WFH', 'Work from home / off-site', 'offsite', 0, 'Work From Home', 0],
    ['COO', 'Compensation of overtime', 'leave', 1, 'Compensation of Overtime', 0], ['OT', 'Overtime', 'overtime', 0, 'Overtime', 0], ['WL', 'Wedding leave', 'leave', 1, 'Wedding Leave', 0]];
  for (const [code, name, cat, bal, vendor, cover] of LT) db.prepare('INSERT OR IGNORE INTO leave_types (id, tenant_id, code, name, category, tracks_balance, requires_cover, vendor_label) VALUES (?,?,?,?,?,?,?,?)')
    .run(`lt_${TENANT}_${code}`, TENANT, code, name, cat, bal, cover, vendor);
  db.prepare("INSERT OR IGNORE INTO policy_versions (id, tenant_id, version, effective_from, status, settings_json, note) VALUES (?, ?, 1, '2026-01-01', 'awaiting_confirmation', ?, ?)")
    .run(`pol_${TENANT}_1`, TENANT, J({ ...CANDIDATE_POLICY, workday: { start: decisions.workday.start, end: decisions.workday.end }, hoursPerDay: decisions.workday.hours, requireApprovedPolicy: true }), 'Candidate from handbook + LeaveBoard. Requests stay closed until GB approves.');
  db.prepare("INSERT OR IGNORE INTO settings (tenant_id, key, value_json) VALUES (?, 'notification_mode', ?)").run(TENANT, J('test'));
  // 2025 joiners (probation last year): draft 2026 plans on the Consultant template; targets agreed with the reviewer, then approved in Prism
  const tpl = db.prepare('SELECT * FROM role_templates WHERE tenant_id = ? AND role_family = ?').get(TENANT, decisions.new_joiners_2025.template);
  for (const email of decisions.new_joiners_2025.emails) {
    const uidv = idOf[email]; if (!uidv || !tpl) continue;
    if (db.prepare('SELECT 1 FROM plans WHERE cycle_id = ? AND user_id = ?').get(`cyc_${TENANT}_2026`, uidv)) continue;
    const emp = db.prepare('SELECT * FROM employments WHERE user_id = ? AND effective_to IS NULL').get(uidv);
    const pid = uid('plan_');
    db.prepare(`INSERT INTO plans (id, tenant_id, cycle_id, user_id, reviewer_id, template_id, role_title, category_weights_json, rubric_version, basis_status, basis_note, created_at)
        VALUES (?,?,?,?,?,?,?,?,?, 'gb_decision', ?, datetime('now'))`).run(pid, TENANT, `cyc_${TENANT}_2026`, uidv, emp?.manager_id ?? null, tpl.id, emp?.title ?? 'Consultant',
      tpl.category_weights_json, `consultant@v${tpl.version}`, decisions.new_joiners_2025.basis);
    JSON.parse(tpl.starter_items_json).forEach((it, i) => {
      const iid = uid('item_');
      db.prepare('INSERT INTO plan_items (id, tenant_id, plan_id, category, position, title, description, kpi, target, weight, expected_proficiency) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(iid, TENANT, pid, it.category, i, it.title, it.description ?? null, it.kpi ?? null, it.target ?? null, it.weight, it.expected_proficiency ?? null);
      if (it.category === 'initiative') db.prepare('UPDATE plan_items SET na = 1, na_reason = ?, na_approved_by = ? WHERE id = ?').run(decisions.initiatives['2026_note'], idOf[decisions.partners[0]] ?? null, iid);
    });
  }
});
console.log(`GB workspace ready: ${rec.length} people. Templates, scoring and leave policy are CANDIDATES until GB approves them in Admin.`);
