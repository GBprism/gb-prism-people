// Time off and off-site work.
//
// Ledger model (append-only, integer hundredths, idempotent entry_key):
//   posted balance  = opening + grant + accrual + carryover + expiry + usage + reversal + adjustment
//   pending         = reservation + reservation_release   (holds for submitted requests)
//   projected       = posted + pending
// Approving a request releases its reservation and posts the usage in ONE
// transaction guarded by row_version, so retries and concurrent clicks cannot
// double-deduct. Off-site work uses its own monthly quota and never touches
// leave balances.
import { tx, uid, now, J, P, audit, bad, conflict, forbid, notFound } from '../db.js';
import { leaveAccess, currentEmployment, canViewBalances, isOps } from './authz.js';
import { eachDay, weekday, isISODate, daysBetween, todayIn } from './dates.js';
import { fmtX100 } from './decimal.js';

export const POSTED_KINDS = ['opening', 'grant', 'accrual', 'carryover', 'expiry', 'usage', 'reversal', 'adjustment'];
const PORTIONS = { full: 100, am: 50, pm: 50 };

// Candidate settings transcribed from the handbook / LeaveBoard. Every value
// is AWAITING GB CONFIRMATION until a policy version is approved.
export const CANDIDATE_POLICY = {
  workweek: [0, 1, 2, 3, 4], // Sun–Thu (LeaveBoard attendance shows Fri/Sat off)
  workday: { start: '09:00', end: '17:30' }, // GB confirmed 19 Nov 2026 (legal end 18:00; 30 min of break given back)
  hoursPerDay: 8,
  leaveNoticeDays: 14, // handbook: 14 days' advance notice for leave
  noticeAppliesTo: ['AV'],
  annualEntitlementDays: 14, // GB decided 24 Nov 2026: 14 days a year for everyone, new joiners included
  carryover: { maxDays: null, expiresOn: null }, // GB decided 24 Nov 2026: all unused days carry into the next year (no cap set, no expiry set)
  offsite: { monthlyQuota: 4, requiresPostProbation: true, noticeDays: 1 },
  projectCoverageCheck: true,
  allowNegative: ['COO'], // vendor shows negative COO availability for 2 people — CONFIRM
  requireApprovedPolicy: false, // set true in production: blocks requests until GB approves
};

export function activePolicy(db, tenantId, onDate) {
  const row = db.prepare(`SELECT * FROM policy_versions WHERE tenant_id = ? AND effective_from <= ?
      AND (effective_to IS NULL OR effective_to >= ?) AND status IN ('approved','awaiting_confirmation')
      ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, version DESC LIMIT 1`).get(tenantId, onDate, onDate);
  if (!row) return { version: null, status: 'missing', settings: CANDIDATE_POLICY };
  return { version: row.version, status: row.status, settings: { ...CANDIDATE_POLICY, ...P(row.settings_json, {}) } };
}

export function holidaysFor(db, tenantId, calendar, from, to) {
  return new Map(db.prepare('SELECT date, name FROM holidays WHERE tenant_id = ? AND calendar = ? AND date BETWEEN ? AND ?')
    .all(tenantId, calendar, from, to).map((h) => [h.date, h.name]));
}

/** Chargeable units for a date range, with a per-day explanation. */
export function chargeableDays({ start, end, startPortion = 'full', endPortion = 'full', workweek, holidays = new Map() }) {
  if (!isISODate(start) || !isISODate(end)) throw bad('Dates must be yyyy-mm-dd');
  if (end < start) throw bad('End date is before start date');
  if (!(startPortion in PORTIONS) || !(endPortion in PORTIONS)) throw bad('Portion must be full, am or pm');
  if (start === end && startPortion !== endPortion && startPortion !== 'full' && endPortion !== 'full') throw bad('For a single day choose one portion');
  const days = []; const byYear = {}; let total = 0;
  for (const d of eachDay(start, end)) {
    let charge = 0; let note;
    if (!workweek.includes(weekday(d))) note = 'Weekend';
    else if (holidays.has(d)) note = `Public holiday: ${holidays.get(d)}`;
    else {
      const portion = d === start ? startPortion : d === end ? endPortion : 'full';
      charge = PORTIONS[portion];
      note = portion === 'full' ? 'Working day' : `Half day (${portion.toUpperCase()})`;
    }
    days.push({ date: d, charge_x100: charge, note });
    if (charge) { const y = d.slice(0, 4); byYear[y] = (byYear[y] || 0) + charge; total += charge; }
  }
  return { total_x100: total, byYear, days };
}

