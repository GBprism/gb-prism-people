// "My week at GB": the employee Home and the project detail page.
// Only records the signed-in person may already see: their own reviews, leave, timesheets,
// onboarding, and the deliverables and team of projects they work on. Billing milestones,
// fees and other people's leave reasons never appear here.
import { notFound, forbid } from '../db.js';
import { isOps, has, currentEmployment } from './authz.js';
import { holidaysFor, activePolicy } from './leave.js';
import { todayIn } from './dates.js';

const addDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const prevMonth = (m) => { const [y, mm] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mm - 2, 1)); return d.toISOString().slice(0, 7); };
const lastDayOf = (m) => { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10); };
const ROLE_ORDER = { confirmed: 0, tentative: 1, provisional: 2, historical: 3 };

/** Projects the person works on or leads that are running now. */
function myProjects(db, actor) {
  return db.prepare(`SELECT p.id, p.name, p.start_date, p.end_date, p.lead_user_id, lu.name lead_name, c.name_en client_name, c.short client_short
      FROM projects p LEFT JOIN users lu ON lu.id = p.lead_user_id
      LEFT JOIN engagements e ON e.project_id = p.id AND e.tenant_id = p.tenant_id LEFT JOIN clients c ON c.id = e.client_id
      WHERE p.tenant_id = ? AND p.kind = 'engagement' AND p.status = 'active' AND p.register_status != 'archived'
        AND (p.lead_user_id = ? OR EXISTS (SELECT 1 FROM project_assignments a WHERE a.project_id = p.id AND a.user_id = ? AND a.status IN ('confirmed','tentative','provisional','historical')
          AND (a.end_date IS NULL OR a.end_date >= ?)))
      GROUP BY p.id ORDER BY COALESCE(p.end_date, '9999'), p.name`).all(actor.tenantId, actor.id, actor.id, todayIn())
    .map((p) => {
      const mine = db.prepare('SELECT role, status, start_date, end_date, allocation_pct FROM project_assignments WHERE project_id = ? AND user_id = ?').all(p.id, actor.id)
        .sort((a, b) => ROLE_ORDER[a.status] - ROLE_ORDER[b.status])[0] || null;
      const next = db.prepare(`SELECT id, title, milestone, workstream, due_date, status FROM deliverables WHERE project_id = ? AND due_date >= ? AND status NOT IN ('accepted','done','cancelled')
          ORDER BY due_date LIMIT 1`).get(p.id, todayIn()) || null;
      return { id: p.id, name: p.name, client: p.client_name || null, client_short: p.client_short || null, lead_name: p.lead_name, is_lead: p.lead_user_id === actor.id,
        role: p.lead_user_id === actor.id ? 'Project lead' : mine?.role || null, assignment_status: mine?.status || null, allocation_pct: mine?.allocation_pct ?? null,
        start_date: p.start_date, end_date: p.end_date,
        next: next ? { title: next.milestone || next.title, deliverable: next.title, date: next.due_date, id: next.id } : p.end_date && p.end_date >= todayIn() ? { title: 'Planned end of engagement', date: p.end_date } : null };
    });
}

/**
 * Home for the signed-in person. `personal` is the list of inbox items that belong to them
 * (not approvals of other people's work), built by the inbox endpoint.
 */
