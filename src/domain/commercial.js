// Commercial control (partners only): per-project fee and hour budget, actual hours from timesheets,
// burn alerts, forecast at completion, margin, billing milestones and what clients owe.
// Cost uses a standard hourly cost per job level that partners set — never an individual's salary.
// Project leads see their own projects' hours burn, never fees, costs or margins.
import { tx, uid, now, audit, bad, forbid, notFound } from '../db.js';
import { has } from './authz.js';
import { toX100 } from './decimal.js';

export const BURN_ALERTS = [75, 90, 100];
const partner = (a) => has(a, 'partner');
const must = (a) => { if (!partner(a)) throw forbid('Commercial figures are for partners only'); };
const money = (v, label) => { let n; try { n = toX100(v); } catch (e) { throw bad(e.message); } if (n == null || n < 0) throw bad(`${label}: enter an amount`); return n; };
const today = () => new Date().toISOString().slice(0, 10);

export function costRates(db, actor) {
  must(actor);
  const levels = db.prepare("SELECT DISTINCT e.title FROM employments e JOIN users u ON u.id = e.user_id WHERE u.tenant_id = ? AND u.active = 1 AND e.effective_to IS NULL AND e.title IS NOT NULL ORDER BY e.title").all(actor.tenantId).map((r) => r.title);
  const set = new Map(db.prepare('SELECT * FROM cost_rates WHERE tenant_id = ?').all(actor.tenantId).map((r) => [r.level, r]));
  return [...new Set([...levels, ...set.keys()])].map((level) => ({ level, hourly_x100: set.get(level)?.hourly_x100 ?? null, target_pct: set.get(level)?.target_pct ?? null }));
}
export function saveCostRates(db, actor, rows = []) {
  must(actor);
  tx(db, () => {
    for (const r of rows) {
      const level = String(r.level || '').trim().slice(0, 80); if (!level) continue;
      const hourly = r.hourly === '' || r.hourly == null ? null : money(r.hourly, level);
      const target = r.target_pct === '' || r.target_pct == null ? null : Math.max(0, Math.min(100, Math.round(Number(r.target_pct))));
      if (hourly == null && target == null) { db.prepare('DELETE FROM cost_rates WHERE tenant_id = ? AND level = ?').run(actor.tenantId, level); continue; }
      db.prepare(`INSERT INTO cost_rates (tenant_id, level, hourly_x100, target_pct, updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(tenant_id, level) DO UPDATE SET hourly_x100 = excluded.hourly_x100, target_pct = excluded.target_pct, updated_at = excluded.updated_at`).run(actor.tenantId, level, hourly ?? 0, target, now());
    }
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'commercial.cost_rates', entity: 'cost_rates', entityId: null, after: { levels: rows.length } });
  });
  return { ok: true };
}

/** Actual hours per person on a project (all timesheet months), with each person's level. */
function actuals(db, projectId) {
  return db.prepare(`SELECT u.id, u.name, e.title level, SUM(t.hours_x100) hours_x100,
      SUM(CASE WHEN m.status = 'approved' THEN t.hours_x100 ELSE 0 END) approved_x100
    FROM timesheet_entries t JOIN users u ON u.id = t.user_id
    LEFT JOIN employments e ON e.user_id = u.id AND e.effective_to IS NULL
    LEFT JOIN timesheet_months m ON m.user_id = t.user_id AND m.month = t.month
    WHERE t.project_id = ? GROUP BY u.id ORDER BY hours_x100 DESC`).all(projectId);
}

function elapsedShare(p, on = today()) {
  if (!p.start_date || !p.end_date || p.end_date <= p.start_date) return null;
  const s = Date.parse(p.start_date); const e = Date.parse(p.end_date); const t = Date.parse(on);
  return Math.max(0, Math.min(1, (t - s) / (e - s)));
}

