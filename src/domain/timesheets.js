// Monthly timesheets. The month drafts itself: every working day (Sun–Thu, minus public holidays
// and approved leave) gets the standard 8 hours split across the projects the person is assigned
// to that day, or "Internal" if none. The person corrects the hours and submits; People Ops or a
// partner approves. Project man-hours per month come straight from approved and submitted sheets.
// Visible to the person, their line manager, People Ops and partners; project leads see totals for
// their own projects only.
import { tx, uid, now, audit, bad, forbid, notFound } from '../db.js';
import { isOps, has, currentEmployment } from './authz.js';
import { activePolicy, holidaysFor } from './leave.js';
import { toX100 } from './decimal.js';

export const FIXED_CODES = [
  { code: 'internal', label: 'Internal & admin' },
  { code: 'proposals', label: 'Proposals & BD' },
  { code: 'learning', label: 'Learning' },
];
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
const daysOf = (month) => { const [y, m] = month.split('-').map(Number); const n = new Date(Date.UTC(y, m, 0)).getUTCDate(); return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`); };
const wd = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();

function access(db, actor, userId) {
  const u = db.prepare('SELECT id, name, tenant_id FROM users WHERE id = ?').get(userId);
  if (!u || u.tenant_id !== actor.tenantId) throw notFound();
  const mgr = currentEmployment(db, userId)?.manager_id === actor.id;
  const view = actor.id === userId || isOps(actor) || has(actor, 'partner') || mgr;
  if (!view) throw forbid();
  return { u, own: actor.id === userId, approve: actor.id !== userId && (isOps(actor) || has(actor, 'partner')) };
}

/** Capacity per day (hundredths of an hour) after weekends, holidays and approved leave. */
function calendar(db, tenantId, userId, month) {
  const emp = currentEmployment(db, userId);
  const { settings } = activePolicy(db, tenantId, `${month}-01`);
  const days = daysOf(month);
  const hol = holidaysFor(db, tenantId, emp?.country || 'JO', days[0], days.at(-1));
  const off = new Map(); // date -> hundredths of a day on leave
  for (const r of db.prepare(`SELECT r.breakdown_json FROM leave_requests r JOIN leave_types t ON t.id = r.type_id
      WHERE r.user_id = ? AND r.state = 'approved' AND t.category = 'leave' AND r.start_date <= ? AND r.end_date >= ?`).all(userId, days.at(-1), days[0])) {
    for (const d of JSON.parse(r.breakdown_json || '{}').days || []) if (d.charge_x100) off.set(d.date, Math.min(100, (off.get(d.date) || 0) + d.charge_x100));
  }
  const per = Math.round((settings.hoursPerDay || 8) * 100);
  return days.map((date) => {
    const weekend = !settings.workweek.includes(wd(date)); const holiday = hol.get(date) || null; const leave = off.get(date) || 0;
    const capacity = weekend || holiday ? 0 : Math.round((per * (100 - leave)) / 100);
    return { date, weekday: wd(date), weekend, holiday, leave_x100: leave, capacity_x100: capacity };
  });
}

function projectsFor(db, userId, month) {
  const days = daysOf(month);
  return db.prepare(`SELECT DISTINCT p.id, p.name, p.kind, a.start_date, a.end_date FROM project_assignments a JOIN projects p ON p.id = a.project_id
      WHERE a.user_id = ? AND a.status IN ('confirmed','tentative','historical','provisional') AND p.kind != 'initiative'
        AND (a.start_date IS NULL OR a.start_date <= ?) AND (a.end_date IS NULL OR a.end_date >= ?) ORDER BY p.name`).all(userId, days.at(-1), days[0]);
}

export function monthView(db, actor, userId, month) {
  if (!isMonth(month)) throw bad('Month must be yyyy-mm');
  const a = access(db, actor, userId);
  let st = db.prepare('SELECT * FROM timesheet_months WHERE user_id = ? AND month = ?').get(userId, month);
  // the month drafts itself the first time its owner opens it
  if (!st && a.own && db.prepare('SELECT COUNT(*) n FROM timesheet_entries WHERE user_id = ? AND month = ?').get(userId, month).n === 0) autofill(db, actor, month);
  st = db.prepare('SELECT * FROM timesheet_months WHERE user_id = ? AND month = ?').get(userId, month) || { status: 'open' };
  const days = calendar(db, actor.tenantId, userId, month);
  const entries = db.prepare('SELECT work_date, code, project_id, hours_x100, source FROM timesheet_entries WHERE user_id = ? AND month = ?').all(userId, month);
  const assigned = projectsFor(db, userId, month);
  const extra = db.prepare(`SELECT DISTINCT p.id, p.name, p.kind FROM timesheet_entries e JOIN projects p ON p.id = e.project_id WHERE e.user_id = ? AND e.month = ?`).all(userId, month);
  const rows = [...new Map([...assigned, ...extra].map((p) => [`p:${p.id}`, { code: `p:${p.id}`, label: p.name, project_id: p.id, kind: p.kind }])).values(), ...FIXED_CODES];
  const total = (code) => entries.filter((e) => e.code === code).reduce((s, e) => s + e.hours_x100, 0);
  return { user: { id: a.u.id, name: a.u.name }, month, status: st.status, note: st.note || null, submitted_at: st.submitted_at || null,
    days, rows: rows.map((r) => ({ ...r, total_x100: total(r.code) })), entries,
    totals: { hours_x100: entries.reduce((s, e) => s + e.hours_x100, 0), capacity_x100: days.reduce((s, d) => s + d.capacity_x100, 0) },
    can: { edit: a.own && ['open', 'returned'].includes(st.status), approve: a.approve && st.status === 'submitted' } };
}

/** Draft hours from assignments: each working day's capacity split across that day's projects. Manual hours are kept. */
export function autofill(db, actor, month, { overwrite = false } = {}) {
  if (!isMonth(month)) throw bad('Month must be yyyy-mm');
  const userId = actor.id;
  const st = db.prepare('SELECT status FROM timesheet_months WHERE user_id = ? AND month = ?').get(userId, month);
  if (st && !['open', 'returned'].includes(st.status)) throw bad('This month is already submitted');
  const days = calendar(db, actor.tenantId, userId, month);
  const projects = projectsFor(db, userId, month);
  let filled = 0;
  tx(db, () => {
    db.prepare(`DELETE FROM timesheet_entries WHERE user_id = ? AND month = ? AND ${overwrite ? '1' : "source = 'auto'"}`).run(userId, month);
    const manualDays = new Set(db.prepare('SELECT DISTINCT work_date FROM timesheet_entries WHERE user_id = ? AND month = ?').all(userId, month).map((r) => r.work_date));
    for (const d of days) {
      if (!d.capacity_x100 || manualDays.has(d.date)) continue;
      const today = projects.filter((p) => (!p.start_date || p.start_date <= d.date) && (!p.end_date || p.end_date >= d.date));
      const codes = today.length ? today.map((p) => [`p:${p.id}`, p.id]) : [['internal', null]];
      // split in quarter hours; the remainder goes to the first project so the day adds up exactly
      const share = Math.floor(d.capacity_x100 / codes.length / 25) * 25; let left = d.capacity_x100 - share * codes.length;
      for (const [code, pid] of codes) {
        const h = share + left; left = 0;
        db.prepare('INSERT INTO timesheet_entries (id, tenant_id, user_id, month, work_date, code, project_id, hours_x100, source) VALUES (?,?,?,?,?,?,?,?,?)').run(uid('ts_'), actor.tenantId, userId, month, d.date, code, pid, h, 'auto');
        filled++;
      }
    }
    db.prepare("INSERT INTO timesheet_months (user_id, month, tenant_id) VALUES (?,?,?) ON CONFLICT DO NOTHING").run(userId, month, actor.tenantId);
  });
  return { ok: true, filled };
}

/** Save the person's own hours: [{ date, code, hours }]. Zero hours removes the cell. */
export function saveEntries(db, actor, month, cells = []) {
  if (!isMonth(month)) throw bad('Month must be yyyy-mm');
  const st = db.prepare('SELECT status FROM timesheet_months WHERE user_id = ? AND month = ?').get(actor.id, month);
  if (st && !['open', 'returned'].includes(st.status)) throw bad('This month is already submitted');
  const valid = new Set([...FIXED_CODES.map((c) => c.code)]);
  tx(db, () => {
    for (const c of cells) {
      if (!String(c.date || '').startsWith(month) || !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) throw bad('Date outside this month');
      let pid = null;
      if (String(c.code).startsWith('p:')) {
        pid = c.code.slice(2);
        if (!db.prepare('SELECT 1 FROM projects WHERE id = ? AND tenant_id = ?').get(pid, actor.tenantId)) throw bad('Unknown project');
      } else if (!valid.has(c.code)) throw bad('Unknown time code');
      let h; try { h = c.hours === '' || c.hours == null ? 0 : toX100(c.hours); } catch (e) { throw bad(e.message); }
      if (h == null || h < 0 || h > 2400) throw bad('Hours must be between 0 and 24');
      if (!h) { db.prepare('DELETE FROM timesheet_entries WHERE user_id = ? AND work_date = ? AND code = ?').run(actor.id, c.date, c.code); continue; }
      db.prepare(`INSERT INTO timesheet_entries (id, tenant_id, user_id, month, work_date, code, project_id, hours_x100, source) VALUES (?,?,?,?,?,?,?,?, 'manual')
          ON CONFLICT(user_id, work_date, code) DO UPDATE SET hours_x100 = excluded.hours_x100, source = 'manual'`).run(uid('ts_'), actor.tenantId, actor.id, month, c.date, c.code, pid, h);
    }
    for (const d of new Set(cells.map((c) => c.date))) {
      const sum = db.prepare('SELECT COALESCE(SUM(hours_x100), 0) s FROM timesheet_entries WHERE user_id = ? AND work_date = ?').get(actor.id, d).s;
      if (sum > 2400) throw bad(`More than 24 hours on ${d}`);
    }
    db.prepare("INSERT INTO timesheet_months (user_id, month, tenant_id) VALUES (?,?,?) ON CONFLICT DO NOTHING").run(actor.id, month, actor.tenantId);
  });
  return { ok: true };
}

export function submitMonth(db, actor, month) {
  const v = monthView(db, actor, actor.id, month);
  if (!v.can.edit) throw bad('This month is already submitted');
  if (!v.totals.hours_x100) throw bad('There are no hours to submit');
  db.prepare("INSERT INTO timesheet_months (user_id, month, tenant_id, status, submitted_at) VALUES (?,?,?, 'submitted', ?) ON CONFLICT(user_id, month) DO UPDATE SET status = 'submitted', submitted_at = excluded.submitted_at, note = NULL")
    .run(actor.id, month, actor.tenantId, now());
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'timesheet.submit', entity: 'timesheet', entityId: `${actor.id}:${month}`, after: { hours_x100: v.totals.hours_x100 } });
  return { ok: true };
}

export function decideMonth(db, actor, userId, month, { decision, note } = {}) {
  const a = access(db, actor, userId); if (!a.approve) throw forbid();
  const st = db.prepare('SELECT status FROM timesheet_months WHERE user_id = ? AND month = ?').get(userId, month);
  if (st?.status !== 'submitted') throw bad('Only submitted months can be approved or returned');
  if (!['approve', 'return'].includes(decision)) throw bad('Approve or return');
  if (decision === 'return' && !String(note || '').trim()) throw bad('Say what to correct');
  db.prepare('UPDATE timesheet_months SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE user_id = ? AND month = ?').run(decision === 'approve' ? 'approved' : 'returned', actor.id, now(), String(note || '').trim() || null, userId, month);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: `timesheet.${decision}`, entity: 'timesheet', entityId: `${userId}:${month}`, reason: note || null });
  return { ok: true };
}

/** Man-hours per project and person for a month. Partners / People Ops see all; a lead sees their projects. */
export function monthReport(db, actor, month) {
  if (!isMonth(month)) throw bad('Month must be yyyy-mm');
  const all = isOps(actor) || has(actor, 'partner');
  const rows = db.prepare(`SELECT e.code, e.project_id, p.name project, p.lead_user_id, u.id user_id, u.name person, SUM(e.hours_x100) hours_x100, COALESCE(m.status, 'open') status
      FROM timesheet_entries e JOIN users u ON u.id = e.user_id LEFT JOIN projects p ON p.id = e.project_id
      LEFT JOIN timesheet_months m ON m.user_id = e.user_id AND m.month = e.month
      WHERE e.tenant_id = ? AND e.month = ? GROUP BY e.code, e.user_id ORDER BY project, person`).all(actor.tenantId, month)
    .filter((r) => all || (r.project_id && r.lead_user_id === actor.id));
  if (!all && !rows.length && !db.prepare('SELECT 1 FROM projects WHERE lead_user_id = ?').get(actor.id)) throw forbid();
  const label = (r) => r.project || FIXED_CODES.find((c) => c.code === r.code)?.label || r.code;
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.code) || { code: r.code, project_id: r.project_id, label: label(r), hours_x100: 0, people: [] };
    g.hours_x100 += r.hours_x100; g.people.push({ name: r.person, hours_x100: r.hours_x100, status: r.status }); groups.set(r.code, g);
  }
  const people = all ? db.prepare(`SELECT u.name, COALESCE(m.status, 'not started') status FROM users u LEFT JOIN timesheet_months m ON m.user_id = u.id AND m.month = ?
      WHERE u.tenant_id = ? AND u.active = 1 ORDER BY u.name`).all(month, actor.tenantId) : null;
  return { month, projects: [...groups.values()].sort((a, b) => (a.project_id ? 0 : 1) - (b.project_id ? 0 : 1) || b.hours_x100 - a.hours_x100), people, hours_per_day: 8 };
}

/** Pending approvals for the inbox. */
export function pendingMonths(db, actor) {
  if (!isOps(actor) && !has(actor, 'partner')) return [];
  return db.prepare(`SELECT m.user_id, m.month, u.name FROM timesheet_months m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.status = 'submitted' AND m.user_id != ? ORDER BY m.submitted_at`).all(actor.tenantId, actor.id);
}
