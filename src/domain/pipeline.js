// Sales pipeline on top of the Library's proposals and clients: stage, value, probability, owner,
// next step and date, expected close and start, client contacts, lost reason. Weighted forecast by
// quarter. "Won" creates the project and its Library engagement and confirms tentative bookings.
// Partners and People Ops see everything; anyone else sees the opportunities they own.
import { tx, uid, now, audit, bad, forbid, notFound } from '../db.js';
import { isOps, has } from './authz.js';
import { toX100 } from './decimal.js';
import { clientFor } from './library.js';
import { createProject } from './projects.js';

export const STAGES = [
  { key: 'lead', label: 'Lead', probability: 10, outcome: 'drafting' },
  { key: 'qualifying', label: 'Qualifying', probability: 20, outcome: 'drafting' },
  { key: 'proposal', label: 'Writing proposal', probability: 35, outcome: 'drafting' },
  { key: 'submitted', label: 'Submitted', probability: 50, outcome: 'submitted' },
  { key: 'negotiation', label: 'Negotiation', probability: 75, outcome: 'submitted' },
  { key: 'won', label: 'Won', probability: 100, outcome: 'won' },
  { key: 'lost', label: 'Lost', probability: 0, outcome: 'lost' },
  { key: 'withdrawn', label: 'Withdrawn / no-go', probability: 0, outcome: 'withdrawn' },
];
export const LOST_REASONS = ['Price', 'Scope or approach', 'Timing', 'Went to a competitor', 'Relationship', 'Client made no decision', 'Other'];
const OPEN = ['lead', 'qualifying', 'proposal', 'submitted', 'negotiation'];
const stageOf = (p) => p.stage || ({ drafting: 'proposal', submitted: 'submitted', won: 'won', lost: 'lost', withdrawn: 'withdrawn', no_go: 'withdrawn' })[p.outcome] || 'proposal';
const all = (a) => isOps(a) || has(a, 'partner');
const quarter = (d) => (d ? `${d.slice(0, 4)} Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}` : 'No date');

export function pipelineView(db, actor) {
  const T = actor.tenantId;
  const rows = db.prepare(`SELECT p.*, c.name_en client, c.short client_short, c.sector, c.country, u.name owner, k.name contact_name, k.email contact_email, k.role contact_role
      FROM proposals p JOIN clients c ON c.id = p.client_id LEFT JOIN users u ON u.id = p.owner_user_id LEFT JOIN client_contacts k ON k.id = p.contact_id
      WHERE p.tenant_id = ? ${all(actor) ? '' : 'AND p.owner_user_id = ?'} ORDER BY COALESCE(p.next_step_on, p.expected_close, p.submitted_on, '9999') `).all(...(all(actor) ? [T] : [T, actor.id]))
    .map((p) => { const stage = stageOf(p); const prob = p.probability ?? STAGES.find((s) => s.key === stage).probability;
      return { ...p, stage, probability: prob, weighted_x100: p.value_x100 ? Math.round((p.value_x100 * prob) / 100) : 0,
        next_overdue: OPEN.includes(stage) && p.next_step_on && p.next_step_on < new Date().toISOString().slice(0, 10) }; });
  const open = rows.filter((r) => OPEN.includes(r.stage));
  const year = new Date().getFullYear();
  const decided = rows.filter((r) => ['won', 'lost'].includes(r.stage) && (r.decided_on || r.submitted_on || '').startsWith(String(year)));
  const won = decided.filter((r) => r.stage === 'won');
  const byQuarter = new Map(); for (const r of open) { const q = quarter(r.expected_close); const v = byQuarter.get(q) || { quarter: q, value_x100: 0, weighted_x100: 0, n: 0 }; v.value_x100 += r.value_x100 || 0; v.weighted_x100 += r.weighted_x100; v.n++; byQuarter.set(q, v); }
  const lost = rows.filter((r) => r.stage === 'lost' && r.lost_reason); const reasons = {}; for (const r of lost) reasons[r.lost_reason] = (reasons[r.lost_reason] || 0) + 1;
  return { stages: STAGES, lost_reasons: LOST_REASONS, rows, canAll: all(actor),
    totals: { open: open.length, open_value_x100: open.reduce((s, r) => s + (r.value_x100 || 0), 0), weighted_x100: open.reduce((s, r) => s + r.weighted_x100, 0),
      won_value_x100: won.reduce((s, r) => s + (r.value_x100 || 0), 0), hit_rate: decided.length ? Math.round((won.length / decided.length) * 100) : null, year,
      overdue_next_steps: open.filter((r) => r.next_overdue).length, no_value: open.filter((r) => !r.value_x100).length },
    by_quarter: [...byQuarter.values()].sort((a, b) => a.quarter.localeCompare(b.quarter)), lost_reasons_count: reasons };
}