export function balance(db, tenantId, userId, typeId, year) {
  const rows = db.prepare('SELECT kind, SUM(amount_x100) s FROM leave_ledger WHERE tenant_id = ? AND user_id = ? AND type_id = ? AND period_year = ? GROUP BY kind')
    .all(tenantId, userId, typeId, year);
  const by = Object.fromEntries(rows.map((r) => [r.kind, r.s]));
  const posted = POSTED_KINDS.reduce((a, k) => a + (by[k] || 0), 0);
  const pending = (by.reservation || 0) + (by.reservation_release || 0);
  return { posted_x100: posted, pending_x100: pending, projected_x100: posted + pending, by_kind: by };
}

export function balancesForUser(db, actor, userId, year) {
  if (!canViewBalances(db, actor, userId)) throw forbid();
  const types = db.prepare('SELECT * FROM leave_types WHERE tenant_id = ? AND active = 1 ORDER BY category, name').all(actor.tenantId);
  return types.map((t) => ({ type: t.code, name: t.name, category: t.category, tracks_balance: !!t.tracks_balance,
    ...balance(db, actor.tenantId, userId, t.id, year) }));
}

function ledger(db, e) {
  // INSERT OR IGNORE + unique entry_key = idempotent posting
  const r = db.prepare(`INSERT OR IGNORE INTO leave_ledger (tenant_id, user_id, type_id, period_year, kind, amount_x100, effective_date, request_id, note, actor_id, entry_key, batch_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(e.tenantId, e.userId, e.typeId, e.year, e.kind, e.amount, e.date, e.requestId ?? null,
    e.note ?? null, e.actorId ?? null, e.key, e.batchId ?? null, now());
  return r.changes === 1;
}
export { ledger as postLedger };

// ------------------------------------------------------------- requests ----
export function previewRequest(db, actor, input) { return evaluate(db, actor, input, { dryRun: true }); }

const settingOf = (db, tenantId, key) => { const r = db.prepare('SELECT value_json FROM settings WHERE tenant_id = ? AND key = ?').get(tenantId, key); return r ? P(r.value_json, null) : null; };

/** Is this person away (approved, non off-site leave) on the given day? */
export function isAway(db, tenantId, userId, day = todayIn()) {
  return !!db.prepare(`SELECT 1 FROM leave_requests r JOIN leave_types t ON t.id = r.type_id WHERE r.tenant_id = ? AND r.user_id = ? AND r.state = 'approved'
      AND t.category NOT IN ('offsite','client') AND r.start_date <= ? AND r.end_date >= ?`).get(tenantId, userId, day, day);
}
/** Backup approver sees a request once the approver is away or it has waited this many days (default 2). */
export const escalateDays = (db, tenantId) => Number(settingOf(db, tenantId, 'leave_escalate_days') ?? 2);
export function waitingForBackup(db, tenantId, r, day = todayIn()) {
  if (isAway(db, tenantId, r.approver_id, day)) return 'approver away';
  const waited = Math.floor((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${r.created_at.slice(0, 10)}T00:00:00Z`)) / 864e5);
  return waited >= escalateDays(db, tenantId) ? `waiting ${waited} days` : null;
}

/** LeaveBoard → Prism switch-over: requests open only once opening balances are posted at the cutover date. */
export function leaveStatus(db, tenantId) {
  const cutover = settingOf(db, tenantId, 'leave_cutover');
  // live only once opening balances were posted AT the cutover date (not any older test posting)
  const live = !cutover || !!db.prepare("SELECT 1 FROM leave_ledger WHERE tenant_id = ? AND kind = 'opening' AND effective_date = ? LIMIT 1").get(tenantId, cutover);
  const approverId = settingOf(db, tenantId, 'leave_approver');
  const approver = approverId ? db.prepare('SELECT name FROM users WHERE id = ?').get(approverId)?.name ?? null : null;
  return { cutover, live, approver };
}

