// Knowledge library: every client GB has worked with, what we did for them (English and Arabic),
// who worked on it, the Drive folder, delivery status and proposal outcomes — plus GB's strategy
// objectives and KPIs, and the links from people's plan items to those KPIs.
// Everyone in the workspace can read the library and the strategy; partners and People Ops edit.
// No fees, contract values or client contacts are stored here.
import { tx, uid, now, audit, bad, forbid, notFound } from '../db.js';
import { isOps, has, planAccess } from './authz.js';
import { surveyKpis } from './surveys.js';
import { knowledgeKpi } from './closeout.js';

export const ENGAGEMENT_STATUS = ['running', 'completed', 'on_hold'];
export const PROPOSAL_OUTCOMES = ['drafting', 'submitted', 'won', 'lost', 'withdrawn', 'no_go'];
const canEdit = (actor) => isOps(actor) || has(actor, 'partner');
const str = (v, max = 4000) => (v == null || v === '' ? null : String(v).trim().slice(0, max) || null);
const year = (v) => { if (v == null || v === '') return null; const n = Number(v); if (!Number.isInteger(n) || n < 2000 || n > 2100) throw bad('Year must be like 2025'); return n; };
const date = (v) => { if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('Dates are YYYY-MM-DD'); return v; };
const url = (v) => { const s = str(v, 1000); if (s && !/^https:\/\/(drive|docs)\.google\.com\//.test(s)) throw bad('Drive links must start with https://drive.google.com/ or https://docs.google.com/'); return s; };
const keyOf = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80);

const TEAM_STATUSES = new Set(['confirmed', 'historical', 'tentative', 'provisional']);
function teamFor(db, e) {
  const names = new Map();
  for (const n of String(e.team_names || '').split(/[;,/]\s*|\s+\/\s+/).map((x) => x.trim()).filter(Boolean)) names.set(n.toLowerCase(), { name: n, confirmed: true, from: 'record' });
  if (e.project_id) {
    for (const a of db.prepare(`SELECT u.name, a.status FROM project_assignments a JOIN users u ON u.id = a.user_id WHERE a.project_id = ? ORDER BY u.name`).all(e.project_id)) {
      if (!TEAM_STATUSES.has(a.status)) continue;
      const k = a.name.toLowerCase(); const prev = names.get(k);
      const confirmed = a.status === 'confirmed' || a.status === 'historical';
      if (!prev || (!prev.confirmed && confirmed)) names.set(k, { name: a.name, confirmed, from: 'register' });
    }
  }
  return [...names.values()];
}

/** Everything the library page needs, for any active colleague. */
export function libraryView(db, actor) {
  const clients = db.prepare('SELECT * FROM clients WHERE tenant_id = ? ORDER BY name_en').all(actor.tenantId);
  const byId = new Map(clients.map((c) => [c.id, c]));
  const engagements = db.prepare(`SELECT e.*, p.name AS project_name, lu.name AS project_lead FROM engagements e
      LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN users lu ON lu.id = p.lead_user_id
      WHERE e.tenant_id = ? ORDER BY COALESCE(e.year_to, e.year_from, 0) DESC, e.title_en`).all(actor.tenantId)
    .map((e) => ({ ...e, lead_name: e.lead_name || e.project_lead || null, team: teamFor(db, e), client: pickClient(byId.get(e.client_id)) }));
  const proposals = db.prepare('SELECT * FROM proposals WHERE tenant_id = ? ORDER BY COALESCE(submitted_on, \'\') DESC, title_en').all(actor.tenantId)
    .map((p) => ({ ...p, client: pickClient(byId.get(p.client_id)) }));
  for (const c of clients) {
    const es = engagements.filter((e) => e.client_id === c.id);
    const yrs = es.flatMap((e) => [e.year_from, e.year_to]).filter(Boolean);
    Object.assign(c, { engagements: es.length, running: es.some((e) => e.status === 'running'), first_year: yrs.length ? Math.min(...yrs) : null, last_year: yrs.length ? Math.max(...yrs) : null,
      proposals: proposals.filter((p) => p.client_id === c.id).length, people: [...new Set(es.flatMap((e) => e.team.map((t) => t.name)))].sort() });
  }
  return { clients, engagements, proposals, stats: stats(engagements, proposals), canEdit: canEdit(actor), outcomes: PROPOSAL_OUTCOMES, statuses: ENGAGEMENT_STATUS };
}
const pickClient = (c) => (c ? { id: c.id, name_en: c.name_en, name_ar: c.name_ar, short: c.short, sector: c.sector, country: c.country } : null);

export function stats(engagements, proposals, fromYear = null) {
  const ps = proposals.filter((p) => !fromYear || (p.submitted_on || '') >= `${fromYear}-01-01`);
  const won = ps.filter((p) => p.outcome === 'won').length; const lost = ps.filter((p) => p.outcome === 'lost').length;
  return { clients_served: new Set(engagements.map((e) => e.client_id)).size, engagements: engagements.length,
    running: engagements.filter((e) => e.status === 'running').length, completed: engagements.filter((e) => e.status === 'completed').length,
    on_hold: engagements.filter((e) => e.status === 'on_hold').length,
    proposals: ps.length, won, lost, open: ps.filter((p) => ['drafting', 'submitted'].includes(p.outcome)).length,
    hit_rate: won + lost ? Math.round((won / (won + lost)) * 100) : null };
}

const ENG_FIELDS = { title_en: str, title_ar: str, domain: str, service_line: str, scope_en: str, scope_ar: str, year_from: year, year_to: year, lead_name: str, team_names: str, subcontractor: str, drive_url: url };
export function saveEngagement(db, actor, id, patch = {}) {
  if (!canEdit(actor)) throw forbid();
  return tx(db, () => {
    let row = id ? db.prepare('SELECT * FROM engagements WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId) : null;
    if (id && !row) throw notFound();
    const set = {};
    for (const [k, f] of Object.entries(ENG_FIELDS)) if (k in patch) set[k] = f(patch[k]);
    if ('status' in patch) { if (!ENGAGEMENT_STATUS.includes(patch.status)) throw bad('Status is running, completed or on hold'); set.status = patch.status; }
    if ('projectId' in patch) {
      if (patch.projectId && !db.prepare('SELECT 1 FROM projects WHERE id = ? AND tenant_id = ?').get(patch.projectId, actor.tenantId)) throw bad('Unknown project');
      set.project_id = patch.projectId || null;
    }
    if (!row) {
      const client = clientFor(db, actor, patch);
      if (!set.title_en) throw bad('Give the engagement a title');
      const newId = uid('eng_');
      db.prepare('INSERT INTO engagements (id, tenant_id, client_id, key, title_en, status, source, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(newId, actor.tenantId, client.id, `app-${newId}`, set.title_en, set.status || 'running', 'Added in the portal', actor.id, now());
      row = db.prepare('SELECT * FROM engagements WHERE id = ?').get(newId);
    }
    const keys = Object.keys(set);
    if (keys.length) db.prepare(`UPDATE engagements SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`).run(...keys.map((k) => set[k]), actor.id, now(), row.id);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: id ? 'library.engagement.update' : 'library.engagement.create', entity: 'engagement', entityId: row.id, after: set });
    return { id: row.id };
  });
}

export function clientFor(db, actor, patch) {
  if (patch.clientId) { const c = db.prepare('SELECT * FROM clients WHERE id = ? AND tenant_id = ?').get(patch.clientId, actor.tenantId); if (!c) throw bad('Unknown client'); return c; }
  const name = str(patch.clientName, 200); if (!name) throw bad('Choose a client or type a new client name');
  const key = keyOf(name);
  const ex = db.prepare('SELECT * FROM clients WHERE tenant_id = ? AND (key = ? OR lower(name_en) = lower(?) OR lower(short) = lower(?))').get(actor.tenantId, key, name, name);
  if (ex) return ex;
  const id = uid('cli_');
  db.prepare('INSERT INTO clients (id, tenant_id, key, name_en, name_ar, sector, country, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, actor.tenantId, key, name, str(patch.clientNameAr, 200), str(patch.sector, 80), str(patch.country, 60), now());
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'library.client.create', entity: 'client', entityId: id, after: { name } });
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}

