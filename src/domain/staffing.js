// Resource calendar: who is booked on what for the next 12 weeks, and who is free.
// Bookings come from project assignments (with an allocation %; when none is set, the person's
// time is split evenly across their running projects and marked "estimated"), explicit bookings
// (including tentative ones for proposals), minus approved leave and public holidays.
// Everyone sees the calendar (availability only, never leave reasons). Partners and People Ops see
// utilisation against target for everyone; each person sees their own.
import { uid, now, audit, bad, forbid, notFound } from '../db.js';
import { isOps, has, currentEmployment } from './authz.js';
import { activePolicy, holidaysFor } from './leave.js';

export const DEFAULT_TARGETS = { Consultant: 80, 'Senior Consultant': 75, 'Assistant Manager': 65 };
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(Date.parse(`${s}T00:00:00Z`) + n * 864e5));
const editor = (a) => isOps(a) || has(a, 'partner');

function weeksFrom(start, n) {
  const d = new Date(`${start}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // Sunday
  return Array.from({ length: n }, (_, i) => { const s = iso(new Date(d.getTime() + i * 7 * 864e5)); return { start: s, end: addDays(s, 6) }; });
}
const overlapDays = (a1, a2, b1, b2, days) => days.filter((d) => d >= a1 && d >= (b1 || d) && d <= a2 && d <= (b2 || d)).length;

export function calendar(db, actor, { from, weeks = 12 } = {}) {
  const T = actor.tenantId;
  const ws = weeksFrom(from || iso(new Date()), Math.min(26, Math.max(4, Number(weeks) || 12)));
  const first = ws[0].start; const last = ws.at(-1).end;
  const { settings } = activePolicy(db, T, first);
  const hol = holidaysFor(db, T, 'JO', first, last);
  const workdays = ws.map((w) => Array.from({ length: 7 }, (_, i) => addDays(w.start, i)).filter((d) => settings.workweek.includes(new Date(`${d}T00:00:00Z`).getUTCDay()) && !hol.has(d)));
  const people = db.prepare(`SELECT u.id, u.name, e.title FROM users u LEFT JOIN employments e ON e.user_id = u.id AND e.effective_to IS NULL
      WHERE u.tenant_id = ? AND u.active = 1 ORDER BY u.name`).all(T);
  const leaveDays = new Map(); // user -> Map(date -> share of day)
  for (const r of db.prepare(`SELECT r.user_id, r.breakdown_json FROM leave_requests r JOIN leave_types t ON t.id = r.type_id
      WHERE r.tenant_id = ? AND r.state IN ('approved','submitted') AND t.category = 'leave' AND r.end_date >= ? AND r.start_date <= ?`).all(T, first, last)) {
    const m = leaveDays.get(r.user_id) || new Map();
    for (const d of JSON.parse(r.breakdown_json || '{}').days || []) if (d.charge_x100) m.set(d.date, Math.min(1, (m.get(d.date) || 0) + d.charge_x100 / 100));
    leaveDays.set(r.user_id, m);
  }
  const assignments = db.prepare(`SELECT a.id, a.user_id, a.project_id, a.allocation_pct, a.start_date, a.end_date, p.name, p.start_date p_start, p.end_date p_end, p.lead_user_id
      FROM project_assignments a JOIN projects p ON p.id = a.project_id
      WHERE a.tenant_id = ? AND p.kind = 'engagement' AND p.status = 'active' AND p.register_status != 'archived' AND a.status IN ('confirmed','tentative','historical')
        AND COALESCE(a.end_date, p.end_date, '9999-12-31') >= ? AND COALESCE(a.start_date, p.start_date, '0000-01-01') <= ?`).all(T, first, last);
  const bookings = db.prepare(`SELECT b.*, p.name project, pr.title_en proposal FROM resource_bookings b LEFT JOIN projects p ON p.id = b.project_id LEFT JOIN proposals pr ON pr.id = b.proposal_id
      WHERE b.tenant_id = ? AND b.end_date >= ? AND b.start_date <= ?`).all(T, first, last);
  const seeUtil = editor(actor);
  const rows = people.map((u) => {
    const lv = leaveDays.get(u.id) || new Map();
    const mine = assignments.filter((a) => a.user_id === u.id);
    const extra = bookings.filter((b) => b.user_id === u.id);
    const cells = ws.map((w, i) => {
      const days = workdays[i]; if (!days.length) return { week: w.start, available: 0, booked: 0, tentative: 0, items: [] };
      const away = days.reduce((s, d) => s + (lv.get(d) || 0), 0);
      const available = Math.round(((days.length - away) / days.length) * 100);
      const items = [];
      const set = mine.map((a) => ({ a, share: overlapDays(a.start_date || a.p_start || first, a.end_date || a.p_end || last, w.start, w.end, days) / days.length })).filter((x) => x.share > 0);
      const fixed = set.filter((x) => x.a.allocation_pct != null);
      const loose = set.filter((x) => x.a.allocation_pct == null);
      const fixedSum = fixed.reduce((s, x) => s + x.a.allocation_pct * x.share, 0) + extra.filter((b) => b.status === 'confirmed').reduce((s, b) => s + b.pct * (overlapDays(b.start_date, b.end_date, w.start, w.end, days) / days.length), 0);
      for (const x of fixed) items.push({ project: x.a.name, project_id: x.a.project_id, assignment_id: x.a.id, pct: Math.round(x.a.allocation_pct * x.share), estimated: false });
      const left = Math.max(0, available - fixedSum);
      for (const x of loose) items.push({ project: x.a.name, project_id: x.a.project_id, assignment_id: x.a.id, pct: Math.round((left / loose.length) * x.share), estimated: true });
      for (const b of extra) { const sh = overlapDays(b.start_date, b.end_date, w.start, w.end, days) / days.length; if (sh > 0) items.push({ project: b.project || b.proposal || b.label, booking_id: b.id, pct: Math.round(b.pct * sh), tentative: b.status === 'tentative', proposal: !!b.proposal_id }); }
      const booked = items.filter((x) => !x.tentative).reduce((s, x) => s + x.pct, 0);
      const tentative = items.filter((x) => x.tentative).reduce((s, x) => s + x.pct, 0);
      return { week: w.start, available, booked, tentative, items, over: booked > available + 5, free: available - booked >= 50 };
    });
    // day-level detail for the week view: what each block is and when; away days carry no reason
    const spans = [...mine.map((a) => ({ project: a.name, project_id: a.project_id, assignment_id: a.id, start: a.start_date || a.p_start || first, end: a.end_date || a.p_end || last, pct: a.allocation_pct, estimated: a.allocation_pct == null })),
      ...extra.map((b) => ({ project: b.project || b.proposal || b.label, project_id: b.project_id, booking_id: b.id, start: b.start_date, end: b.end_date, pct: b.pct, tentative: b.status === 'tentative', proposal: !!b.proposal_id }))];
    const away = [...lv].filter(([d, share]) => share > 0 && d >= first && d <= last).map(([date, share]) => ({ date, share }));
    return { id: u.id, name: u.name, title: u.title, weeks: cells, spans, away, utilisation: seeUtil || u.id === actor.id ? utilisation(db, T, u) : undefined };
  });
  return { weeks: ws.map((w, i) => ({ ...w, workdays: workdays[i].length, days: workdays[i] })), holidays: Object.fromEntries(hol), workweek: settings.workweek, people: rows, canEdit: editor(actor),
    summary: { over: rows.filter((r) => r.weeks.slice(0, 4).some((c) => c.over)).map((r) => r.name), bench: rows.filter((r) => r.weeks.slice(0, 2).every((c) => c.available && c.free)).map((r) => r.name) } };
}

/** Actual utilisation over the last three full months: project hours ÷ logged hours, against the level's target. */
function utilisation(db, tenantId, u) {
  const d = new Date(); const months = [1, 2, 3].map((k) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1)); return x.toISOString().slice(0, 7); });
  const r = db.prepare(`SELECT COALESCE(SUM(CASE WHEN code LIKE 'p:%' THEN hours_x100 END), 0) project, COALESCE(SUM(hours_x100), 0) total FROM timesheet_entries WHERE user_id = ? AND month IN (${months.map(() => '?').join(',')})`).get(u.id, ...months);
  const target = db.prepare('SELECT target_pct FROM cost_rates WHERE tenant_id = ? AND level = ?').get(tenantId, u.title || '')?.target_pct ?? DEFAULT_TARGETS[u.title] ?? null;
  return { pct: r.total ? Math.round((r.project / r.total) * 100) : null, target, months };
}

/** Lead / partner / People Ops sets how much of someone's time a project takes. */
export function setAllocation(db, actor, assignmentId, pct) {
  const a = db.prepare('SELECT a.*, p.lead_user_id FROM project_assignments a JOIN projects p ON p.id = a.project_id WHERE a.id = ? AND a.tenant_id = ?').get(assignmentId, actor.tenantId);
  if (!a) throw notFound();
  if (!editor(actor) && a.lead_user_id !== actor.id) throw forbid();
  const v = pct === '' || pct == null ? null : Math.round(Number(pct));
  if (v != null && !(v >= 0 && v <= 100)) throw bad('Allocation is 0–100%');
  db.prepare('UPDATE project_assignments SET allocation_pct = ? WHERE id = ?').run(v, assignmentId);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'staffing.allocation', entity: 'assignment', entityId: assignmentId, after: { pct: v } });
  return { ok: true };
}

/** A booking: a person on a project or a proposal for a period, tentative or confirmed. */
export function saveBooking(db, actor, id, b = {}) {
  const T = actor.tenantId;
  if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ? AND active = 1').get(b.user_id, T)) throw bad('Choose a person');
  const proj = b.project_id ? db.prepare('SELECT lead_user_id FROM projects WHERE id = ? AND tenant_id = ?').get(b.project_id, T) : null;
  const prop = b.proposal_id ? db.prepare('SELECT owner_user_id FROM proposals WHERE id = ? AND tenant_id = ?').get(b.proposal_id, T) : null;
  if (b.project_id && !proj) throw bad('Unknown project'); if (b.proposal_id && !prop) throw bad('Unknown proposal');
  if (!editor(actor) && proj?.lead_user_id !== actor.id && prop?.owner_user_id !== actor.id) throw forbid();
  const label = String(b.label || '').trim().slice(0, 80) || null;
  if (!b.project_id && !b.proposal_id && !label) throw bad('Choose a project or proposal, or name the work');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.end_date || '') || b.end_date < b.start_date) throw bad('Give a valid start and end date');
  const pct = Math.round(Number(b.pct)); if (!(pct >= 5 && pct <= 100)) throw bad('Booking is 5–100% of the person’s time');
  const status = b.status === 'confirmed' ? 'confirmed' : 'tentative';
  const vals = [b.user_id, b.project_id || null, b.proposal_id || null, label, b.start_date, b.end_date, pct, status];
  if (id) { const r = db.prepare('UPDATE resource_bookings SET user_id = ?, project_id = ?, proposal_id = ?, label = ?, start_date = ?, end_date = ?, pct = ?, status = ? WHERE id = ? AND tenant_id = ?').run(...vals, id, T); if (!r.changes) throw notFound(); }
  else { id = uid('bk_'); db.prepare('INSERT INTO resource_bookings (user_id, project_id, proposal_id, label, start_date, end_date, pct, status, id, tenant_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals, id, T, actor.id, now()); }
  audit(db, { tenantId: T, actorId: actor.id, action: 'staffing.booking', entity: 'booking', entityId: id, after: { pct, status } });
  return { id };
}
export function deleteBooking(db, actor, id) {
  const b = db.prepare('SELECT b.*, p.lead_user_id FROM resource_bookings b LEFT JOIN projects p ON p.id = b.project_id WHERE b.id = ? AND b.tenant_id = ?').get(id, actor.tenantId); if (!b) throw notFound();
  if (!editor(actor) && b.lead_user_id !== actor.id && b.created_by !== actor.id) throw forbid();
  db.prepare('DELETE FROM resource_bookings WHERE id = ?').run(id);
  return { ok: true };
}
