// Apply a reviewer matrix to the plans of a cycle (idempotent; safe to re-run).
//   node scripts/assign-reviewers.js --matrix config/private/reviewers.csv --cycle <cycleId> [--db data/prism-people.db] [--dry-run]
// CSV columns:
//   email, lead_reviewer, objective_reviewer, competency_reviewer, initiative_reviewer, partner, inputs
//   inputs: semicolon list of "email|label" (e.g. "senior@x.com|Project feedback (primary)")
// The lead reviewer approves the plan, writes the summary and submits; section reviewers rate only their
// section; invited people give written input only. Plans past manager review are never changed.
import fs from 'node:fs';
import { openDb, tx } from '../src/db.js';
import { loadActor } from '../src/domain/authz.js';
import { setCategoryReviewer, inviteInput } from '../src/domain/performance.js';
import { parseCsv } from '../src/imports/gemini.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const dry = process.argv.includes('--dry-run');
const db = openDb(arg('db', process.env.DB_FILE || 'data/prism-people.db'));
const cycleId = arg('cycle');
const [head, ...rows] = parseCsv(fs.readFileSync(arg('matrix', 'config/private/reviewers.csv'), 'utf8'));
const cycle = db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId);
if (!cycle) { console.error('Unknown --cycle'); process.exit(1); }
const ops = db.prepare("SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role IN ('people_ops','admin') WHERE u.tenant_id = ? LIMIT 1").get(cycle.tenant_id);
if (!ops) { console.error('No People Ops / admin user in this workspace'); process.exit(1); }
const actor = loadActor(db, ops.id);
const idOf = (email) => (email ? db.prepare('SELECT id FROM users WHERE tenant_id = ? AND lower(email) = lower(?)').get(cycle.tenant_id, email.trim())?.id : null);
const report = [];
try { tx(db, () => {
  for (const r of rows) {
    const x = Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || '').trim()]));
    const uid = idOf(x.email);
    const plan = uid && db.prepare('SELECT * FROM plans WHERE cycle_id = ? AND user_id = ?').get(cycleId, uid);
    if (!plan) { report.push(`${x.email}: no plan in ${cycle.name} — skipped`); continue; }
    if (['partner_calibration', 'released', 'acknowledged', 'closed'].includes(plan.state)) { report.push(`${x.email}: ${plan.state} — not changed`); continue; }
    const lead = idOf(x.lead_reviewer); const partner = idOf(x.partner);
    if (x.lead_reviewer && !lead) { report.push(`${x.email}: lead reviewer ${x.lead_reviewer} not found`); continue; }
    if (!dry) db.prepare('UPDATE plans SET reviewer_id = COALESCE(?, reviewer_id), partner_id = COALESCE(?, partner_id) WHERE id = ?').run(lead, partner, plan.id);
    for (const cat of ['objective', 'competency', 'initiative']) {
      const v = x[`${cat}_reviewer`]; if (!v) continue;
      const id = idOf(v); if (!id) { report.push(`${x.email}: ${cat} reviewer ${v} not found`); continue; }
      if (!dry) setCategoryReviewer(db, actor, plan.id, { category: cat, userId: id });
    }
    for (const inv of (x.inputs || '').split(';').map((s) => s.trim()).filter(Boolean)) {
      const [email, label] = inv.split('|');
      const id = idOf(email); if (!id) { report.push(`${x.email}: input ${email} not found`); continue; }
      if (!dry) inviteInput(db, actor, plan.id, { inviteeId: id, label: label || 'Project feedback' });
    }
    report.push(`${x.email}: lead=${x.lead_reviewer || '(unchanged)'} objectives=${x.objective_reviewer || 'lead'} competencies=${x.competency_reviewer || 'lead'} inputs=${(x.inputs || '').split(';').filter(Boolean).length}`);
  }
  if (dry) throw Object.assign(new Error('dry-run'), { dry: true });
}); } catch (e) { if (!e.dry) throw e; report.push('(dry run — nothing written)'); }
console.log(report.join('\n'));