export function myWeek(db, actor, { personal = [], reviewNext = null, seatsToConfirm = 0 } = {}) {
  const today = todayIn();
  const horizon = addDays(today, 13);
  const emp = currentEmployment(db, actor.id);
  const attention = [];

  // ---- onboarding: a new joiner's next step comes first
  const items = db.prepare(`SELECT i.id, i.title, i.stage, i.owner, p.done_at FROM onboarding_items i LEFT JOIN onboarding_progress p ON p.item_id = i.id AND p.user_id = ?
      WHERE i.tenant_id = ? ORDER BY i.position`).all(actor.id, actor.tenantId);
  const tenure = emp?.hire_date ? daysBetween(emp.hire_date, today) : null;
  const mineToDo = items.filter((i) => i.owner === 'new_joiner' && !i.done_at);
  const onboarding = tenure != null && tenure >= -30 && tenure <= 45 && items.length
    ? { day: tenure + 1, done: items.filter((i) => i.done_at).length, total: items.length, next: mineToDo[0] ? { title: mineToDo[0].title, stage: mineToDo[0].stage } : null, hire_date: emp.hire_date }
    : null;
  if (onboarding?.next) attention.push({ kind: 'onboarding', title: onboarding.next.title, detail: `Onboarding · step ${onboarding.done + 1} of ${onboarding.total}`, action: 'Continue onboarding', link: '#/onboarding' });

  // ---- performance: the review step that is due
  if (reviewNext?.link) attention.push({ kind: 'review', title: reviewNext.label, detail: 'Performance review', due: reviewNext.due || null, action: /self-assessment/.test(reviewNext.label) ? 'Continue your self-assessment' : /acknowledge/.test(reviewNext.label) ? 'Read your result' : 'Open your goals', link: reviewNext.link });

  // ---- timesheet: last month first, then this month near its end
  const month = today.slice(0, 7); const last = prevMonth(month);
  const tsStatus = (m) => db.prepare('SELECT status FROM timesheet_months WHERE user_id = ? AND month = ?').get(actor.id, m)?.status || 'open';
  // nag about a past month only once timesheets were in use at GB (and the person had joined)
  const firstMonth = db.prepare('SELECT MIN(month) m FROM timesheet_months WHERE tenant_id = ?').get(actor.tenantId).m;
  const started = (m) => (!emp?.hire_date || emp.hire_date <= lastDayOf(m)) && !!firstMonth && firstMonth <= m;
  if (started(last) && ['open', 'returned'].includes(tsStatus(last))) attention.push({ kind: 'timesheet', title: `${tsStatus(last) === 'returned' ? 'Correct and resubmit' : 'Submit'} your ${monthName(last)} timesheet`, detail: tsStatus(last) === 'returned' ? 'Returned with a note' : 'Hours are drafted from your projects and leave', due: lastDayOf(last), action: 'Open timesheet', link: `#/timesheet?m=${last}` });
  if (daysBetween(today, lastDayOf(month)) <= 4 && ['open', 'returned'].includes(tsStatus(month))) attention.push({ kind: 'timesheet', title: `Submit your ${monthName(month)} timesheet`, detail: 'Check the drafted hours and send them', due: lastDayOf(month), action: 'Open timesheet', link: `#/timesheet?m=${month}` });

  // ---- deliverables due soon on my projects (where I contribute, review or lead)
  for (const d of db.prepare(`SELECT d.id, d.title, d.due_date, p.id project_id, p.name project FROM deliverables d JOIN projects p ON p.id = d.project_id
      WHERE p.tenant_id = ? AND d.due_date BETWEEN ? AND ? AND d.status NOT IN ('accepted','done','cancelled','submitted')
        AND (p.lead_user_id = ? OR d.qa_reviewer_id = ? OR EXISTS (SELECT 1 FROM contributions c WHERE c.deliverable_id = d.id AND c.user_id = ?))
      ORDER BY d.due_date LIMIT 3`).all(actor.tenantId, addDays(today, -14), addDays(today, 7), actor.id, actor.id, actor.id))
    attention.push({ kind: 'deliverable', title: `Submit “${d.title}” for review`, detail: d.project, due: d.due_date, action: 'Open project', link: `#/project/${d.project_id}` });

  for (const i of personal) attention.push({ kind: i.type, title: i.title, detail: i.kind, due: i.due || null, action: i.action || 'Open', link: i.link });
  for (const a of db.prepare(`SELECT d.title, d.due_date, d.plan_id FROM development_actions d JOIN plans p ON p.id = d.plan_id WHERE d.user_id = ? AND p.state IN ('released','acknowledged','closed')
      AND d.status IN ('open','in_progress') AND d.due_date IS NOT NULL AND d.due_date <= ?`).all(actor.id, addDays(today, 30)))
    attention.push({ kind: 'development', title: a.title, detail: 'Development action', due: a.due_date, action: 'Open', link: '#/history' });
  if (seatsToConfirm) attention.push({ kind: 'ai', title: `Confirm ${seatsToConfirm} AI seat usage record${seatsToConfirm === 1 ? '' : 's'}`, detail: 'AI examples', action: 'Confirm', link: '#/ai' });

  const rank = { onboarding: 0, review: 1, timesheet: 2, deliverable: 3 };
  attention.forEach((a) => { a.overdue = !!(a.due && a.due < today); });
  attention.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (rank[a.kind] ?? 5) - (rank[b.kind] ?? 5) || (a.due || '9999').localeCompare(b.due || '9999'));

  // ---- this week: dated things that matter to me over the next two weeks
  const projects = myProjects(db, actor);
  const week = [];
  for (const r of db.prepare(`SELECT r.id, r.start_date, r.end_date, r.state, t.name, t.category FROM leave_requests r JOIN leave_types t ON t.id = r.type_id
      WHERE r.user_id = ? AND r.state IN ('approved','submitted') AND r.end_date >= ? AND r.start_date <= ? ORDER BY r.start_date`).all(actor.id, today, horizon))
    week.push({ date: r.start_date < today ? today : r.start_date, end: r.end_date, kind: r.category === 'offsite' ? 'offsite' : 'leave', title: r.name, detail: r.state === 'approved' ? 'Approved' : 'Waiting for approval', link: '#/timeoff' });
  for (const [date, name] of holidaysFor(db, actor.tenantId, emp?.country || 'JO', today, horizon)) week.push({ date, kind: 'holiday', title: name, detail: 'Public holiday' });
  if (reviewNext?.due && reviewNext.due >= today && reviewNext.due <= horizon) week.push({ date: reviewNext.due, kind: 'deadline', title: reviewNext.label, detail: 'Review deadline', link: reviewNext.link });
  for (const d of db.prepare(`SELECT d.title, d.milestone, d.due_date, p.id project_id, p.name project FROM deliverables d JOIN projects p ON p.id = d.project_id
      WHERE d.due_date BETWEEN ? AND ? AND d.project_id IN (${projects.map(() => '?').join(',') || "''"}) AND d.status NOT IN ('accepted','done','cancelled') ORDER BY d.due_date`).all(today, horizon, ...projects.map((p) => p.id)))
    week.push({ date: d.due_date, kind: 'milestone', title: d.milestone || d.title, detail: d.project, link: `#/project/${d.project_id}` });
  for (const p of projects) if (p.end_date && p.end_date >= today && p.end_date <= horizon) week.push({ date: p.end_date, kind: 'milestone', title: 'Engagement ends', detail: p.name, link: `#/project/${p.id}` });
  const tsDue = lastDayOf(month);
  if (tsDue <= horizon && ['open', 'returned'].includes(tsStatus(month))) week.push({ date: tsDue, kind: 'deadline', title: `${monthName(month)} timesheet due`, detail: 'Timesheet', link: `#/timesheet?m=${month}` });
  for (const a of attention) if (a.kind === 'survey' && a.due && a.due <= horizon) week.push({ date: a.due, kind: 'deadline', title: 'Team pulse closes', detail: 'Anonymous, 2 minutes', link: a.link });
  week.sort((a, b) => a.date.localeCompare(b.date));

  // ---- what the lead area shows
  const reviewDue = attention.find((a) => a.kind === 'review');
  const mode = onboarding?.next ? 'onboarding' : reviewDue ? 'review' : attention.length ? 'tasks' : 'clear';
  return { today, mode, onboarding, attention, week, projects, workweek: activePolicy(db, actor.tenantId, today).settings.workweek };
}