/** Full commercial picture for one project. */
export function projectFinance(db, actor, projectId, { forLead = false } = {}) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND tenant_id = ?').get(projectId, actor.tenantId); if (!p) throw notFound();
  const isLead = p.lead_user_id === actor.id;
  if (!partner(actor) && !(forLead && isLead)) throw forbid();
  const b = db.prepare('SELECT * FROM project_budgets WHERE project_id = ?').get(projectId);
  const people = actuals(db, projectId);
  const rates = new Map(db.prepare('SELECT level, hourly_x100 FROM cost_rates WHERE tenant_id = ?').all(actor.tenantId).map((r) => [r.level, r.hourly_x100]));
  const hours = people.reduce((s, x) => s + x.hours_x100, 0);
  const budgetH = b?.budget_hours_x100 || 0;
  const burn = budgetH ? Math.round((hours / budgetH) * 100) : null;
  const share = elapsedShare(p);
  const forecastH = share && share > 0.1 ? Math.round(hours / share) : budgetH || hours;
  const hoursView = { project: { id: p.id, name: p.name, start_date: p.start_date, end_date: p.end_date, status: p.status }, budget_hours_x100: budgetH, actual_hours_x100: hours,
    burn_pct: burn, time_elapsed_pct: share == null ? null : Math.round(share * 100), forecast_hours_x100: forecastH,
    alert: burn == null ? null : burn >= 100 ? 'over' : burn >= 90 ? 'critical' : burn >= 75 ? 'warning' : share != null && burn > Math.round(share * 100) + 15 ? 'ahead_of_time' : null,
    people: people.map((x) => ({ name: x.name, level: x.level, hours_x100: x.hours_x100, approved_x100: x.approved_x100 })) };
  if (!partner(actor)) return hoursView; // leads: hours only
  const missingRates = [...new Set(people.filter((x) => !rates.has(x.level)).map((x) => x.level || 'No level'))];
  const cost = people.reduce((s, x) => s + Math.round((x.hours_x100 * (rates.get(x.level) || 0)) / 100), 0);
  const avgRate = hours ? cost / hours : 0;
  const fee = b ? (b.billing === 'time_materials' ? Math.round((hours * (b.rate_x100 || 0)) / 100) : b.fee_x100) : 0;
  const forecastCost = Math.round(forecastH * avgRate);
  const forecastFee = b?.billing === 'time_materials' ? Math.round((forecastH * (b.rate_x100 || 0)) / 100) : fee;
  const ms = db.prepare('SELECT * FROM project_milestones WHERE project_id = ? ORDER BY position, due_on').all(projectId).map((m) => ({ ...m, overdue: m.status === 'invoiced' && m.due_on && m.due_on < today() }));
  const sum = (st) => ms.filter((m) => st.includes(m.status)).reduce((s, m) => s + m.amount_x100, 0);
  return { ...hoursView, budget: b || null, fee_x100: fee, cost_x100: cost, margin_x100: fee - cost, margin_pct: fee ? Math.round(((fee - cost) / fee) * 100) : null,
    forecast_fee_x100: forecastFee, forecast_cost_x100: forecastCost, forecast_margin_x100: forecastFee - forecastCost, forecast_margin_pct: forecastFee ? Math.round(((forecastFee - forecastCost) / forecastFee) * 100) : null,
    milestones: ms, invoiced_x100: sum(['invoiced', 'paid']), paid_x100: sum(['paid']), outstanding_x100: sum(['invoiced']), overdue_x100: ms.filter((m) => m.overdue).reduce((s, m) => s + m.amount_x100, 0),
    unbilled_x100: Math.max(0, fee - sum(['invoiced', 'paid'])), missing_rates: missingRates };
}