function evaluate(db, actor, { userId = actor.id, typeCode, start, end, startPortion = 'full', endPortion = 'full', coverUserId, exceptionReason }) {
  const type = db.prepare('SELECT * FROM leave_types WHERE tenant_id = ? AND code = ? AND active = 1').get(actor.tenantId, typeCode);
  if (!type) throw bad('Unknown request type');
  const emp = currentEmployment(db, userId, start) || currentEmployment(db, userId);
  if (!emp) throw bad('No employment record for this person — ask People Ops');
  const pol = activePolicy(db, actor.tenantId, start);
  const s = pol.settings;
  if (s.requireApprovedPolicy && pol.status !== 'approved') throw bad('Time-off policy is awaiting GB approval; requests are not yet open');
  if (!type.allow_partial && (startPortion !== 'full' || endPortion !== 'full')) throw bad(`${type.name} must be taken in full days`);
  const hol = holidaysFor(db, actor.tenantId, emp.country, start, end);
  const calc = chargeableDays({ start, end, startPortion, endPortion, workweek: s.workweek, holidays: hol });
  if (calc.total_x100 === 0) throw bad('The selected dates contain no working days');

  const blocking = []; const warnings = [];
  const today = todayIn();
  // overlap with own open requests (half days may share a date only if AM vs PM)
  const mine = db.prepare(`SELECT r.*, t.name tname FROM leave_requests r JOIN leave_types t ON t.id = r.type_id WHERE r.tenant_id = ? AND r.user_id = ?
      AND r.state IN ('submitted','approved') AND r.start_date <= ? AND r.end_date >= ?`).all(actor.tenantId, userId, end, start);
  for (const o of mine) {
    const clash = calc.days.some((d) => d.charge_x100 && d.date >= o.start_date && d.date <= o.end_date && !halvesCompatible(d.date, { start, end, startPortion, endPortion }, o));
    if (clash) blocking.push(`Overlaps your ${o.state} ${o.tname} request ${o.start_date} → ${o.end_date}`);
  }
  // notice and retroactive rules
  const lead = daysBetween(today, start);
  if (start < today) (exceptionReason ? warnings : blocking).push(`Retroactive request (starts ${start}) — needs an approved exception`);
  const noticeDays = type.category === 'offsite' ? s.offsite.noticeDays : (s.noticeAppliesTo.includes(type.code) ? s.leaveNoticeDays : 0);
  if (start >= today && lead < noticeDays) (exceptionReason ? warnings : blocking).push(`Less than ${noticeDays} days' notice (${lead} days) — needs an approved exception`);

  let projected = null;
  if (type.category === 'offsite') {
    if (s.offsite.requiresPostProbation && emp.probation_end && start <= emp.probation_end) blocking.push(`Off-site work is available after probation (ends ${emp.probation_end})`);
    // monthly quota counted separately from leave balances
    const perMonth = {};
    for (const d of calc.days) if (d.charge_x100) perMonth[d.date.slice(0, 7)] = (perMonth[d.date.slice(0, 7)] || 0) + d.charge_x100;
    for (const [m, add] of Object.entries(perMonth)) {
      const used = offsiteUsed(db, actor.tenantId, userId, m, type.id);
      if (used + add > s.offsite.monthlyQuota * 100) (exceptionReason ? warnings : blocking).push(`Off-site quota for ${m}: ${fmtX100(used)} used + ${fmtX100(add)} requested > ${s.offsite.monthlyQuota} days`);
    }
  } else if (type.tracks_balance) {
    projected = {};
    for (const [y, amt] of Object.entries(calc.byYear)) {
      const b = balance(db, actor.tenantId, userId, type.id, Number(y));
      projected[y] = { before_x100: b.projected_x100, after_x100: b.projected_x100 - amt };
      if (b.projected_x100 - amt < 0) (s.allowNegative.includes(type.code) ? warnings : blocking).push(`${type.name} ${y}: balance would be ${fmtX100(b.projected_x100 - amt)}`);
    }
  }
  if (type.requires_cover && !coverUserId) blocking.push('Name a colleague covering your work');
  if (s.projectCoverageCheck) warnings.push(...coverageWarnings(db, actor.tenantId, userId, start, end));

  const st = leaveStatus(db, actor.tenantId);
  if (!st.live) blocking.push(`Time off moves to Prism after the LeaveBoard cutover on ${st.cutover}. Until then, keep using LeaveBoard.`);
  // one approver for everyone (GB decision); their own requests go to their manager / backup
  const central = settingOf(db, actor.tenantId, 'leave_approver');
  let approverId = emp.manager_id; let backupId = emp.backup_approver_id;
  if (central && central !== userId) {
    // backup when the approver is away: the person's own manager/backup, else the approver's manager
    backupId = [emp.manager_id, emp.backup_approver_id, currentEmployment(db, central)?.manager_id].find((x) => x && x !== central && x !== userId) ?? null;
    approverId = central;
  }
  if (approverId === userId) { approverId = backupId; backupId = null; }
  if (!approverId || approverId === userId) blocking.push('No approver configured — ask People Ops');
  const pm = projectManagerFor(db, actor.tenantId, userId, start, end, approverId);
  return { type, emp, policy: { version: pol.version, status: pol.status }, calc, blocking, warnings, projected, approverId, backupId, pm };
}