function load(db, actor, id) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!p) throw notFound();
  if (!all(actor) && p.owner_user_id !== actor.id) throw forbid();
  return p;
}

/** Create or update an opportunity. Partners / People Ops create; owners update their own. */
export function saveOpportunity(db, actor, id, b = {}) {
  return tx(db, () => {
    let p = id ? load(db, actor, id) : null;
    if (!p && !all(actor)) throw forbid('Ask a partner to add the opportunity');
    const set = {};
    const str = (v, n) => String(v ?? '').trim().slice(0, n) || null;
    const date = (v, l) => { if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`${l}: use yyyy-mm-dd`); return v; };
    if ('title_en' in b) { set.title_en = str(b.title_en, 200); if (!set.title_en) throw bad('Name the opportunity'); }
    if ('stage' in b) { const s = STAGES.find((x) => x.key === b.stage); if (!s) throw bad('Unknown stage'); set.stage = s.key; set.outcome = s.outcome;
      if (['won', 'lost', 'withdrawn'].includes(s.key) && !p?.decided_on) set.decided_on = new Date().toISOString().slice(0, 10);
      if (s.key === 'submitted' && !p?.submitted_on) set.submitted_on = new Date().toISOString().slice(0, 10);
      if (!('probability' in b)) set.probability = s.probability; }
    if (set.stage === 'lost') { set.lost_reason = LOST_REASONS.includes(b.lost_reason) ? b.lost_reason : null; if (!set.lost_reason) throw bad('Choose why it was lost'); }
    if ('value' in b) { let v; try { v = b.value === '' || b.value == null ? null : toX100(b.value); } catch (e) { throw bad(e.message); } if (v != null && v < 0) throw bad('Value must be positive'); set.value_x100 = v; }
    if ('currency' in b) set.currency = /^[A-Z]{3}$/.test(b.currency || '') ? b.currency : 'JOD';
    if ('probability' in b) { const n = Math.round(Number(b.probability)); if (!(n >= 0 && n <= 100)) throw bad('Probability is 0–100%'); set.probability = n; }
    if ('owner_user_id' in b) { if (b.owner_user_id && !db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ?').get(b.owner_user_id, actor.tenantId)) throw bad('Unknown owner'); set.owner_user_id = b.owner_user_id || null;
      if (b.owner_user_id) set.owner_name = db.prepare('SELECT name FROM users WHERE id = ?').get(b.owner_user_id).name; }
    if ('next_step' in b) set.next_step = str(b.next_step, 300);
    if ('next_step_on' in b) set.next_step_on = date(b.next_step_on, 'Next step date');
    if ('expected_close' in b) set.expected_close = date(b.expected_close, 'Expected decision');
    if ('expected_start' in b) set.expected_start = date(b.expected_start, 'Expected start');
    if ('domain' in b) set.domain = str(b.domain, 120);
    if ('drive_url' in b) { const u = str(b.drive_url, 1000); if (u && !/^https:\/\/(drive|docs)\.google\.com\//.test(u)) throw bad('Use a Google Drive link'); set.drive_url = u; }
    if ('contact_id' in b) set.contact_id = b.contact_id || null;
    if (!p) {
      const client = clientFor(db, actor, b);
      if (!set.title_en) throw bad('Name the opportunity');
      const newId = uid('prop_');
      db.prepare("INSERT INTO proposals (id, tenant_id, client_id, key, title_en, outcome, stage, source, updated_by, updated_at) VALUES (?,?,?,?,?, 'drafting', 'lead', 'Pipeline', ?, ?)")
        .run(newId, actor.tenantId, client.id, `app-${newId}`, set.title_en, actor.id, now());
      p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(newId);
      if (!('stage' in set)) { set.stage = 'lead'; set.probability ??= 10; }
    }
    const keys = Object.keys(set);
    if (keys.length) db.prepare(`UPDATE proposals SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`).run(...keys.map((k) => set[k]), actor.id, now(), p.id);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: id ? 'pipeline.update' : 'pipeline.create', entity: 'proposal', entityId: p.id, before: id ? { stage: stageOf(p) } : null, after: { stage: set.stage, value: set.value_x100 != null } });
    return { id: p.id };
  });
}