export function saveBudget(db, actor, projectId, b = {}) {
  must(actor);
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ? AND tenant_id = ?').get(projectId, actor.tenantId)) throw notFound();
  const billing = b.billing === 'time_materials' ? 'time_materials' : 'fixed';
  const fee = billing === 'fixed' ? money(b.fee ?? 0, 'Fee') : 0;
  const rate = billing === 'time_materials' ? money(b.rate ?? 0, 'Billing rate') : null;
  const hours = money(b.budget_hours ?? 0, 'Budget hours');
  const cur = /^[A-Z]{3}$/.test(b.currency || '') ? b.currency : 'JOD';
  db.prepare(`INSERT INTO project_budgets (project_id, tenant_id, billing, currency, fee_x100, budget_hours_x100, rate_x100, notes, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET billing = excluded.billing, currency = excluded.currency, fee_x100 = excluded.fee_x100, budget_hours_x100 = excluded.budget_hours_x100,
      rate_x100 = excluded.rate_x100, notes = excluded.notes, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(projectId, actor.tenantId, billing, cur, fee, hours, rate, String(b.notes || '').slice(0, 500) || null, actor.id, now());
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'commercial.budget', entity: 'project', entityId: projectId, after: { billing } });
  return { ok: true };
}

export function saveMilestone(db, actor, projectId, id, m = {}) {
  must(actor);
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ? AND tenant_id = ?').get(projectId, actor.tenantId)) throw notFound();
  const title = String(m.title || '').trim().slice(0, 120); if (!title) throw bad('Name the milestone, e.g. “Inception report – 30%”');
  const amount = money(m.amount, 'Amount');
  const status = ['planned', 'invoiced', 'paid', 'cancelled'].includes(m.status) ? m.status : 'planned';
  const d = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const vals = [title, d(m.due_on), amount, status, String(m.invoice_no || '').slice(0, 40) || null, d(m.invoiced_on) || (status !== 'planned' && status !== 'cancelled' ? today() : null), d(m.paid_on) || (status === 'paid' ? today() : null), now()];
  if (id) { const r = db.prepare('UPDATE project_milestones SET title = ?, due_on = ?, amount_x100 = ?, status = ?, invoice_no = ?, invoiced_on = ?, paid_on = ?, updated_at = ? WHERE id = ? AND project_id = ?').run(...vals, id, projectId); if (!r.changes) throw notFound(); }
  else { id = uid('ms_'); const pos = db.prepare('SELECT COUNT(*) n FROM project_milestones WHERE project_id = ?').get(projectId).n; db.prepare('INSERT INTO project_milestones (title, due_on, amount_x100, status, invoice_no, invoiced_on, paid_on, updated_at, id, tenant_id, project_id, position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals, id, actor.tenantId, projectId, pos); }
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'commercial.milestone', entity: 'project', entityId: projectId, after: { status } });
  return { id };
}
export function deleteMilestone(db, actor, projectId, id) {
  must(actor);
  const r = db.prepare('DELETE FROM project_milestones WHERE id = ? AND project_id = ? AND tenant_id = ?').run(id, projectId, actor.tenantId); if (!r.changes) throw notFound();
  return { ok: true };
}

/** Portfolio: every engagement with a budget or hours, totals, revenue per client, receivables and cash-in forecast. */
export function portfolio(db, actor, { year } = {}) {
  must(actor);
  const y = /^\d{4}$/.test(String(year || '')) ? String(year) : today().slice(0, 4);
  const ids = db.prepare(`SELECT DISTINCT p.id FROM projects p LEFT JOIN project_budgets b ON b.project_id = p.id
      WHERE p.tenant_id = ? AND p.kind = 'engagement' AND (b.project_id IS NOT NULL OR (p.status = 'active' AND p.register_status != 'archived'))`).all(actor.tenantId).map((r) => r.id);
  const rows = ids.map((id) => {
    const f = projectFinance(db, actor, id);
    const c = db.prepare('SELECT c.id, c.name_en FROM engagements e JOIN clients c ON c.id = e.client_id WHERE e.project_id = ? LIMIT 1').get(id);
    return { ...f, client: c || null };
  });
  const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const byClient = new Map();
  for (const r of rows) { const k = r.client?.name_en || r.project.name; const v = byClient.get(k) || { client: k, fee_x100: 0, invoiced_x100: 0, projects: 0 }; v.fee_x100 += r.fee_x100; v.invoiced_x100 += r.invoiced_x100; v.projects++; byClient.set(k, v); }
  const ms = db.prepare(`SELECT m.*, p.name project FROM project_milestones m JOIN projects p ON p.id = m.project_id WHERE m.tenant_id = ? AND m.status IN ('planned','invoiced') ORDER BY m.due_on`).all(actor.tenantId);
  const in90 = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
  const paidThisYear = db.prepare("SELECT COALESCE(SUM(amount_x100), 0) s FROM project_milestones WHERE tenant_id = ? AND status = 'paid' AND paid_on LIKE ?").get(actor.tenantId, `${y}-%`).s;
  const invoicedThisYear = db.prepare("SELECT COALESCE(SUM(amount_x100), 0) s FROM project_milestones WHERE tenant_id = ? AND status IN ('invoiced','paid') AND invoiced_on LIKE ?").get(actor.tenantId, `${y}-%`).s;
  return { year: y, projects: rows.sort((a, b) => (b.burn_pct ?? -1) - (a.burn_pct ?? -1)),
    totals: { fee_x100: sum('fee_x100'), cost_x100: sum('cost_x100'), margin_x100: sum('fee_x100') - sum('cost_x100'), invoiced_x100: sum('invoiced_x100'), paid_x100: sum('paid_x100'),
      outstanding_x100: sum('outstanding_x100'), overdue_x100: sum('overdue_x100'), unbilled_x100: sum('unbilled_x100'), invoiced_this_year_x100: invoicedThisYear, paid_this_year_x100: paidThisYear },
    by_client: [...byClient.values()].sort((a, b) => b.fee_x100 - a.fee_x100),
    cash_in_90: ms.filter((m) => m.due_on && m.due_on <= in90), overdue: ms.filter((m) => m.status === 'invoiced' && m.due_on && m.due_on < today()),
    at_risk: rows.filter((r) => (r.burn_pct ?? 0) >= 90 || (r.forecast_margin_pct != null && r.forecast_margin_pct < 0) || r.overdue_x100 > 0).map((r) => r.project.name),
    missing_budgets: rows.filter((r) => !r.budget).map((r) => r.project.name), rates_missing: [...new Set(rows.flatMap((r) => r.missing_rates))] };
}

/** Called on a timer: email partners (and the lead, hours only) when a project crosses 75 / 90 / 100 % of its hours. */
export function checkBurnAlerts(db, tenantId, notify) {
  const partners = db.prepare("SELECT DISTINCT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'partner' WHERE u.tenant_id = ? AND u.active = 1").all(tenantId).map((r) => r.id);
  for (const b of db.prepare('SELECT b.*, p.name, p.lead_user_id FROM project_budgets b JOIN projects p ON p.id = b.project_id WHERE b.tenant_id = ? AND b.budget_hours_x100 > 0').all(tenantId)) {
    const hours = db.prepare('SELECT COALESCE(SUM(hours_x100), 0) s FROM timesheet_entries WHERE project_id = ?').get(b.project_id).s;
    const pct = Math.round((hours / b.budget_hours_x100) * 100);
    const crossed = BURN_ALERTS.filter((t) => pct >= t).at(-1) || 0;
    if (crossed > b.last_alert) {
      db.prepare('UPDATE project_budgets SET last_alert = ? WHERE project_id = ?').run(crossed, b.project_id);
      const msg = { tenantId, event: 'burn', key: `${b.project_id}:${crossed}`, subject: `${b.name}: ${pct}% of budgeted hours used`, text: `${b.name} has used ${pct}% of its budgeted hours (${(hours / 100).toFixed(0)} of ${(b.budget_hours_x100 / 100).toFixed(0)} h).` };
      notify(db, { ...msg, to: partners, link: `#/commercial?p=${b.project_id}` });
      if (b.lead_user_id && !partners.includes(b.lead_user_id)) notify(db, { ...msg, to: b.lead_user_id, link: '#/staffing' });
    }
  }
}