function halvesCompatible(date, req, other) {
  const a = date === req.start ? req.startPortion : date === req.end ? req.endPortion : 'full';
  const b = date === other.start_date ? other.start_portion : date === other.end_date ? other.end_portion : 'full';
  return (a === 'am' && b === 'pm') || (a === 'pm' && b === 'am');
}

function offsiteUsed(db, tenantId, userId, month, typeId, excludeId = null) {
  const rows = db.prepare(`SELECT id, breakdown_json FROM leave_requests WHERE tenant_id = ? AND user_id = ? AND type_id = ?
      AND state IN ('submitted','approved') AND substr(start_date,1,7) <= ? AND substr(end_date,1,7) >= ?`).all(tenantId, userId, typeId, month, month);
  let n = 0;
  for (const r of rows) if (r.id !== excludeId) for (const d of P(r.breakdown_json).days) if (d.date.startsWith(month)) n += d.charge_x100;
  return n;
}

function coverageWarnings(db, tenantId, userId, start, end) {
  const out = [];
  const asg = db.prepare(`SELECT pa.project_id, p.name, p.lead_user_id FROM project_assignments pa JOIN projects p ON p.id = pa.project_id
      WHERE pa.tenant_id = ? AND pa.user_id = ? AND pa.status = 'confirmed' AND (pa.start_date IS NULL OR pa.start_date <= ?) AND (pa.end_date IS NULL OR pa.end_date >= ?)`).all(tenantId, userId, end, start);
  for (const a of asg) {
    const team = db.prepare(`SELECT DISTINCT u.name FROM project_assignments pa JOIN users u ON u.id = pa.user_id JOIN leave_requests r ON r.user_id = pa.user_id
        JOIN leave_types t ON t.id = r.type_id
        WHERE pa.project_id = ? AND pa.status = 'confirmed' AND pa.user_id != ? AND r.state IN ('submitted','approved') AND t.category = 'leave'
        AND r.start_date <= ? AND r.end_date >= ?`).all(a.project_id, userId, end, start);
    if (team.length) out.push(`Project coverage on ${a.name}: ${team.map((t) => t.name).join(', ')} also away in this period`);
    if (a.lead_user_id === userId) out.push(`You lead ${a.name}; confirm cover for client-facing work`);
  }
  return out;
}

/**
 * GB decision (25 Nov 2026): if the person works on a running project during the leave, that project's
 * lead approves first, then the request goes to GB's leave approver. The lead of the project with the
 * longest overlap is chosen; nobody approves their own request.
 */
export function projectManagerFor(db, tenantId, userId, start, end, finalApprover) {
  const rows = db.prepare(`SELECT p.id, p.name, p.lead_user_id, a.start_date, a.end_date FROM project_assignments a JOIN projects p ON p.id = a.project_id
      WHERE a.user_id = ? AND p.tenant_id = ? AND p.kind = 'engagement' AND p.status = 'active' AND p.register_status != 'archived'
        AND a.status IN ('confirmed','tentative','historical') AND p.lead_user_id IS NOT NULL AND p.lead_user_id NOT IN (?, ?)
        AND (a.start_date IS NULL OR a.start_date <= ?) AND (a.end_date IS NULL OR a.end_date >= ?)`).all(userId, tenantId, userId, finalApprover || '', end, start);
  if (!rows.length) return null;
  const overlap = (r) => { const a = r.start_date && r.start_date > start ? r.start_date : start; const b = r.end_date && r.end_date < end ? r.end_date : end; return Date.parse(b) - Date.parse(a); };
  const best = rows.sort((x, y) => overlap(y) - overlap(x) || x.name.localeCompare(y.name))[0];
  const u = db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').get(best.lead_user_id);
  return u ? { id: u.id, name: u.name, project_id: best.id, project: best.name } : null;
}