/** One engagement, from the person's point of view. Everyone may see a running project's basics
 *  (as on Active projects); its team, deliverables and timeline are for the team, its lead,
 *  partners and People Ops. */
export function projectOverview(db, actor, projectId) {
  const p = db.prepare(`SELECT p.*, lu.name lead_name, e.id engagement_id, e.title_en, e.scope_en, e.drive_url lib_drive, c.name_en client_name, c.short client_short, c.sector, c.country
      FROM projects p LEFT JOIN users lu ON lu.id = p.lead_user_id LEFT JOIN engagements e ON e.project_id = p.id AND e.tenant_id = p.tenant_id LEFT JOIN clients c ON c.id = e.client_id
      WHERE p.id = ? AND p.tenant_id = ?`).get(projectId, actor.tenantId);
  if (!p) throw notFound();
  const today = todayIn();
  const team = db.prepare(`SELECT a.id, a.user_id, u.name, a.role, a.status, a.start_date, a.end_date, a.allocation_pct FROM project_assignments a JOIN users u ON u.id = a.user_id
      WHERE a.project_id = ? AND a.status IN ('confirmed','tentative','provisional','historical') ORDER BY u.name`).all(p.id);
  const onTeam = p.lead_user_id === actor.id || team.some((t) => t.user_id === actor.id);
  const full = onTeam || isOps(actor) || has(actor, 'partner');
  const running = p.kind === 'engagement' && p.status === 'active' && p.register_status !== 'archived';
  if (!full && !running) throw forbid();
  const mine = team.filter((t) => t.user_id === actor.id).sort((a, b) => ROLE_ORDER[a.status] - ROLE_ORDER[b.status])[0] || null;
  const deliverables = full ? db.prepare('SELECT id, title, workstream, milestone, due_date, status, drive_url FROM deliverables WHERE project_id = ? ORDER BY COALESCE(due_date, \'9999\'), title').all(p.id) : [];
  const done = (d) => ['accepted', 'done'].includes(d.status);
  const next = deliverables.find((d) => d.due_date && d.due_date >= today && !done(d) && d.status !== 'cancelled') || null;
  const myHours = db.prepare("SELECT COALESCE(SUM(hours_x100), 0) n FROM timesheet_entries WHERE user_id = ? AND project_id = ?").get(actor.id, p.id).n / 100;
  // one row per person: the assignment that best describes them now
  const people = new Map();
  for (const t of team) { const cur = people.get(t.user_id); if (!cur || ROLE_ORDER[t.status] < ROLE_ORDER[cur.status]) people.set(t.user_id, t); }
  return {
    id: p.id, name: p.name, title: p.title_en || null, scope: p.scope_en || null, client: p.client_name || p.client || null, client_short: p.client_short || null, sector: p.sector || null, country: p.country || null,
    lead: p.lead_user_id ? { id: p.lead_user_id, name: p.lead_name } : null, is_lead: p.lead_user_id === actor.id, running,
    start_date: p.start_date, end_date: p.end_date, drive_url: p.drive_url || p.lib_drive || null, chat_url: p.chat_url, meet_url: p.meet_url, engagement_id: p.engagement_id || null,
    me: mine ? { role: mine.role, status: mine.status, start_date: mine.start_date, end_date: mine.end_date, allocation_pct: mine.allocation_pct, hours: myHours } : p.lead_user_id === actor.id ? { role: 'Project lead', status: 'confirmed', hours: myHours } : null,
    full, next: next ? { id: next.id, title: next.milestone || next.title, deliverable: next.title, date: next.due_date, workstream: next.workstream } : null,
    counts: { deliverables: deliverables.length, done: deliverables.filter(done).length, overdue: deliverables.filter((d) => d.due_date && d.due_date < today && !done(d) && d.status !== 'cancelled').length, team: people.size },
    deliverables, team: full ? [...people.values()].map((t) => ({ id: t.user_id, name: t.name, role: t.role, status: t.status, start_date: t.start_date || p.start_date, end_date: t.end_date || p.end_date, allocation_pct: t.allocation_pct })) : [],
    can: { commercial: has(actor, 'partner'), register: full, closeout: full && !!p.engagement_id },
  };
}