export function saveClient(db, actor, id, patch = {}) {
  if (!canEdit(actor)) throw forbid();
  const row = db.prepare('SELECT * FROM clients WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!row) throw notFound();
  const F = { name_en: (v) => str(v, 200), name_ar: (v) => str(v, 200), short: (v) => str(v, 40), sector: (v) => str(v, 80), country: (v) => str(v, 60), drive_url: url, notes: str };
  const set = {}; for (const [k, f] of Object.entries(F)) if (k in patch) set[k] = f(patch[k]);
  if ('name_en' in set && !set.name_en) throw bad('Client name required');
  const keys = Object.keys(set); if (!keys.length) return { id };
  db.prepare(`UPDATE clients SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => set[k]), now(), id);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'library.client.update', entity: 'client', entityId: id, after: set });
  return { id };
}

const PROP_FIELDS = { title_en: str, title_ar: str, domain: str, submitted_on: date, decided_on: date, outcome_note: (v) => str(v, 1000), owner_name: (v) => str(v, 120), drive_url: url };
export function saveProposal(db, actor, id, patch = {}) {
  if (!canEdit(actor)) throw forbid();
  return tx(db, () => {
    let row = id ? db.prepare('SELECT * FROM proposals WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId) : null;
    if (id && !row) throw notFound();
    const set = {}; for (const [k, f] of Object.entries(PROP_FIELDS)) if (k in patch) set[k] = f(patch[k]);
    if ('outcome' in patch) {
      if (!PROPOSAL_OUTCOMES.includes(patch.outcome)) throw bad('Unknown outcome');
      set.outcome = patch.outcome;
      set.stage = null; // the pipeline stage follows the outcome chosen here
      if (['won', 'lost', 'withdrawn', 'no_go'].includes(patch.outcome) && !('decided_on' in patch) && !row?.decided_on) set.decided_on = new Date().toISOString().slice(0, 10);
    }
    if ('engagementId' in patch) {
      if (patch.engagementId && !db.prepare('SELECT 1 FROM engagements WHERE id = ? AND tenant_id = ?').get(patch.engagementId, actor.tenantId)) throw bad('Unknown engagement');
      set.engagement_id = patch.engagementId || null;
    }
    if (!row) {
      const client = clientFor(db, actor, patch);
      if (!set.title_en) throw bad('Give the proposal a title');
      const newId = uid('prop_');
      db.prepare('INSERT INTO proposals (id, tenant_id, client_id, key, title_en, outcome, source, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(newId, actor.tenantId, client.id, `app-${newId}`, set.title_en, set.outcome || 'drafting', 'Added in the portal', actor.id, now());
      row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(newId);
    }
    const keys = Object.keys(set);
    if (keys.length) db.prepare(`UPDATE proposals SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`).run(...keys.map((k) => set[k]), actor.id, now(), row.id);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: id ? 'library.proposal.update' : 'library.proposal.create', entity: 'proposal', entityId: row.id, before: id ? { outcome: row.outcome } : null, after: set });
    return { id: row.id };
  });
}

// ------------------------------------------------------------------ strategy --
/** GB strategy objectives and KPIs, with how many current plan items point at each KPI. */
export function strategyView(db, actor) {
  const objectives = db.prepare('SELECT * FROM strategy_objectives WHERE tenant_id = ? ORDER BY position, code').all(actor.tenantId);
  const cycle = db.prepare("SELECT id, year FROM cycles WHERE tenant_id = ? AND status != 'historical' ORDER BY (status = 'open') DESC, year DESC LIMIT 1").get(actor.tenantId);
  const seeNames = canEdit(actor);
  const kpis = db.prepare('SELECT * FROM strategy_kpis WHERE tenant_id = ? ORDER BY position, code').all(actor.tenantId).map((k) => {
    const links = cycle ? db.prepare(`SELECT u.id user_id, u.name, i.title FROM plan_item_kpi_links l JOIN plan_items i ON i.id = l.plan_item_id
        JOIN plans p ON p.id = i.plan_id JOIN users u ON u.id = p.user_id WHERE l.kpi_id = ? AND p.cycle_id = ? ORDER BY u.name`).all(k.id, cycle.id) : [];
    return { ...k, objectives: k.objective_codes.split(',').map((s) => s.trim()).filter(Boolean), linked_items: links.length,
      linked_people: new Set(links.map((l) => l.user_id)).size, links: seeNames ? links.map(({ name, title }) => ({ name, title })) : undefined };
  });
  const lib = { e: db.prepare('SELECT status, client_id FROM engagements WHERE tenant_id = ?').all(actor.tenantId), p: db.prepare('SELECT outcome, submitted_on FROM proposals WHERE tenant_id = ?').all(actor.tenantId) };
  const year = cycle?.year || new Date().getFullYear();
  const s = stats(lib.e, lib.p, year);
  // measured live from the library where the data is here; the rest are tracked outside the portal
  const live = { 'proposal hit rate': s.hit_rate == null ? null : { value: `${s.hit_rate}%`, note: `${s.won} won · ${s.lost} lost since January ${year}; ${s.open} still open` } };
  // measured from surveys, timesheets, close-outs and (partners only) billing
  const sv = surveyKpis(db, actor.tenantId); const kb = knowledgeKpi(db, actor.tenantId);
  if (sv.quality) live['quality index on projects delivered'] = { value: `${sv.quality.avg} / 5`, note: `Deliverable quality in ${sv.quality.n} client survey(s), last 12 months` };
  if (sv.nps || sv.overall) live['customer experience index'] = { value: sv.nps ? `NPS ${sv.nps.nps}` : `${sv.overall.avg} / 5`, note: `${sv.client_responses} client survey(s), last 12 months${sv.overall ? `; satisfaction ${sv.overall.avg} / 5` : ''}` };
  if (sv.pulse?.enps) live['employee experience index'] = { value: `eNPS ${sv.pulse.enps.nps}`, note: `${sv.pulse.title}, ${sv.pulse.n} anonymous answers` };
  if (kb.done) live['% completion of knowledge base'] = { value: `${kb.pct}%`, note: `${kb.with_closeout} of ${kb.done} completed engagements since 2025 have a close-out; ${kb.assets} reusable assets` };
  const months = [1, 2, 3].map((n) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 7); });
  const ut = db.prepare(`SELECT COALESCE(SUM(CASE WHEN code LIKE 'p:%' THEN hours_x100 END), 0) p, COALESCE(SUM(hours_x100), 0) t FROM timesheet_entries WHERE tenant_id = ? AND month IN (${months.map(() => '?').join(',')})`).get(actor.tenantId, ...months);
  if (ut.t) live['employee utilisation'] = { value: `${Math.round((ut.p / ut.t) * 100)}%`, note: `Project hours ÷ all logged hours, ${months.at(-1)} to ${months[0]}` };
  if (has(actor, 'partner')) {
    const inv = db.prepare("SELECT COALESCE(SUM(amount_x100), 0) s, COUNT(DISTINCT project_id) n FROM project_milestones WHERE tenant_id = ? AND status IN ('invoiced','paid') AND invoiced_on LIKE ?").get(actor.tenantId, `${year}-%`);
    const clients = db.prepare("SELECT COUNT(DISTINCT e.client_id) n FROM project_milestones m JOIN engagements e ON e.project_id = m.project_id WHERE m.tenant_id = ? AND m.status IN ('invoiced','paid') AND m.invoiced_on LIKE ?").get(actor.tenantId, `${year}-%`).n;
    const fmt = (x) => `${Math.round(x / 100).toLocaleString('en-GB')} JOD`;
    if (inv.s) {
      live['total revenues and net profit'] = { value: fmt(inv.s), note: `Invoiced in ${year} (commercial control); net profit needs costs outside the portal` };
      if (clients) live['revenue per client'] = { value: fmt(inv.s / clients), note: `Invoiced in ${year} ÷ ${clients} client(s) billed` };
    }
  }
  for (const k of kpis) k.live = live[k.name_en.trim().toLowerCase()] || null;
  return { cycle_year: cycle?.year || null, objectives, kpis, canSeeNames: seeNames };
}

function itemAndAccess(db, actor, itemId) {
  const item = db.prepare('SELECT i.id, i.plan_id, p.* FROM plan_items i JOIN plans p ON p.id = i.plan_id WHERE i.id = ?').get(itemId);
  if (!item || item.tenant_id !== actor.tenantId) throw notFound();
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(item.plan_id);
  const caps = planAccess(db, actor, plan);
  const allowed = isOps(actor) || (caps && ['self', 'reviewer', 'category_reviewer', 'partner'].includes(caps.relation));
  if (!allowed) throw forbid();
  if (plan.state === 'closed') throw bad('This review is closed');
  return plan;
}

/** Replace the set of strategic KPIs one plan item supports. */
export function linkPlanItem(db, actor, itemId, kpiIds = []) {
  itemAndAccess(db, actor, itemId);
  const ids = [...new Set(kpiIds)];
  if (ids.length > 3) throw bad('Link an objective to at most three strategic KPIs');
  for (const k of ids) if (!db.prepare('SELECT 1 FROM strategy_kpis WHERE id = ? AND tenant_id = ?').get(k, actor.tenantId)) throw bad('Unknown strategic KPI');
  tx(db, () => {
    db.prepare('DELETE FROM plan_item_kpi_links WHERE plan_item_id = ?').run(itemId);
    for (const k of ids) db.prepare('INSERT INTO plan_item_kpi_links (plan_item_id, kpi_id, tenant_id, linked_by, linked_at) VALUES (?,?,?,?,?)').run(itemId, k, actor.tenantId, actor.id, now());
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'plan_item.strategy_links', entity: 'plan_item', entityId: itemId, after: { kpis: ids } });
  });
  return { ok: true, kpis: ids };
}

/** item id → [{ id, code, name_en }] for a plan's items. */
export function planItemLinks(db, planId) {
  const out = {};
  for (const r of db.prepare(`SELECT l.plan_item_id, k.id, k.code, k.name_en FROM plan_item_kpi_links l JOIN strategy_kpis k ON k.id = l.kpi_id
      JOIN plan_items i ON i.id = l.plan_item_id WHERE i.plan_id = ? ORDER BY k.position`).all(planId)) (out[r.plan_item_id] ||= []).push({ id: r.id, code: r.code, name_en: r.name_en });
  return out;
}

// -------------------------------------------------------------------- import --
/**
 * Load the library and the strategy from a private file (config/private/real/library.json):
 * { clients: [{ key, name_en, name_ar, short, sector, country, drive_url }],
 *   engagements: [{ key, client, title_en, title_ar, domain, service_line, scope_en, scope_ar, year_from, year_to, status, lead, team, subcontractor, drive_url, project }],
 *   proposals: [{ key, client, title_en, title_ar, domain, submitted_on, outcome, decided_on, outcome_note, owner, drive_url, engagement }],
 *   strategy: { objectives: [{ code, theme, title_en, title_ar }], kpis: [{ code, name_en, name_ar, objectives: ['1.1'] }] } }
 * Re-runnable. Rows edited in the portal (updated_by set) are not overwritten.
 */
export function applyLibrary(db, actor, file) {
  const rep = { clients: 0, engagements: 0, proposals: 0, kept: 0, objectives: 0, kpis: 0, problems: [] };
  const T = actor.tenantId;
  tx(db, () => {
    const cid = new Map();
    for (const c of file.clients || []) {
      if (!c.key || !c.name_en) { rep.problems.push(`client without key/name: ${JSON.stringify(c).slice(0, 80)}`); continue; }
      const ex = db.prepare('SELECT id FROM clients WHERE tenant_id = ? AND key = ?').get(T, c.key);
      const vals = [c.name_en, c.name_ar || null, c.short || null, c.sector || null, c.country || null, c.drive_url || null];
      if (ex) db.prepare('UPDATE clients SET name_en = ?, name_ar = COALESCE(?, name_ar), short = COALESCE(?, short), sector = COALESCE(?, sector), country = COALESCE(?, country), drive_url = COALESCE(?, drive_url), updated_at = ? WHERE id = ?').run(...vals, now(), ex.id);
      else db.prepare('INSERT INTO clients (id, tenant_id, key, name_en, name_ar, short, sector, country, drive_url, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(uid('cli_'), T, c.key, ...vals, now());
      cid.set(c.key, (ex || db.prepare('SELECT id FROM clients WHERE tenant_id = ? AND key = ?').get(T, c.key)).id); rep.clients++;
    }
    const clientId = (k) => cid.get(k) || db.prepare('SELECT id FROM clients WHERE tenant_id = ? AND key = ?').get(T, k)?.id;
    const projectId = (name) => (name ? db.prepare('SELECT id FROM projects WHERE tenant_id = ? AND lower(name) = lower(?)').get(T, name)?.id || null : null);
    for (const e of file.engagements || []) {
      const c = clientId(e.client); if (!c) { rep.problems.push(`engagement ${e.key}: unknown client ${e.client}`); continue; }
      if (!ENGAGEMENT_STATUS.includes(e.status || 'completed')) { rep.problems.push(`engagement ${e.key}: bad status ${e.status}`); continue; }
      const ex = db.prepare('SELECT id, updated_by FROM engagements WHERE tenant_id = ? AND key = ?').get(T, e.key);
      if (ex?.updated_by) { rep.kept++; continue; }
      const pid = projectId(e.project); if (e.project && !pid) rep.problems.push(`engagement ${e.key}: register project “${e.project}” not found (team from the record only)`);
      const vals = [c, e.title_en, e.title_ar || null, e.domain || null, e.service_line || null, e.scope_en || null, e.scope_ar || null, e.year_from || null, e.year_to || null,
        e.status || 'completed', e.lead || null, (e.team || []).join('; ') || null, e.subcontractor || null, e.drive_url || null, pid, e.source || file.source || null];
      if (ex) db.prepare(`UPDATE engagements SET client_id = ?, title_en = ?, title_ar = ?, domain = ?, service_line = ?, scope_en = ?, scope_ar = ?, year_from = ?, year_to = ?, status = ?,
          lead_name = ?, team_names = ?, subcontractor = ?, drive_url = ?, project_id = ?, source = ?, updated_at = ? WHERE id = ?`).run(...vals, now(), ex.id);
      else db.prepare(`INSERT INTO engagements (client_id, title_en, title_ar, domain, service_line, scope_en, scope_ar, year_from, year_to, status, lead_name, team_names, subcontractor, drive_url, project_id, source, updated_at, id, tenant_id, key)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...vals, now(), uid('eng_'), T, e.key);
      rep.engagements++;
    }
    for (const p of file.proposals || []) {
      const c = clientId(p.client); if (!c) { rep.problems.push(`proposal ${p.key}: unknown client ${p.client}`); continue; }
      if (!PROPOSAL_OUTCOMES.includes(p.outcome || 'submitted')) { rep.problems.push(`proposal ${p.key}: bad outcome ${p.outcome}`); continue; }
      const ex = db.prepare('SELECT id, updated_by FROM proposals WHERE tenant_id = ? AND key = ?').get(T, p.key);
      if (ex?.updated_by) { rep.kept++; continue; }
      const eng = p.engagement ? db.prepare('SELECT id FROM engagements WHERE tenant_id = ? AND key = ?').get(T, p.engagement)?.id || null : null;
      const vals = [c, p.title_en, p.title_ar || null, p.domain || null, p.submitted_on || null, p.outcome || 'submitted', p.decided_on || null, p.outcome_note || null, p.owner || null, p.drive_url || null, eng, p.source || file.source || null];
      if (ex) db.prepare(`UPDATE proposals SET client_id = ?, title_en = ?, title_ar = ?, domain = ?, submitted_on = ?, outcome = ?, decided_on = ?, outcome_note = ?, owner_name = ?, drive_url = ?, engagement_id = ?, source = ?, updated_at = ? WHERE id = ?`).run(...vals, now(), ex.id);
      else db.prepare(`INSERT INTO proposals (client_id, title_en, title_ar, domain, submitted_on, outcome, decided_on, outcome_note, owner_name, drive_url, engagement_id, source, updated_at, id, tenant_id, key)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...vals, now(), uid('prop_'), T, p.key);
      rep.proposals++;
    }
    const s = file.strategy || {};
    (s.objectives || []).forEach((o, i) => {
      db.prepare(`INSERT INTO strategy_objectives (id, tenant_id, code, theme, title_en, title_ar, position) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(tenant_id, code) DO UPDATE SET theme = excluded.theme, title_en = excluded.title_en, title_ar = excluded.title_ar, position = excluded.position`)
        .run(uid('sobj_'), T, o.code, o.theme, o.title_en, o.title_ar || null, i); rep.objectives++;
    });
    (s.kpis || []).forEach((k, i) => {
      db.prepare(`INSERT INTO strategy_kpis (id, tenant_id, code, name_en, name_ar, objective_codes, position) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(tenant_id, code) DO UPDATE SET name_en = excluded.name_en, name_ar = excluded.name_ar, objective_codes = excluded.objective_codes, position = excluded.position`)
        .run(uid('skpi_'), T, k.code, k.name_en, k.name_ar || null, (k.objectives || []).join(','), i); rep.kpis++;
    });
    audit(db, { tenantId: T, actorId: actor.id, action: 'library.import', entity: 'library', entityId: null, after: { clients: rep.clients, engagements: rep.engagements, proposals: rep.proposals, kpis: rep.kpis } });
  });
  return rep;
}