export function submitRequest(db, actor, input) {
  return tx(db, () => {
    if (input.userId && input.userId !== actor.id) throw forbid('Requests are submitted by the employee');
    if (input.clientKey) {
      const ex = db.prepare('SELECT * FROM leave_requests WHERE tenant_id = ? AND user_id = ? AND client_key = ?').get(actor.tenantId, actor.id, input.clientKey);
      if (ex) return ex; // safe retry
    }
    const ev = evaluate(db, actor, input);
    if (ev.blocking.length) throw bad('This request cannot be submitted', ev.blocking);
    const id = uid('lr_');
    db.prepare(`INSERT INTO leave_requests (id, tenant_id, user_id, type_id, start_date, end_date, start_portion, end_portion, chargeable_x100, breakdown_json,
        reason, cover_user_id, handover, state, approver_id, backup_approver_id, policy_version, warnings_json, exception_json, client_key, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'submitted',?,?,?,?,?,?,?)`).run(id, actor.tenantId, actor.id, ev.type.id, input.start, input.end,
      input.startPortion || 'full', input.endPortion || 'full', ev.calc.total_x100, J(ev.calc), input.reason ?? null, input.coverUserId ?? null,
      input.handover ?? null, ev.approverId, ev.backupId, ev.policy.version, J(ev.warnings), input.exceptionReason ? J({ reason: input.exceptionReason, approved: false }) : null,
      input.clientKey ?? null, now());
    if (ev.pm) db.prepare("UPDATE leave_requests SET stage = 'pm', pm_id = ?, pm_project_id = ? WHERE id = ?").run(ev.pm.id, ev.pm.project_id, id);
    if (ev.type.tracks_balance && ev.type.category !== 'offsite') {
      for (const [y, amt] of Object.entries(ev.calc.byYear)) ledger(db, { tenantId: actor.tenantId, userId: actor.id, typeId: ev.type.id, year: Number(y), kind: 'reservation', amount: -amt, date: input.start, requestId: id, actorId: actor.id, key: `res:${id}:${y}` });
    }
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'leave.submit', entity: 'leave_request', entityId: id, after: { type: ev.type.code, start: input.start, end: input.end, units: ev.calc.total_x100 } });
    return db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
  });
}

export function decideRequest(db, actor, id, { decision, note, rowVersion, approveException = false }) {
  if (!['approve', 'decline'].includes(decision)) throw bad('Decision must be approve or decline');
  return tx(db, () => {
    const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
    if (!r) throw notFound();
    const acc = leaveAccess(db, actor, r);
    if (!acc || acc.relation === 'self') throw forbid(acc?.relation === 'self' ? 'You cannot approve your own request' : undefined);
    if (acc.relation !== 'approver' && acc.relation !== 'pm') throw forbid('Only the assigned approver or backup can decide');
    if (acc.relation === 'pm' && r.stage !== 'pm') throw conflict('The project manager has already decided — it is with the final approver now');
    // step 1: the project manager approves → the request moves on to GB's approver (nothing is booked yet)
    if (r.stage === 'pm' && acc.relation === 'pm' && decision === 'approve') {
      if (r.state !== 'submitted') throw conflict(`Request is already ${r.state}`);
      if (rowVersion !== undefined && Number(rowVersion) !== r.row_version) throw conflict('Request changed since you opened it');
      db.prepare("UPDATE leave_requests SET stage = 'final', pm_decided_by = ?, pm_decided_at = ?, pm_note = ?, row_version = row_version + 1 WHERE id = ?").run(actor.id, now(), note ?? null, id);
      audit(db, { tenantId: r.tenant_id, actorId: actor.id, action: 'leave.pm_approved', entity: 'leave_request', entityId: id, reason: note });
      return db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
    }
    if (acc.relation === 'pm') db.prepare('UPDATE leave_requests SET pm_decided_by = ?, pm_decided_at = ?, pm_note = ? WHERE id = ?').run(actor.id, now(), note ?? null, id);
    const target = decision === 'approve' ? 'approved' : 'declined';
    if (r.state === target && r.decided_by === actor.id) return r; // idempotent retry
    if (r.state !== 'submitted') throw conflict(`Request is already ${r.state}`);
    if (rowVersion !== undefined && Number(rowVersion) !== r.row_version) throw conflict('Request changed since you opened it');
    const exc = P(r.exception_json);
    if (decision === 'approve' && exc && !approveException) throw bad('This request needs an exception — confirm you approve the exception', [exc.reason]);
    if (decision === 'decline' && !String(note || '').trim()) throw bad('Give a short reason when declining');
    const u = db.prepare(`UPDATE leave_requests SET state = ?, decided_by = ?, decided_at = ?, decision_note = ?, exception_json = ?, row_version = row_version + 1
        WHERE id = ? AND state = 'submitted' AND row_version = ?`).run(target, actor.id, now(), note ?? null,
      exc ? J({ ...exc, approved: decision === 'approve', approved_by: actor.id }) : null, id, r.row_version);
    if (u.changes !== 1) throw conflict('Request changed in the meantime');
    const type = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(r.type_id);
    const byYear = P(r.breakdown_json).byYear;
    if (type.tracks_balance && type.category !== 'offsite') {
      for (const [y, amt] of Object.entries(byYear)) {
        ledger(db, { tenantId: r.tenant_id, userId: r.user_id, typeId: r.type_id, year: Number(y), kind: 'reservation_release', amount: amt, date: r.start_date, requestId: id, actorId: actor.id, key: `rel:${id}:${y}` });
        if (decision === 'approve') ledger(db, { tenantId: r.tenant_id, userId: r.user_id, typeId: r.type_id, year: Number(y), kind: 'usage', amount: -amt, date: r.start_date, requestId: id, actorId: actor.id, key: `use:${id}:${y}` });
      }
    }
    audit(db, { tenantId: r.tenant_id, actorId: actor.id, action: `leave.${target}`, entity: 'leave_request', entityId: id, reason: note, before: { state: r.state }, after: { state: target } });
    return db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
  });
}