/** Won: create the project (lead = owner) and the running Library engagement; confirm tentative bookings. */
export function convertToProject(db, actor, id) {
  if (!all(actor)) throw forbid();
  return tx(db, () => {
    const p = load(db, actor, id);
    if (stageOf(p) !== 'won') throw bad('Mark the opportunity won first');
    if (p.engagement_id) { const e = db.prepare('SELECT project_id FROM engagements WHERE id = ?').get(p.engagement_id); if (e?.project_id) return { project_id: e.project_id, existing: true }; }
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id);
    const name = `${client.short || client.name_en} – ${p.title_en}`.slice(0, 160);
    const start = p.expected_start || new Date().toISOString().slice(0, 10);
    const projectId = createProject(db, actor, { name, client: client.name_en, kind: 'engagement', leadUserId: p.owner_user_id || null, startDate: start, registerStatus: 'approved', sourceRef: `Pipeline: ${p.id}` });
    const engId = uid('eng_');
    db.prepare(`INSERT INTO engagements (id, tenant_id, client_id, key, title_en, domain, year_from, status, lead_name, drive_url, project_id, source, updated_by, updated_at)
        VALUES (?,?,?,?,?,?,?, 'running', ?,?,?, 'Won in the pipeline', ?, ?)`).run(engId, actor.tenantId, p.client_id, `app-${engId}`, p.title_en, p.domain, Number(start.slice(0, 4)), p.owner_name || null, p.drive_url, projectId, actor.id, now());
    db.prepare('UPDATE proposals SET engagement_id = ? WHERE id = ?').run(engId, p.id);
    db.prepare("UPDATE resource_bookings SET project_id = ?, proposal_id = NULL, status = 'confirmed' WHERE proposal_id = ?").run(projectId, p.id);
    for (const b of db.prepare('SELECT DISTINCT user_id FROM resource_bookings WHERE project_id = ?').all(projectId))
      db.prepare("INSERT INTO project_assignments (id, tenant_id, project_id, user_id, role, status, start_date, source) VALUES (?,?,?,?, 'team member', 'tentative', ?, 'Booked from the pipeline')").run(uid('asg_'), actor.tenantId, projectId, b.user_id, start);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'pipeline.won_to_project', entity: 'proposal', entityId: p.id, after: { projectId } });
    return { project_id: projectId };
  });
}

// --------------------------------------------------------------- contacts --
export function contacts(db, actor, clientId) {
  if (!all(actor) && !db.prepare('SELECT 1 FROM proposals WHERE client_id = ? AND owner_user_id = ?').get(clientId, actor.id)) throw forbid();
  return db.prepare('SELECT * FROM client_contacts WHERE client_id = ? AND tenant_id = ? ORDER BY name').all(clientId, actor.tenantId);
}
export function saveContact(db, actor, id, c = {}) {
  if (!all(actor) && !db.prepare('SELECT 1 FROM proposals WHERE client_id = ? AND owner_user_id = ?').get(c.client_id, actor.id)) throw forbid();
  if (!db.prepare('SELECT 1 FROM clients WHERE id = ? AND tenant_id = ?').get(c.client_id, actor.tenantId)) throw bad('Unknown client');
  const name = String(c.name || '').trim().slice(0, 120); if (!name) throw bad('Contact name required');
  const email = String(c.email || '').trim().slice(0, 160); if (email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) throw bad('Check the email address');
  const vals = [c.client_id, name, String(c.role || '').slice(0, 120) || null, email || null, String(c.phone || '').slice(0, 40) || null, String(c.notes || '').slice(0, 500) || null,
    /^\d{4}-\d{2}-\d{2}$/.test(c.last_contact_on || '') ? c.last_contact_on : null, now()];
  if (id) { const r = db.prepare('UPDATE client_contacts SET client_id = ?, name = ?, role = ?, email = ?, phone = ?, notes = ?, last_contact_on = ?, updated_at = ? WHERE id = ? AND tenant_id = ?').run(...vals, id, actor.tenantId); if (!r.changes) throw notFound(); }
  else { id = uid('ct_'); db.prepare('INSERT INTO client_contacts (client_id, name, role, email, phone, notes, last_contact_on, updated_at, id, tenant_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...vals, id, actor.tenantId); }
  return { id };
}

/** Inbox: the owner's overdue next steps. */
export function overdueSteps(db, actor) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(`SELECT p.id, p.title_en, p.next_step, p.next_step_on, c.short, c.name_en FROM proposals p JOIN clients c ON c.id = p.client_id
      WHERE p.tenant_id = ? AND p.owner_user_id = ? AND p.next_step_on < ? AND COALESCE(p.stage, 'proposal') IN ('lead','qualifying','proposal','submitted','negotiation')`).all(actor.tenantId, actor.id, today);
}
