// Reports for partners and People Ops: people, time off, timesheets, expenses and office costs,
// projects and proposals, reviews, policies and documents. Totals only — no ratings or reasons.
import { forbid } from '../db.js';
import { isOps, has } from './authz.js';

export function reports(db, actor, { year } = {}) {
  if (!isOps(actor) && !has(actor, 'partner')) throw forbid();
  const T = actor.tenantId; const y = /^\d{4}$/.test(String(year || '')) ? String(year) : new Date().toISOString().slice(0, 4);
  const today = new Date().toISOString().slice(0, 10); const month = today.slice(0, 7);
  const one = (sql, ...a) => db.prepare(sql).get(...a); const all = (sql, ...a) => db.prepare(sql).all(...a);

  const people = {
    headcount: one('SELECT COUNT(*) n FROM users WHERE tenant_id = ? AND active = 1', T).n,
    by_title: all(`SELECT COALESCE(e.title, 'No title') label, COUNT(*) n FROM users u LEFT JOIN employments e ON e.user_id = u.id AND e.effective_to IS NULL
        WHERE u.tenant_id = ? AND u.active = 1 GROUP BY 1 ORDER BY n DESC`, T),
    joined_this_year: all(`SELECT u.name, e.hire_date FROM users u JOIN employments e ON e.user_id = u.id AND e.effective_to IS NULL WHERE u.tenant_id = ? AND u.active = 1 AND e.hire_date LIKE ? ORDER BY e.hire_date`, T, `${y}-%`),
    probation_ending: all(`SELECT u.name, e.probation_end FROM users u JOIN employments e ON e.user_id = u.id AND e.effective_to IS NULL WHERE u.tenant_id = ? AND u.active = 1 AND e.probation_end BETWEEN ? AND date(?, '+60 day') ORDER BY e.probation_end`, T, today, today),
  };
  const leave = {
    by_month: all(`SELECT substr(start_date, 1, 7) label, ROUND(SUM(chargeable_x100) / 100.0, 1) n FROM leave_requests r JOIN leave_types t ON t.id = r.type_id
        WHERE r.tenant_id = ? AND r.state = 'approved' AND t.category = 'leave' AND r.start_date LIKE ? GROUP BY 1 ORDER BY 1`, T, `${y}-%`),
    pending: one("SELECT COUNT(*) n FROM leave_requests WHERE tenant_id = ? AND state = 'submitted'", T).n,
    away_next_14: all(`SELECT u.name, r.start_date, r.end_date FROM leave_requests r JOIN users u ON u.id = r.user_id JOIN leave_types t ON t.id = r.type_id
        WHERE r.tenant_id = ? AND r.state = 'approved' AND t.category = 'leave' AND r.end_date >= ? AND r.start_date <= date(?, '+14 day') ORDER BY r.start_date`, T, today, today),
  };
  const tsMonth = all(`SELECT COALESCE(p.name, e.code) label, ROUND(SUM(e.hours_x100) / 100.0, 1) n FROM timesheet_entries e LEFT JOIN projects p ON p.id = e.project_id
      WHERE e.tenant_id = ? AND e.month = ? GROUP BY 1 ORDER BY n DESC`, T, month);
  const projectHours = one("SELECT COALESCE(SUM(hours_x100), 0) s FROM timesheet_entries WHERE tenant_id = ? AND month = ? AND code LIKE 'p:%'", T, month).s;
  const allHours = one('SELECT COALESCE(SUM(hours_x100), 0) s FROM timesheet_entries WHERE tenant_id = ? AND month = ?', T, month).s;
  const timesheets = { month, by_project: tsMonth, utilisation: allHours ? Math.round((projectHours / allHours) * 100) : null,
    submitted: one("SELECT COUNT(*) n FROM timesheet_months WHERE tenant_id = ? AND month = ? AND status IN ('submitted','approved')", T, month).n };
  const expenses = {
    claims_by_status: all("SELECT status label, COUNT(*) n, ROUND(SUM(total_x100) / 100.0, 2) amount FROM expense_claims WHERE tenant_id = ? AND substr(COALESCE(submitted_at, created_at), 1, 4) = ? GROUP BY status", T, y),
    by_category: all(`SELECT l.category label, ROUND(SUM(l.amount_x100) / 100.0, 2) n FROM expense_lines l JOIN expense_claims c ON c.id = l.claim_id
        WHERE c.tenant_id = ? AND c.status IN ('approved','paid') AND l.spent_on LIKE ? GROUP BY 1 ORDER BY n DESC LIMIT 10`, T, `${y}-%`),
    office_by_month: all("SELECT month label, ROUND(SUM(amount_x100) / 100.0, 2) n FROM office_expenses WHERE tenant_id = ? AND month LIKE ? GROUP BY 1 ORDER BY 1", T, `${y}-%`),
    office_by_category: all("SELECT category label, ROUND(SUM(amount_x100) / 100.0, 2) n FROM office_expenses WHERE tenant_id = ? AND month LIKE ? GROUP BY 1 ORDER BY n DESC", T, `${y}-%`),
  };
  const won = one("SELECT COUNT(*) n FROM proposals WHERE tenant_id = ? AND outcome = 'won' AND submitted_on LIKE ?", T, `${y}-%`).n;
  const lost = one("SELECT COUNT(*) n FROM proposals WHERE tenant_id = ? AND outcome = 'lost' AND submitted_on LIKE ?", T, `${y}-%`).n;
  const projects = {
    active: one("SELECT COUNT(*) n FROM projects WHERE tenant_id = ? AND kind = 'engagement' AND status = 'active' AND register_status != 'archived'", T).n,
    running_engagements: one("SELECT COUNT(*) n FROM engagements WHERE tenant_id = ? AND status = 'running'", T).n,
    proposals: { submitted: one('SELECT COUNT(*) n FROM proposals WHERE tenant_id = ? AND submitted_on LIKE ?', T, `${y}-%`).n, won, lost, hit_rate: won + lost ? Math.round((won / (won + lost)) * 100) : null },
    by_service_line: all("SELECT COALESCE(service_line, 'Not set') label, COUNT(*) n FROM engagements WHERE tenant_id = ? AND (year_from <= ? AND COALESCE(year_to, year_from) >= ?) GROUP BY 1 ORDER BY n DESC", T, Number(y), Number(y)),
  };
  const reviews = { by_state: all("SELECT p.state label, COUNT(*) n FROM plans p JOIN cycles c ON c.id = p.cycle_id WHERE p.tenant_id = ? AND c.year = ? GROUP BY 1 ORDER BY n DESC", T, Number(y)) };
  const policies = all(`SELECT p.title label, (SELECT COUNT(*) FROM policy_acks a WHERE a.policy_id = p.id AND COALESCE(a.version, '') = COALESCE(p.version, '')) n FROM policies p WHERE p.tenant_id = ? ORDER BY p.title`, T);
  const documents = all("SELECT title label, expires_on FROM company_documents WHERE tenant_id = ? AND archived = 0 AND expires_on IS NOT NULL AND expires_on <= date(?, '+60 day') ORDER BY expires_on", T, today);
  const claude = { active: one("SELECT COUNT(*) n FROM claude_accounts WHERE tenant_id = ? AND status = 'active'", T).n,
    people: one("SELECT COUNT(DISTINCT cu.user_id) n FROM claude_account_users cu JOIN claude_accounts a ON a.id = cu.account_id WHERE a.tenant_id = ? AND a.status = 'active'", T).n };
  return { year: y, people, leave, timesheets, expenses, projects, reviews, policies, documents, claude };
}