/** Employee withdraws a pending request or cancels a future approved one; approver/ops can cancel later with a reason. */
export function cancelRequest(db, actor, id, { reason } = {}) {
  return tx(db, () => {
    const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
    if (!r) throw notFound();
    const acc = leaveAccess(db, actor, r);
    if (!acc) throw forbid();
    const today = todayIn();
    if (r.state === 'withdrawn' || r.state === 'cancelled') return r;
    if (!['submitted', 'approved'].includes(r.state)) throw conflict(`Request is ${r.state}`);
    if (acc.relation === 'self' && r.state === 'approved' && r.start_date <= today) throw forbid('This leave has started; ask your approver to cancel it');
    if (acc.relation !== 'self' && !String(reason || '').trim()) throw bad('A reason is required');
    if (acc.relation === 'ops' && !isOps(actor)) throw forbid();
    if (acc.relation === 'pm') throw forbid('Only GB’s approver or People Ops can cancel a request');
    const to = r.state === 'submitted' ? 'withdrawn' : 'cancelled';
    const u = db.prepare('UPDATE leave_requests SET state = ?, decision_note = COALESCE(?, decision_note), row_version = row_version + 1 WHERE id = ? AND row_version = ?')
      .run(to, reason ?? null, id, r.row_version);
    if (u.changes !== 1) throw conflict('Request changed in the meantime');
    const type = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(r.type_id);
    const byYear = P(r.breakdown_json).byYear;
    if (type.tracks_balance && type.category !== 'offsite') {
      for (const [y, amt] of Object.entries(byYear)) {
        if (r.state === 'submitted') ledger(db, { tenantId: r.tenant_id, userId: r.user_id, typeId: r.type_id, year: Number(y), kind: 'reservation_release', amount: amt, date: r.start_date, requestId: id, actorId: actor.id, key: `rel:${id}:${y}` });
        else {
          // reverse whatever deduction actually exists for this request (Prism usage, or an imported booking already reflected in the opening balance)
          const posted = db.prepare("SELECT COALESCE(SUM(amount_x100),0) s FROM leave_ledger WHERE request_id = ? AND period_year = ? AND kind IN ('usage','reversal')").get(id, Number(y)).s;
          const committedInOpening = r.source !== 'prism' && P(r.exception_json)?.reflected_in_opening;
          const amount = posted < 0 ? -posted : committedInOpening ? amt : 0;
          if (amount) ledger(db, { tenantId: r.tenant_id, userId: r.user_id, typeId: r.type_id, year: Number(y), kind: 'reversal', amount, date: today, requestId: id, actorId: actor.id, note: reason, key: `rev:${id}:${y}` });
        }
      }
    }
    audit(db, { tenantId: r.tenant_id, actorId: actor.id, action: `leave.${to}`, entity: 'leave_request', entityId: id, reason, before: { state: r.state }, after: { state: to } });
    return db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
  });
}

export function adjustBalance(db, actor, { userId, typeCode, year, amountX100, note }) {
  if (!isOps(actor)) throw forbid();
  if (!String(note || '').trim()) throw bad('Adjustments need an annotation');
  if (!Number.isInteger(amountX100) || amountX100 === 0) throw bad('Amount must be a non-zero number of hundredths');
  return tx(db, () => {
    const t = db.prepare('SELECT * FROM leave_types WHERE tenant_id = ? AND code = ?').get(actor.tenantId, typeCode);
    if (!t) throw bad('Unknown type');
    const u = db.prepare('SELECT id FROM users WHERE id = ? AND tenant_id = ?').get(userId, actor.tenantId);
    if (!u) throw notFound();
    const before = balance(db, actor.tenantId, userId, t.id, year);
    ledger(db, { tenantId: actor.tenantId, userId, typeId: t.id, year, kind: 'adjustment', amount: amountX100, date: todayIn(), actorId: actor.id, note, key: `adj:${uid()}` });
    const after = balance(db, actor.tenantId, userId, t.id, year);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'balance.adjust', entity: 'user', entityId: userId, reason: note, before: { type: typeCode, year, posted: before.posted_x100 }, after: { posted: after.posted_x100 } });
    return after;
  });
}

/** Annual entitlement for a year, per person (GB decision E). Idempotent per user/type/year. */
export function grantEntitlements(db, actor, { year, typeCode = 'AV', rows, note }) {
  if (!isOps(actor)) throw forbid();
  if (!Number.isInteger(year)) throw bad('Year required');
  return tx(db, () => {
    const t = db.prepare('SELECT * FROM leave_types WHERE tenant_id = ? AND code = ?').get(actor.tenantId, typeCode);
    if (!t) throw bad('Unknown type');
    const out = [];
    for (const r of rows) {
      const u = db.prepare('SELECT id, name FROM users WHERE id = ? AND tenant_id = ? AND active = 1').get(r.userId, actor.tenantId);
      if (!u) throw bad(`Unknown person ${r.userId}`);
      const amt = Math.round(Number(r.days) * 100);
      if (!(amt > 0)) throw bad(`${u.name}: entitlement must be more than 0 days`);
      const made = ledger(db, { tenantId: actor.tenantId, userId: u.id, typeId: t.id, year, kind: 'grant', amount: amt, date: `${year}-01-01`, actorId: actor.id, note: note || `${year} entitlement`, key: `grant:${u.id}:${t.id}:${year}` });
      out.push({ userId: u.id, name: u.name, days_x100: amt, created: made });
    }
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'balance.grant', entity: 'leave_type', entityId: t.id, reason: note, after: { year, people: out.length, created: out.filter((x) => x.created).length } });
    return out;
  });
}

/** Carry unused AV into next year (capped) — idempotent per user/type/year. */
export function runCarryover(db, actor, { fromYear, typeCode = 'AV' }) {
  if (!isOps(actor)) throw forbid();
  return tx(db, () => {
    const t = db.prepare('SELECT * FROM leave_types WHERE tenant_id = ? AND code = ?').get(actor.tenantId, typeCode);
    const pol = activePolicy(db, actor.tenantId, `${fromYear + 1}-01-01`).settings;
    const users = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND active = 1').all(actor.tenantId);
    const out = [];
    for (const u of users) {
      const b = balance(db, actor.tenantId, u.id, t.id, fromYear);
      const cap = pol.carryover?.maxDays; // null = no cap
      const carry = Math.max(0, cap == null ? b.posted_x100 : Math.min(b.posted_x100, cap * 100));
      if (!carry) continue;
      const made = ledger(db, { tenantId: actor.tenantId, userId: u.id, typeId: t.id, year: fromYear + 1, kind: 'carryover', amount: carry, date: `${fromYear + 1}-01-01`, actorId: actor.id, note: `Carried from ${fromYear}`, key: `carry:${u.id}:${t.id}:${fromYear + 1}` });
      if (made) ledger(db, { tenantId: actor.tenantId, userId: u.id, typeId: t.id, year: fromYear, kind: 'adjustment', amount: -carry, date: `${fromYear}-12-31`, actorId: actor.id, note: `Carried to ${fromYear + 1}`, key: `carryout:${u.id}:${t.id}:${fromYear}` });
      out.push({ userId: u.id, carry_x100: carry, created: made });
    }
    return out;
  });
}

/** Expire carried-over days not used by the expiry date (carryover consumed first). */
export function runCarryoverExpiry(db, actor, { year, typeCode = 'AV', asOf }) {
  if (!isOps(actor)) throw forbid();
  return tx(db, () => {
    const t = db.prepare('SELECT * FROM leave_types WHERE tenant_id = ? AND code = ?').get(actor.tenantId, typeCode);
    const pol = activePolicy(db, actor.tenantId, `${year}-01-01`).settings;
    if (!pol.carryover?.expiresOn) return { expiry: null, expired: [] }; // no expiry set
    const expiry = `${year}-${pol.carryover.expiresOn}`;
    if ((asOf || todayIn()) <= expiry) return { expiry, expired: [] };
    const rows = db.prepare(`SELECT user_id, SUM(CASE WHEN kind='carryover' THEN amount_x100 ELSE 0 END) carry,
        SUM(CASE WHEN kind IN ('usage','reversal') AND effective_date <= ? THEN amount_x100 ELSE 0 END) used
        FROM leave_ledger WHERE tenant_id = ? AND type_id = ? AND period_year = ? GROUP BY user_id`).all(expiry, actor.tenantId, t.id, year);
    const expired = [];
    for (const r of rows) {
      const left = Math.max(0, r.carry + Math.min(0, r.used)); // usage is negative
      if (left > 0 && ledger(db, { tenantId: actor.tenantId, userId: r.user_id, typeId: t.id, year, kind: 'expiry', amount: -left, date: expiry, actorId: actor.id, note: `Unused carryover expired ${expiry}`, key: `exp:${r.user_id}:${t.id}:${year}` })) expired.push({ userId: r.user_id, expired_x100: left });
    }
    return { expiry, expired };
  });
}

// --------------------------------------------------------------- views ----
export function requestView(db, actor, r) {
  const acc = leaveAccess(db, actor, r);
  if (!acc) return null;
  const t = db.prepare('SELECT code, name, category FROM leave_types WHERE id = ?').get(r.type_id);
  const u = db.prepare('SELECT id, name FROM users WHERE id = ?').get(r.user_id);
  return { id: r.id, user: u, type: t, start_date: r.start_date, end_date: r.end_date, start_portion: r.start_portion, end_portion: r.end_portion,
    chargeable: fmtX100(r.chargeable_x100), breakdown: P(r.breakdown_json), state: r.state, warnings: P(r.warnings_json, []), exception: P(r.exception_json),
    reason: acc.viewReason ? r.reason : undefined, handover: acc.viewReason ? r.handover : undefined, cover_user_id: r.cover_user_id,
    approver_id: r.approver_id, decided_at: r.decided_at, decision_note: r.decision_note, row_version: r.row_version, can_decide: acc.decide, source: r.source, created_at: r.created_at,
    stage: r.stage, pm: r.pm_id ? { id: r.pm_id, name: db.prepare('SELECT name FROM users WHERE id = ?').get(r.pm_id)?.name, project: r.pm_project_id ? db.prepare('SELECT name FROM projects WHERE id = ?').get(r.pm_project_id)?.name : null,
      decided_at: r.pm_decided_at, note: r.pm_note } : null,
    can_cancel: ['submitted', 'approved'].includes(r.state) && ['approver', 'ops'].includes(acc.relation),
    approver_name: r.approver_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(r.approver_id)?.name : null };
}

/** Team calendar — availability only (no type of leave, reasons or balances). */
export function teamCalendar(db, actor, { from, to }) {
  const team = new Set([actor.id]);
  const mgr = currentEmployment(db, actor.id)?.manager_id;
  for (const e of db.prepare('SELECT user_id FROM employments WHERE tenant_id = ? AND (manager_id = ? OR manager_id = ?) AND effective_to IS NULL').all(actor.tenantId, actor.id, mgr ?? '')) team.add(e.user_id);
  for (const p of db.prepare(`SELECT DISTINCT b.user_id FROM project_assignments a JOIN project_assignments b ON a.project_id = b.project_id
      WHERE a.user_id = ? AND a.status = 'confirmed' AND b.status = 'confirmed'`).all(actor.id)) team.add(p.user_id);
  const ids = [...team];
  const rows = db.prepare(`SELECT r.user_id, u.name, r.start_date, r.end_date, r.start_portion, r.end_portion, r.state, t.category FROM leave_requests r
      JOIN users u ON u.id = r.user_id JOIN leave_types t ON t.id = r.type_id
      WHERE r.tenant_id = ? AND r.state IN ('approved','submitted') AND r.start_date <= ? AND r.end_date >= ? AND r.user_id IN (${ids.map(() => '?').join(',')})`)
    .all(actor.tenantId, to, from, ...ids);
  return rows.map((r) => ({ name: r.name, start_date: r.start_date, end_date: r.end_date, availability: r.category === 'offsite' ? 'Working off-site' : r.category === 'client' ? 'At client' : 'Away',
    tentative: r.state === 'submitted', half: r.start_portion !== 'full' || r.end_portion !== 'full' }));
}
