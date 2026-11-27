// Performance cycle (2027 onward): launch → goals → assignment kickoffs and project snapshots through the
// year → quarterly coaching → annual reflection → manager ratings → leadership calibration → BOTH founders
// approve → private release → acknowledgment or correction request → close. Amendments after release are
// audited and go back through founder approval.
//
// Who sees what (server-side, every call):
//   employee      — their own goals, kickoffs, shared snapshots, coaching notes and reflection; ratings,
//                   score and band only after release (i.e. after both founders approved)
//   review manager— their allocated people: everything except leadership notes and founder approvals
//   observer      — the snapshots they are asked to write
//   founders      — everything (Layan and Ghaith; the "founders" setting, else everyone with the partner role)
//   admin         — cycle progress only (states and counts), no ratings or notes
import { uid, now, audit, bad, forbid, notFound, conflict, J, P } from '../../db.js';
import { has, currentEmployment } from '../authz.js';
import { todayIn } from '../dates.js';
import { activePolicy, holidaysFor } from '../leave.js';
import { notify } from '../mailer.js';
import { DEFAULT_POLICY, computeScore, validatePolicy, addWorkingDays } from './policy.js';

const setting = (db, t, k) => { const r = db.prepare('SELECT value_json FROM settings WHERE tenant_id = ? AND key = ?').get(t, k); return r ? JSON.parse(r.value_json) : null; };
export function founders(db, tenantId) {
  const ids = setting(db, tenantId, 'founders');
  if (Array.isArray(ids) && ids.length) return ids;
  return db.prepare("SELECT DISTINCT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'partner' WHERE u.tenant_id = ? AND u.active = 1 ORDER BY u.name").all(tenantId).map((r) => r.id);
}
export const isFounder = (db, a) => founders(db, a.tenantId).includes(a.id) && has(a, 'partner');
const canSetup = (db, a) => isFounder(db, a) || has(a, 'admin');
const clip = (s, n = 2000) => (s == null ? null : String(s).trim().slice(0, n) || null);
const name = (db, id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || null : null);
const DIM_KEYS = (pol) => pol.dimensions.map((d) => d.key);
const isoMonth = (d) => Number(d.slice(5, 7));

// ------------------------------------------------------------------ policy --
export function currentPolicy(db, tenantId) {
  let p = db.prepare('SELECT * FROM perf_policies WHERE tenant_id = ? ORDER BY version DESC LIMIT 1').get(tenantId);
  if (!p) { db.prepare("INSERT INTO perf_policies (id, tenant_id, version, status, policy_json, created_at) VALUES (?,?,1,'draft',?,?)").run(uid('pol_'), tenantId, J(DEFAULT_POLICY), now()); p = db.prepare('SELECT * FROM perf_policies WHERE tenant_id = ? ORDER BY version DESC LIMIT 1').get(tenantId); }
  const approvals = db.prepare('SELECT founder_id, approved_at FROM perf_policy_approvals WHERE policy_id = ?').all(p.id).map((a) => ({ ...a, name: name(db, a.founder_id) }));
  const approved = db.prepare("SELECT id, version FROM perf_policies WHERE tenant_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1").get(tenantId);
  return { id: p.id, version: p.version, status: p.status, policy: P(p.policy_json), approvals, founders: founders(db, tenantId).map((id) => ({ id, name: name(db, id) })), approved_version: approved?.version ?? null };
}
export function savePolicy(db, actor, policy) {
  if (!canSetup(db, actor)) throw forbid();
  const errs = validatePolicy(policy); if (errs.length) throw bad(errs.join('; '));
  const cur = db.prepare('SELECT * FROM perf_policies WHERE tenant_id = ? ORDER BY version DESC LIMIT 1').get(actor.tenantId);
  if (cur && cur.status === 'draft') {
    db.prepare('UPDATE perf_policies SET policy_json = ? WHERE id = ?').run(J(policy), cur.id);
    db.prepare('DELETE FROM perf_policy_approvals WHERE policy_id = ?').run(cur.id); // a changed draft needs fresh approval
  } else db.prepare("INSERT INTO perf_policies (id, tenant_id, version, status, policy_json, created_by, created_at) VALUES (?,?,?, 'draft', ?,?,?)").run(uid('pol_'), actor.tenantId, (cur?.version || 0) + 1, J(policy), actor.id, now());
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'perf.policy_draft', entity: 'policy', entityId: 'latest' });
  return currentPolicy(db, actor.tenantId);
}
/** Each founder approves the draft; when all have, it becomes the approved policy. */
export function approvePolicy(db, actor) {
  if (!isFounder(db, actor)) throw forbid('Only the founders approve the performance policy');
  currentPolicy(db, actor.tenantId); // seeds the default draft on first use
  const cur = db.prepare("SELECT * FROM perf_policies WHERE tenant_id = ? AND status = 'draft' ORDER BY version DESC LIMIT 1").get(actor.tenantId);
  if (!cur) throw bad('No draft policy to approve');
  db.prepare('INSERT OR IGNORE INTO perf_policy_approvals (policy_id, founder_id, approved_at) VALUES (?,?,?)').run(cur.id, actor.id, now());
  const all = founders(db, actor.tenantId); const got = new Set(db.prepare('SELECT founder_id FROM perf_policy_approvals WHERE policy_id = ?').all(cur.id).map((r) => r.founder_id));
  if (all.every((f) => got.has(f))) {
    db.prepare("UPDATE perf_policies SET status = 'retired' WHERE tenant_id = ? AND status = 'approved'").run(actor.tenantId);
    db.prepare("UPDATE perf_policies SET status = 'approved' WHERE id = ?").run(cur.id);
  }
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'perf.policy_approve', entity: 'policy', entityId: cur.id });
  return currentPolicy(db, actor.tenantId);
}

// ------------------------------------------------------------------- cycle --
const splitTitle = (t = '') => { const [level, track] = String(t).split(/\s+[–-]\s+/); return { level: level || null, track: track || null }; };
function roleHistory(db, userId, year) {
  return db.prepare(`SELECT title, effective_from, effective_to FROM employments WHERE user_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from`)
    .all(userId, `${year}-12-31`, `${year}-01-01`).map((e) => ({ title: e.title, ...splitTitle(e.title), from: e.effective_from < `${year}-01-01` ? `${year}-01-01` : e.effective_from, to: e.effective_to }));
}
export function launchCycle(db, actor, { year, name: cname, dates = {}, userIds = null } = {}) {
  if (!canSetup(db, actor)) throw forbid();
  const y = Number(year); if (!(y >= 2026 && y <= 2100)) throw bad('Choose the year');
  const pol = db.prepare("SELECT * FROM perf_policies WHERE tenant_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1").get(actor.tenantId);
  if (!pol) throw bad('The founders must approve the performance policy before a cycle can start');
  if (db.prepare('SELECT 1 FROM perf_cycles WHERE tenant_id = ? AND year = ?').get(actor.tenantId, y)) throw conflict(`A ${y} cycle already exists`);
  for (const [k, v] of Object.entries(dates)) if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`${k} must be a date`);
  const id = uid('pcy_'); const t = now();
  db.prepare("INSERT INTO perf_cycles (id, tenant_id, year, name, policy_id, policy_frozen_json, status, dates_json, created_by, created_at) VALUES (?,?,?,?,?,?, 'goals', ?,?,?)")
    .run(id, actor.tenantId, y, clip(cname, 80) || `${y} performance cycle`, pol.id, pol.policy_json, J(dates), actor.id, t);
  const fs = new Set(founders(db, actor.tenantId));
  const people = userIds?.length ? userIds : db.prepare('SELECT id FROM users WHERE tenant_id = ? AND active = 1').all(actor.tenantId).map((u) => u.id).filter((u) => !fs.has(u));
  let n = 0;
  for (const u of people) {
    const e = currentEmployment(db, u); if (!e) continue;
    const { level, track } = splitTitle(e.title);
    db.prepare("INSERT INTO perf_reviews (id, tenant_id, cycle_id, user_id, manager_id, level, track, role_history_json, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?, 'goals', ?,?)")
      .run(uid('prv_'), actor.tenantId, id, u, e.manager_id || null, level, track, J(roleHistory(db, u, y)), t, t);
    notify(db, { tenantId: actor.tenantId, to: u, event: 'perf.launch', key: `${id}:${u}`, link: '#/performance', subject: `${y} performance cycle: agree your priorities`, text: `The ${y} performance cycle has started. Agree up to three priorities with your review manager — delivery, growth and firm contribution.` });
    n++;
  }
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'perf.launch', entity: 'cycle', entityId: id, after: { year: y, participants: n, policy_version: pol.version } });
  return { id, participants: n };
}
export function setCycleStage(db, actor, cycleId, stage) {
  if (!canSetup(db, actor)) throw forbid();
  const c = db.prepare('SELECT * FROM perf_cycles WHERE id = ? AND tenant_id = ?').get(cycleId, actor.tenantId); if (!c) throw notFound();
  if (stage === 'annual') {
    for (const r of db.prepare("SELECT * FROM perf_reviews WHERE cycle_id = ? AND state IN ('goals','in_year')").all(cycleId)) {
      db.prepare("UPDATE perf_reviews SET state = 'reflection', updated_at = ? WHERE id = ?").run(now(), r.id);
      notify(db, { tenantId: c.tenant_id, to: r.user_id, event: 'perf.reflection', key: `${cycleId}:${r.user_id}`, link: '#/performance', subject: `${c.year} annual review: your reflection`, text: 'Your annual review is open. Write one short reflection: up to three accomplishments with evidence, one growth area and the responsibility you would like next.' });
    }
  } else if (!['in_year', 'closed'].includes(stage)) throw bad('Unknown stage');
  if (stage === 'closed' && db.prepare("SELECT 1 FROM perf_reviews WHERE cycle_id = ? AND state NOT IN ('acknowledged','closed','released','correction')").get(cycleId)) throw bad('Some reviews are not released yet');
  if (stage === 'closed') db.prepare("UPDATE perf_reviews SET state = 'closed', closed_at = ? WHERE cycle_id = ? AND state != 'closed'").run(now(), cycleId);
  db.prepare('UPDATE perf_cycles SET status = ? WHERE id = ?').run(stage, cycleId);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: `perf.cycle_${stage}`, entity: 'cycle', entityId: cycleId });
  return { ok: true };
}

// ------------------------------------------------------------------ access --
function loadReview(db, actor, id) {
  const r = db.prepare('SELECT * FROM perf_reviews WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!r) throw notFound();
  const founder = isFounder(db, actor);
  const rel = { self: r.user_id === actor.id, manager: r.manager_id === actor.id && r.user_id !== actor.id, founder: founder && r.user_id !== actor.id, admin: has(actor, 'admin') };
  if (!rel.self && !rel.manager && !rel.founder && !rel.admin) throw notFound();
  const cycle = db.prepare('SELECT * FROM perf_cycles WHERE id = ?').get(r.cycle_id);
  return { r, rel, cycle, policy: P(cycle.policy_frozen_json) };
}
const expect = (r, ...states) => { if (!states.includes(r.state)) throw conflict(`Not possible while the review is at "${r.state}"`); };
const touch = (db, id) => db.prepare('UPDATE perf_reviews SET updated_at = ? WHERE id = ?').run(now(), id);

// ------------------------------------------------------------------- goals --
export function saveGoals(db, actor, reviewId, { goals = [], reason } = {}) {
  const { r, rel } = loadReview(db, actor, reviewId);
  if (!rel.self && !rel.manager && !rel.founder) throw forbid();
  if (goals.length > 3) throw bad('Up to three priorities');
  const kinds = new Set();
  for (const g of goals) { if (!['delivery', 'growth', 'contribution'].includes(g.kind)) throw bad('Priorities are delivery, growth or firm contribution'); if (kinds.has(g.kind)) throw bad('One priority of each kind'); kinds.add(g.kind); if (!clip(g.text)) throw bad('Write each priority'); }
  const agreed = !!r.goals_agreed_at;
  for (const g of goals) {
    const cur = db.prepare('SELECT * FROM perf_goals WHERE review_id = ? AND kind = ?').get(reviewId, g.kind);
    if (!agreed) {
      if (cur) db.prepare('UPDATE perf_goals SET text = ?, measure = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(clip(g.text, 400), clip(g.measure, 300), actor.id, now(), cur.id);
      else db.prepare('INSERT INTO perf_goals (id, review_id, kind, text, measure, updated_by, updated_at) VALUES (?,?,?,?,?,?,?)').run(uid('pgl_'), reviewId, g.kind, clip(g.text, 400), clip(g.measure, 300), actor.id, now());
    } else {
      // after agreement a change is a request; the review manager (or a founder) approves it — assignments move during the year
      if (!clip(reason, 300)) throw bad('Say why the priority changes (e.g. the assignment moved)');
      const gid = cur?.id || uid('pgl_');
      if (!cur) db.prepare("INSERT INTO perf_goals (id, review_id, kind, text, measure, status, updated_by, updated_at) VALUES (?,?,?,?,?, 'proposed', ?,?)").run(gid, reviewId, g.kind, clip(g.text, 400), clip(g.measure, 300), actor.id, now());
      const direct = rel.manager || rel.founder;
      db.prepare('INSERT INTO perf_goal_changes (id, goal_id, before_text, after_text, reason, requested_by, approved_by, status, at) VALUES (?,?,?,?,?,?,?,?,?)').run(uid('pgc_'), gid, cur?.text || null, clip(g.text, 400), clip(reason, 300), actor.id, direct ? actor.id : null, direct ? 'approved' : 'pending', now());
      if (direct) db.prepare("UPDATE perf_goals SET text = ?, measure = ?, status = 'active', updated_by = ?, updated_at = ? WHERE id = ?").run(clip(g.text, 400), clip(g.measure, 300), actor.id, now(), gid);
      else if (r.manager_id) notify(db, { tenantId: r.tenant_id, to: r.manager_id, event: 'perf.goal_change', key: `${gid}:${now()}`, link: `#/performance/review/${reviewId}`, subject: `Priority change to approve: ${actor.name}`, text: `${actor.name} proposed a change to a ${g.kind} priority.` });
    }
  }
  touch(db, reviewId);
  return { ok: true };
}
export function decideGoalChange(db, actor, changeId, { approve }) {
  const ch = db.prepare('SELECT c.*, g.review_id FROM perf_goal_changes c JOIN perf_goals g ON g.id = c.goal_id WHERE c.id = ?').get(changeId); if (!ch) throw notFound();
  const { rel } = loadReview(db, actor, ch.review_id); if (!rel.manager && !rel.founder) throw forbid();
  if (ch.status !== 'pending') throw bad('Already decided');
  db.prepare('UPDATE perf_goal_changes SET status = ?, approved_by = ? WHERE id = ?').run(approve ? 'approved' : 'declined', actor.id, changeId);
  if (approve) db.prepare("UPDATE perf_goals SET text = ?, status = 'active', updated_by = ?, updated_at = ? WHERE id = ?").run(ch.after_text, actor.id, now(), ch.goal_id);
  return { ok: true };
}
export function agreeGoals(db, actor, reviewId) {
  const { r, rel } = loadReview(db, actor, reviewId); expect(r, 'goals');
  if (!rel.manager && !rel.founder) throw forbid('The review manager agrees the priorities');
  if (!db.prepare('SELECT 1 FROM perf_goals WHERE review_id = ?').get(reviewId)) throw bad('Add at least one priority first');
  db.prepare("UPDATE perf_reviews SET state = 'in_year', goals_agreed_at = ?, goals_agreed_by = ?, updated_at = ? WHERE id = ?").run(now(), actor.id, now(), reviewId);
  return { ok: true };
}

// ----------------------------------------------------- assignment kickoffs --
export function kickoffCandidates(db, actor, userId) {
  const year = todayIn().slice(0, 4);
  return db.prepare(`SELECT a.id assignment_id, a.project_id, p.name project, a.role, a.start_date, a.end_date FROM project_assignments a JOIN projects p ON p.id = a.project_id
      WHERE a.user_id = ? AND a.status IN ('confirmed','tentative') AND p.kind = 'engagement' AND COALESCE(a.end_date, p.end_date, '9999') >= ?
        AND NOT EXISTS (SELECT 1 FROM perf_kickoffs k WHERE k.assignment_id = a.id)`).all(userId, `${year}-01-01`);
}
export function saveKickoff(db, actor, b = {}) {
  const userId = b.user_id || actor.id;
  const rev = db.prepare("SELECT r.id FROM perf_reviews r JOIN perf_cycles c ON c.id = r.cycle_id WHERE r.user_id = ? AND r.tenant_id = ? AND c.status != 'closed' ORDER BY c.year DESC LIMIT 1").get(userId, actor.tenantId);
  if (rev) { const { rel } = loadReview(db, actor, rev.id); if (!rel.self && !rel.manager && !rel.founder) throw forbid(); }
  else if (userId !== actor.id && !isFounder(db, actor)) throw forbid();
  let projectId = null;
  if (b.assignment_id) { const a = db.prepare('SELECT * FROM project_assignments WHERE id = ? AND user_id = ? AND tenant_id = ?').get(b.assignment_id, userId, actor.tenantId); if (!a) throw bad('Unknown assignment'); projectId = a.project_id; }
  else if (!clip(b.internal_title)) throw bad('Choose a project assignment, or name the internal assignment');
  if (!clip(b.owns)) throw bad('Say what the person owns (deliverable or responsibility)');
  if (!clip(b.good_looks_like)) throw bad('Say what good looks like');
  const id = b.id || uid('pko_'); const t = now();
  const vals = [userId, b.assignment_id || null, projectId, clip(b.internal_title, 120), clip(b.role, 80), clip(b.owns, 600), clip(b.good_looks_like, 600), clip(b.dependencies, 600), b.start_date || null, b.end_date || null];
  if (b.id) { if (!db.prepare('UPDATE perf_kickoffs SET user_id = ?, assignment_id = ?, project_id = ?, internal_title = ?, role = ?, owns = ?, good_looks_like = ?, dependencies = ?, start_date = ?, end_date = ?, updated_at = ? WHERE id = ? AND tenant_id = ?').run(...vals, t, b.id, actor.tenantId).changes) throw notFound(); }
  else db.prepare('INSERT INTO perf_kickoffs (user_id, assignment_id, project_id, internal_title, role, owns, good_looks_like, dependencies, start_date, end_date, id, tenant_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals, id, actor.tenantId, actor.id, t, t);
  return { id };
}
/** Deadlines on different assignments within two days of each other: flagged to the review manager. */
export function deadlineConflicts(db, userId) {
  const cards = db.prepare(`SELECT d.id, d.title, d.due_date, p.name project, d.project_id FROM deliverables d JOIN projects p ON p.id = d.project_id
      WHERE d.owner_id = ? AND d.status IN ('todo','in_progress','submitted') AND d.due_date >= ? ORDER BY d.due_date`).all(userId, todayIn());
  const out = [];
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i]; const b = cards[j];
    if (a.project_id === b.project_id) continue;
    if ((Date.parse(b.due_date) - Date.parse(a.due_date)) / 864e5 <= 2) out.push({ a: { title: a.title, project: a.project, due: a.due_date }, b: { title: b.title, project: b.project, due: b.due_date } });
  }
  return out;
}

// --------------------------------------------------------------- snapshots --
function observerFor(db, projectId, userId, reviewManager) {
  const p = projectId ? db.prepare('SELECT lead_user_id FROM projects WHERE id = ?').get(projectId) : null;
  return p?.lead_user_id && p.lead_user_id !== userId ? p.lead_user_id : reviewManager;
}
function dueFrom(db, tenantId, start, days) {
  const { settings } = activePolicy(db, tenantId, start);
  const hol = new Set(holidaysFor(db, tenantId, 'JO', start, addWorkingDays(start, days + 20, settings.workweek)).keys());
  return addWorkingDays(start, days, settings.workweek, hol);
}
/** Create a snapshot request unless one is open for the same person, project and observer, or the same trigger
 *  already produced one, or (not manual) one was written for that project in the last 30 days. */
export function ensureSnapshot(db, tenantId, { userId, projectId = null, kickoffId = null, observerId, trigger, ref = null, on = todayIn(), by = null }, pol = DEFAULT_POLICY) {
  if (!observerId || observerId === userId) return null;
  if (ref && db.prepare('SELECT 1 FROM perf_snapshots WHERE user_id = ? AND trigger = ? AND trigger_ref = ?').get(userId, trigger, ref)) return null;
  if (db.prepare("SELECT 1 FROM perf_snapshots WHERE user_id = ? AND COALESCE(project_id, '') = COALESCE(?, '') AND observer_id = ? AND status IN ('requested','draft')").get(userId, projectId, observerId)) return null;
  if (trigger !== 'manual' && projectId && db.prepare("SELECT 1 FROM perf_snapshots WHERE user_id = ? AND project_id = ? AND status = 'submitted' AND submitted_at >= ?").get(userId, projectId, new Date(Date.parse(`${on}T00:00:00Z`) - 30 * 864e5).toISOString())) return null;
  const id = uid('psn_'); const due = dueFrom(db, tenantId, on, pol.snapshot?.due_working_days ?? 5);
  db.prepare("INSERT INTO perf_snapshots (id, tenant_id, user_id, project_id, kickoff_id, observer_id, trigger, trigger_ref, triggered_on, due_on, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'requested', ?,?)")
    .run(id, tenantId, userId, projectId, kickoffId, observerId, trigger, ref, on, due, by, now());
  const who = name(db, userId); const proj = projectId ? db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId)?.name : 'an internal assignment';
  notify(db, { tenantId, to: observerId, event: 'perf.snapshot', key: id, link: `#/manager/performance?snapshot=${id}`, subject: `Short feedback on ${who}: ${proj}`, text: `Please write a short project snapshot for ${who} on ${proj} by ${due}: what they owned and delivered, one example and its impact, one development action.` });
  return id;
}
/** Daily: roll-offs, closures, milestones and the quarterly check on long engagements. Idempotent. */
export function runSnapshotTriggers(db, tenantId, today = todayIn()) {
  const cyc = db.prepare("SELECT * FROM perf_cycles WHERE tenant_id = ? AND status IN ('goals','in_year','annual') ORDER BY year DESC LIMIT 1").get(tenantId);
  if (!cyc) return 0;
  const pol = P(cyc.policy_frozen_json); let n = 0;
  const back = (d) => new Date(Date.parse(`${today}T00:00:00Z`) - d * 864e5).toISOString().slice(0, 10);
  for (const r of db.prepare("SELECT * FROM perf_reviews WHERE cycle_id = ? AND state NOT IN ('released','acknowledged','correction','closed')").all(cyc.id)) {
    // roll-off: the assignment ended in the last two weeks
    for (const a of db.prepare("SELECT id, project_id, end_date FROM project_assignments WHERE user_id = ? AND status IN ('confirmed','tentative','historical') AND end_date BETWEEN ? AND ?").all(r.user_id, back(14), back(1)))
      if (ensureSnapshot(db, tenantId, { userId: r.user_id, projectId: a.project_id, observerId: observerFor(db, a.project_id, r.user_id, r.manager_id), trigger: 'rolloff', ref: a.id, on: today }, pol)) n++;
    // closure: a project the person worked on was completed recently
    for (const p of db.prepare("SELECT DISTINCT p.id FROM projects p JOIN project_assignments a ON a.project_id = p.id WHERE a.user_id = ? AND p.status = 'completed' AND p.end_date BETWEEN ? AND ?").all(r.user_id, back(14), today))
      if (ensureSnapshot(db, tenantId, { userId: r.user_id, projectId: p.id, observerId: observerFor(db, p.id, r.user_id, r.manager_id), trigger: 'closure', ref: p.id, on: today }, pol)) n++;
    // material milestone: a deliverable with a milestone the person owned passed review this week
    for (const d of db.prepare("SELECT id, project_id FROM deliverables WHERE owner_id = ? AND milestone IS NOT NULL AND status IN ('ready','accepted') AND COALESCE(review_passed_at, updated_at, '') >= ?").all(r.user_id, back(7)))
      if (ensureSnapshot(db, tenantId, { userId: r.user_id, projectId: d.project_id, observerId: observerFor(db, d.project_id, r.user_id, r.manager_id), trigger: 'milestone', ref: d.id, on: today }, pol)) n++;
    // quarterly on long engagements: nothing written on this project for 90 days
    for (const a of db.prepare("SELECT DISTINCT a.project_id FROM project_assignments a JOIN projects p ON p.id = a.project_id WHERE a.user_id = ? AND a.status = 'confirmed' AND p.status = 'active' AND COALESCE(a.start_date, p.start_date, '9999') <= ? AND (a.end_date IS NULL OR a.end_date >= ?)").all(r.user_id, back(pol.snapshot?.quarterly_days ?? 90), today)) {
      const last = db.prepare("SELECT MAX(COALESCE(submitted_at, created_at)) m FROM perf_snapshots WHERE user_id = ? AND project_id = ? AND status != 'cancelled'").get(r.user_id, a.project_id).m;
      if (last && last.slice(0, 10) > back(pol.snapshot?.quarterly_days ?? 90)) continue;
      if (ensureSnapshot(db, tenantId, { userId: r.user_id, projectId: a.project_id, observerId: observerFor(db, a.project_id, r.user_id, r.manager_id), trigger: 'quarterly', ref: `${a.project_id}:${today.slice(0, 7)}`, on: today }, pol)) n++;
    }
  }
  return n;
}
export function requestSnapshot(db, actor, { user_id, project_id = null, observer_id }) {
  const rev = db.prepare("SELECT r.id FROM perf_reviews r JOIN perf_cycles c ON c.id = r.cycle_id WHERE r.user_id = ? AND r.tenant_id = ? AND c.status != 'closed' ORDER BY c.year DESC LIMIT 1").get(user_id, actor.tenantId);
  if (!rev) throw bad('This person is not in an open performance cycle');
  const { rel, policy } = loadReview(db, actor, rev.id); if (!rel.self && !rel.manager && !rel.founder) throw forbid();
  if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ? AND active = 1').get(observer_id, actor.tenantId)) throw bad('Choose who observed the work');
  const id = ensureSnapshot(db, actor.tenantId, { userId: user_id, projectId: project_id, observerId: observer_id, trigger: 'manual', ref: null, by: actor.id }, policy);
  if (!id) throw bad('That person already has an open snapshot request for this work');
  return { id };
}
const RATING = ['below', 'in_line', 'above', 'insufficient'];
export function saveSnapshot(db, actor, id, b = {}, { submit = false } = {}) {
  const s = db.prepare('SELECT * FROM perf_snapshots WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!s) throw notFound();
  if (s.observer_id !== actor.id) throw forbid('Only the person asked can write this snapshot');
  if (!['requested', 'draft'].includes(s.status)) throw conflict('Already submitted');
  if (b.rating && !RATING.includes(b.rating)) throw bad('Rating is below, in line, above or insufficient observation');
  const v = { owned: clip(b.owned ?? s.owned, 800), example: clip(b.example ?? s.example, 800), impact: clip(b.impact ?? s.impact, 600), development: clip(b.development ?? s.development, 600), rating: b.rating ?? s.rating };
  if (submit) { if (!v.rating) throw bad('Choose below, in line, above or insufficient observation'); if (v.rating !== 'insufficient' && (!v.owned || !v.example || !v.development)) throw bad('Fill what they owned, one example and one development action'); }
  db.prepare('UPDATE perf_snapshots SET owned = ?, example = ?, impact = ?, development = ?, rating = ?, status = ?, submitted_at = ? WHERE id = ?').run(v.owned, v.example, v.impact, v.development, v.rating, submit ? 'submitted' : 'draft', submit ? now() : null, id);
  if (submit) notify(db, { tenantId: s.tenant_id, to: s.user_id, event: 'perf.snapshot_shared', key: id, link: '#/performance', subject: `New feedback from ${actor.name}`, text: `${actor.name} shared a project snapshot with you. You can add context or ask for a correction.` });
  return { ok: true };
}
export function snapshotResponse(db, actor, id, { context, correction = false } = {}) {
  const s = db.prepare('SELECT * FROM perf_snapshots WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!s) throw notFound();
  if (s.user_id !== actor.id) throw forbid(); if (s.status !== 'submitted') throw conflict('Not shared yet');
  const c = clip(context, 800); if (!c) throw bad('Write your context or what should be corrected');
  db.prepare('UPDATE perf_snapshots SET employee_context = ?, correction_requested_at = ? WHERE id = ?').run(c, correction ? now() : s.correction_requested_at, id);
  if (correction) notify(db, { tenantId: s.tenant_id, to: s.observer_id, event: 'perf.snapshot_correction', key: `${id}:${now()}`, link: `#/manager/performance?snapshot=${id}`, subject: `Correction requested on your feedback for ${actor.name}`, text: `${actor.name} asked for a correction to the snapshot you wrote.` });
  return { ok: true };
}
/** The observer can reopen a submitted snapshot to correct it (e.g. after a correction request). */
export function reopenSnapshot(db, actor, id) {
  const s = db.prepare('SELECT * FROM perf_snapshots WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!s) throw notFound();
  if (s.observer_id !== actor.id) throw forbid();
  db.prepare("UPDATE perf_snapshots SET status = 'draft', submitted_at = NULL WHERE id = ?").run(id);
  return { ok: true };
}

// ---------------------------------------------------------------- coaching --
export function saveCoaching(db, actor, reviewId, b = {}) {
  const { r, rel, policy } = loadReview(db, actor, reviewId); if (!rel.manager && !rel.founder) throw forbid('The review manager records coaching');
  const month = Number(b.month); if (!(policy.coaching?.months || [3, 6, 9]).includes(month)) throw bad('Coaching is in the agreed months');
  if (!clip(b.strength) || !clip(b.improvement) || !clip(b.next_assignment)) throw bad('Write one strength, one improvement action and the next assignment or stretch responsibility');
  if (b.due_on && !/^\d{4}-\d{2}-\d{2}$/.test(b.due_on)) throw bad('Due date must be a date');
  db.prepare(`INSERT INTO perf_coaching (id, review_id, month, career, held_on, strength, improvement, next_assignment, owner_id, due_on, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(review_id, month) DO UPDATE SET held_on = excluded.held_on, strength = excluded.strength, improvement = excluded.improvement, next_assignment = excluded.next_assignment, owner_id = excluded.owner_id, due_on = excluded.due_on`)
    .run(uid('pco_'), reviewId, month, month === (policy.coaching?.career_month ?? 6) ? 1 : 0, b.held_on || todayIn(), clip(b.strength, 600), clip(b.improvement, 600), clip(b.next_assignment, 600), b.owner_id || r.user_id, b.due_on || null, actor.id, now());
  touch(db, reviewId);
  return { ok: true };
}

// ----------------------------------------------------------- annual review --
export function saveReflection(db, actor, reviewId, b = {}, { submit = false } = {}) {
  const { r, rel } = loadReview(db, actor, reviewId); if (!rel.self) throw forbid(); expect(r, 'reflection');
  const acc = (b.accomplishments || []).filter((a) => clip(a?.text)).slice(0, 3).map((a) => ({ text: clip(a.text, 600), link: /^https:\/\//.test(a.link || '') ? String(a.link).slice(0, 500) : null }));
  if ((b.accomplishments || []).filter((a) => clip(a?.text)).length > 3) throw bad('Up to three accomplishments');
  const v = { accomplishments: acc, growth: clip(b.growth, 600), next: clip(b.next, 600) };
  if (submit && (!acc.length || !v.growth || !v.next)) throw bad('Add at least one accomplishment, a growth area and the responsibility you want next');
  db.prepare('UPDATE perf_reviews SET reflection_json = ?, reflection_at = ?, state = ?, updated_at = ? WHERE id = ?').run(J(v), submit ? now() : null, submit ? 'manager' : 'reflection', now(), reviewId);
  if (submit && r.manager_id) notify(db, { tenantId: r.tenant_id, to: r.manager_id, event: 'perf.manager', key: reviewId, link: `#/performance/review/${reviewId}`, subject: `Annual review ready: ${actor.name}`, text: `${actor.name} submitted their reflection. Propose ratings with evidence for each dimension.` });
  return { ok: true };
}

/** Review manager proposes a rating for each dimension with evidence and rationale (or requests N/A / marks insufficient). */
export function saveRatings(db, actor, reviewId, { ratings = [] } = {}) {
  const { r, rel, policy } = loadReview(db, actor, reviewId);
  if (!rel.manager && !rel.founder) throw forbid(); expect(r, 'manager');
  const keys = DIM_KEYS(policy);
  for (const x of ratings) {
    if (!keys.includes(x.dimension)) throw bad('Unknown dimension');
    if (x.score != null && !(Number.isInteger(x.score) && x.score >= 1 && x.score <= 5)) throw bad('Scores are whole numbers 1–5');
    db.prepare(`INSERT INTO perf_ratings (review_id, dimension, proposed_score, evidence, rationale, insufficient, na_requested, na_reason, growth_action, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(review_id, dimension) DO UPDATE SET proposed_score = excluded.proposed_score, evidence = excluded.evidence, rationale = excluded.rationale, insufficient = excluded.insufficient,
          na_requested = excluded.na_requested, na_reason = excluded.na_reason, growth_action = excluded.growth_action, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(reviewId, x.dimension, x.score ?? null, clip(x.evidence, 1500), clip(x.rationale, 1000), x.insufficient ? 1 : 0, x.na ? 1 : 0, clip(x.na_reason, 300), clip(x.growth_action, 600), actor.id, now());
  }
  touch(db, reviewId);
  return { ok: true };
}
function ratingRows(db, reviewId) { return Object.fromEntries(db.prepare('SELECT * FROM perf_ratings WHERE review_id = ?').all(reviewId).map((x) => [x.dimension, x])); }
export function submitManager(db, actor, reviewId) {
  const { r, rel, policy } = loadReview(db, actor, reviewId); if (!rel.manager && !rel.founder) throw forbid(); expect(r, 'manager');
  const rows = ratingRows(db, reviewId); const gaps = [];
  for (const d of policy.dimensions) {
    const x = rows[d.key];
    if (!x) { gaps.push(`${d.label}: not rated`); continue; }
    if (x.na_requested) { if (!x.na_reason) gaps.push(`${d.label}: give the reason it does not apply`); continue; }
    if (x.insufficient) { if (!x.rationale) gaps.push(`${d.label}: say why evidence is insufficient`); continue; }
    if (x.proposed_score == null || !x.evidence || !x.rationale) gaps.push(`${d.label}: score, evidence and rationale are all needed`);
  }
  if (gaps.length) throw bad(gaps.join('; '));
  db.prepare("UPDATE perf_reviews SET state = 'calibration', manager_submitted_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), reviewId);
  for (const f of founders(db, r.tenant_id)) notify(db, { tenantId: r.tenant_id, to: f, event: 'perf.calibration', key: `${reviewId}:${f}`, link: '#/admin/calibration', subject: `Ready for calibration: ${name(db, r.user_id)}`, text: 'A manager review is ready for leadership calibration.' });
  return { ok: true };
}
/** Founder-approved N/A — only where the firm did not assign the work (e.g. no internal work for contribution). */
export function approveNa(db, actor, reviewId, dimension) {
  const { r } = loadReview(db, actor, reviewId); if (!isFounder(db, actor)) throw forbid('Only a founder approves not applicable'); expect(r, 'calibration');
  const x = db.prepare('SELECT * FROM perf_ratings WHERE review_id = ? AND dimension = ?').get(reviewId, dimension);
  if (!x?.na_requested) throw bad('Not applicable was not requested for this dimension');
  db.prepare('UPDATE perf_ratings SET na_approved_by = ? WHERE review_id = ? AND dimension = ?').run(actor.id, reviewId, dimension);
  return { ok: true };
}
/** Calibration: a founder sets the final score with a rationale; every change is kept. */
export function calibrate(db, actor, reviewId, { dimension, score, rationale }) {
  const { r, policy } = loadReview(db, actor, reviewId); if (!isFounder(db, actor)) throw forbid('Calibration is for the founders'); expect(r, 'calibration');
  if (!DIM_KEYS(policy).includes(dimension)) throw bad('Unknown dimension');
  if (!(Number.isInteger(score) && score >= 1 && score <= 5)) throw bad('Scores are whole numbers 1–5');
  if (!clip(rationale)) throw bad('Record the rationale for the change');
  const x = db.prepare('SELECT * FROM perf_ratings WHERE review_id = ? AND dimension = ?').get(reviewId, dimension); if (!x) throw bad('The manager has not rated this dimension');
  const from = x.final_score ?? x.proposed_score;
  db.prepare('UPDATE perf_ratings SET final_score = ?, insufficient = 0 WHERE review_id = ? AND dimension = ?').run(score, reviewId, dimension);
  db.prepare('INSERT INTO perf_rating_changes (id, review_id, dimension, stage, from_score, to_score, rationale, by_id, at) VALUES (?,?,?,?,?,?,?,?,?)').run(uid('prc_'), reviewId, dimension, 'calibration', from, score, clip(rationale, 1000), actor.id, now());
  audit(db, { tenantId: r.tenant_id, actorId: actor.id, action: 'perf.calibrate', entity: 'review', entityId: reviewId, after: { dimension } });
  return { ok: true };
}
function scoreOf(db, reviewId, policy) {
  const rows = ratingRows(db, reviewId);
  const input = Object.fromEntries(policy.dimensions.map((d) => { const x = rows[d.key] || {}; return [d.key, { score: x.final_score ?? x.proposed_score ?? null, na: !!(x.na_requested && x.na_approved_by), insufficient: !!x.insufficient }]; }));
  return { ...computeScore(policy, input), input };
}
/** Calibration done: the score is computed on the server and the review waits for every founder's approval. */
export function finishCalibration(db, actor, reviewId, { note, insufficientReason } = {}) {
  const { r, policy } = loadReview(db, actor, reviewId); if (!isFounder(db, actor)) throw forbid(); expect(r, 'calibration');
  const rows = ratingRows(db, reviewId);
  const unapproved = policy.dimensions.filter((d) => rows[d.key]?.na_requested && !rows[d.key]?.na_approved_by).map((d) => d.label);
  if (unapproved.length) throw bad(`Approve or reject not applicable first: ${unapproved.join(', ')}`);
  const s = scoreOf(db, reviewId, policy);
  if (s.status === 'pending') throw bad(`Missing ratings: ${s.missing.join(', ')}`);
  if (s.status === 'insufficient' && !clip(insufficientReason)) throw bad('Evidence is insufficient for a dimension: give the reason to close the review without a score, or calibrate that dimension');
  db.prepare("UPDATE perf_reviews SET state = 'approval', outcome = ?, insufficient_reason = ?, score_points = ?, band = ?, applied_weights_json = ?, calibrated_at = ?, leadership_note = COALESCE(?, leadership_note), version = version + 1, updated_at = ? WHERE id = ?")
    .run(s.status === 'scored' ? 'scored' : 'insufficient', s.status === 'insufficient' ? clip(insufficientReason, 500) : null, s.points, s.band, s.applied_weights ? J(s.applied_weights) : null, now(), clip(note, 1000), now(), reviewId);
  db.prepare('DELETE FROM perf_approvals WHERE review_id = ?').run(reviewId);
  return { ok: true, score: s.display, band: s.band };
}
/** Each founder confirms the exact version. Any later change raises the version and clears confirmations. */
export function founderApprove(db, actor, reviewId) {
  const { r } = loadReview(db, actor, reviewId); if (!isFounder(db, actor)) throw forbid('Only the founders confirm results'); expect(r, 'approval');
  db.prepare('INSERT INTO perf_approvals (review_id, founder_id, version, approved_at) VALUES (?,?,?,?) ON CONFLICT(review_id, founder_id) DO UPDATE SET version = excluded.version, approved_at = excluded.approved_at').run(reviewId, actor.id, r.version, now());
  audit(db, { tenantId: r.tenant_id, actorId: actor.id, action: 'perf.founder_approve', entity: 'review', entityId: reviewId, after: { version: r.version } });
  return approvalState(db, r);
}
function approvalState(db, r) {
  const need = founders(db, r.tenant_id);
  const got = db.prepare('SELECT founder_id, approved_at FROM perf_approvals WHERE review_id = ? AND version = ?').all(r.id, r.version);
  return { needed: need.map((id) => ({ id, name: name(db, id), approved_at: got.find((g) => g.founder_id === id)?.approved_at || null })), complete: need.length > 0 && need.every((id) => got.some((g) => g.founder_id === id)) };
}
/** Private release: only after every founder confirmed this version. The email never carries ratings. */
export function releaseReview(db, actor, reviewId) {
  const { r, policy } = loadReview(db, actor, reviewId); if (!isFounder(db, actor)) throw forbid(); expect(r, 'approval');
  if (!approvalState(db, r).complete) throw bad('Both founders must confirm this version before it is released');
  const rows = ratingRows(db, reviewId); const s = scoreOf(db, reviewId, policy);
  const published = { version: r.version, policy_name: policy.name, outcome: r.outcome, score: r.score_points != null ? (r.score_points / 100).toFixed(2) : null, band: r.band, insufficient_reason: r.insufficient_reason,
    applied_weights: P(r.applied_weights_json), dimensions: policy.dimensions.map((d) => ({ key: d.key, label: d.label, weight: d.weight, score: s.input[d.key].score, na: s.input[d.key].na, rationale: rows[d.key]?.rationale || null, growth_action: rows[d.key]?.growth_action || null })) };
  db.prepare("UPDATE perf_reviews SET state = 'released', released_at = ?, released_by = ?, released_json = ?, ack_at = NULL, ack_kind = NULL, updated_at = ? WHERE id = ?").run(now(), actor.id, J(published), now(), reviewId);
  notify(db, { tenantId: r.tenant_id, to: r.user_id, event: 'perf.released', key: `${reviewId}:v${r.version}`, link: '#/performance', subject: 'Your annual review is ready to read', text: 'Your annual review result is ready in GB People. Please read it and acknowledge receipt — acknowledging records that you received it, not that you agree.' });
  audit(db, { tenantId: r.tenant_id, actorId: actor.id, action: 'perf.release', entity: 'review', entityId: reviewId, after: { version: r.version } });
  return { ok: true };
}
export function acknowledgeReview(db, actor, reviewId, { kind = 'ack', note } = {}) {
  const { r, rel } = loadReview(db, actor, reviewId); if (!rel.self) throw forbid(); expect(r, 'released', 'correction');
  if (kind === 'correction' && !clip(note)) throw bad('Say what you think should be corrected');
  db.prepare('UPDATE perf_reviews SET state = ?, ack_at = ?, ack_kind = ?, ack_note = ?, updated_at = ? WHERE id = ?').run(kind === 'correction' ? 'correction' : 'acknowledged', now(), kind, clip(note, 1000), now(), reviewId);
  if (kind === 'correction') for (const f of founders(db, r.tenant_id)) notify(db, { tenantId: r.tenant_id, to: f, event: 'perf.correction', key: `${reviewId}:${now()}`, link: '#/admin/calibration', subject: `Correction requested: ${actor.name}`, text: `${actor.name} asked for a correction to their released review.` });
  return { ok: true };
}
/** Authorised amendment after release: recorded with reason; back to founder approval, then released again. */
export function amendReview(db, actor, reviewId, { reason, ratings = [] } = {}) {
  const { r, policy } = loadReview(db, actor, reviewId); if (!isFounder(db, actor)) throw forbid(); expect(r, 'released', 'acknowledged', 'correction', 'closed');
  if (!clip(reason)) throw bad('An amendment needs a reason');
  const before = r.released_json;
  for (const x of ratings) {
    if (!DIM_KEYS(policy).includes(x.dimension) || !(Number.isInteger(x.score) && x.score >= 1 && x.score <= 5)) throw bad('Whole-number scores 1–5 on known dimensions');
    const cur = db.prepare('SELECT * FROM perf_ratings WHERE review_id = ? AND dimension = ?').get(reviewId, x.dimension);
    db.prepare('UPDATE perf_ratings SET final_score = ? WHERE review_id = ? AND dimension = ?').run(x.score, reviewId, x.dimension);
    db.prepare('INSERT INTO perf_rating_changes (id, review_id, dimension, stage, from_score, to_score, rationale, by_id, at) VALUES (?,?,?,?,?,?,?,?,?)').run(uid('prc_'), reviewId, x.dimension, 'amendment', cur?.final_score ?? cur?.proposed_score, x.score, clip(reason, 1000), actor.id, now());
  }
  const s = scoreOf(db, reviewId, policy);
  db.prepare("UPDATE perf_reviews SET state = 'approval', score_points = ?, band = ?, outcome = ?, applied_weights_json = ?, version = version + 1, updated_at = ? WHERE id = ?").run(s.points, s.band, s.status === 'scored' ? 'scored' : r.outcome, s.applied_weights ? J(s.applied_weights) : r.applied_weights_json, now(), reviewId);
  db.prepare('DELETE FROM perf_approvals WHERE review_id = ?').run(reviewId);
  db.prepare('INSERT INTO perf_amendments (id, review_id, reason, before_json, after_json, by_id, at) VALUES (?,?,?,?,?,?,?)').run(uid('pam_'), reviewId, clip(reason, 1000), before, J({ score: s.display, band: s.band }), actor.id, now());
  audit(db, { tenantId: r.tenant_id, actorId: actor.id, action: 'perf.amend', entity: 'review', entityId: reviewId, reason: clip(reason, 300) });
  return { ok: true };
}
export function saveLeadershipNote(db, actor, reviewId, note) {
  loadReview(db, actor, reviewId); if (!isFounder(db, actor)) throw forbid();
  db.prepare('UPDATE perf_reviews SET leadership_note = ? WHERE id = ?').run(clip(note, 2000), reviewId); return { ok: true };
}

// -------------------------------------------------------------------- views --
const snapshotView = (db, s) => ({ id: s.id, project: s.project_id ? db.prepare('SELECT name FROM projects WHERE id = ?').get(s.project_id)?.name : 'Internal assignment', project_id: s.project_id, observer: name(db, s.observer_id), observer_id: s.observer_id,
  person: name(db, s.user_id), user_id: s.user_id, trigger: s.trigger, due_on: s.due_on, status: s.status, owned: s.owned, example: s.example, impact: s.impact, development: s.development, rating: s.rating,
  employee_context: s.employee_context, correction_requested_at: s.correction_requested_at, submitted_at: s.submitted_at });

export function reviewView(db, actor, reviewId) {
  const { r, rel, cycle, policy } = loadReview(db, actor, reviewId);
  const lead = rel.manager || rel.founder;
  if (!rel.self && !lead) { // admin only: progress
    return { id: r.id, person: name(db, r.user_id), state: r.state, cycle: { id: cycle.id, year: cycle.year, name: cycle.name }, relation: 'admin' };
  }
  const goals = db.prepare('SELECT * FROM perf_goals WHERE review_id = ? ORDER BY CASE kind WHEN \'delivery\' THEN 1 WHEN \'growth\' THEN 2 ELSE 3 END').all(reviewId);
  const changes = db.prepare('SELECT c.*, g.kind FROM perf_goal_changes c JOIN perf_goals g ON g.id = c.goal_id WHERE g.review_id = ? ORDER BY c.at DESC').all(reviewId).map((c) => ({ ...c, requested_by: name(db, c.requested_by), approved_by: name(db, c.approved_by) }));
  const kickoffs = db.prepare('SELECT k.*, p.name project FROM perf_kickoffs k LEFT JOIN projects p ON p.id = k.project_id WHERE k.user_id = ? ORDER BY COALESCE(k.start_date, k.created_at)').all(r.user_id);
  const snaps = db.prepare("SELECT * FROM perf_snapshots WHERE user_id = ? AND status = 'submitted' AND triggered_on >= ? ORDER BY submitted_at").all(r.user_id, `${cycle.year}-01-01`).map((s) => snapshotView(db, s));
  const coaching = db.prepare('SELECT * FROM perf_coaching WHERE review_id = ? ORDER BY month').all(reviewId).map((c) => ({ ...c, owner: name(db, c.owner_id) }));
  const released = r.released_json ? P(r.released_json) : null;
  const base = { id: r.id, person: name(db, r.user_id), user_id: r.user_id, manager: name(db, r.manager_id), level: r.level, track: r.track, role_history: P(r.role_history_json, []),
    state: r.state, cycle: { id: cycle.id, year: cycle.year, name: cycle.name, dates: P(cycle.dates_json) }, relation: rel.self ? 'self' : rel.founder ? 'founder' : 'manager',
    policy: { dimensions: policy.dimensions, scale: policy.scale, rubric: policy.rubric, fairness: policy.fairness, coaching: policy.coaching },
    goals, goal_changes: changes, goals_agreed_at: r.goals_agreed_at, kickoffs, snapshots: snaps, coaching, reflection: P(r.reflection_json), reflection_at: r.reflection_at,
    conflicts: lead ? deadlineConflicts(db, r.user_id) : [], kickoff_candidates: kickoffCandidates(db, actor, r.user_id),
    released: released && r.released_at ? { ...released, released_at: r.released_at } : null, /* the last published version, also while an amendment is approved */ ack: r.ack_at ? { at: r.ack_at, kind: r.ack_kind, note: r.ack_note } : null };
  if (rel.self) return base; // ratings, score and leadership notes stay hidden until release
  const rows = ratingRows(db, reviewId);
  const s = scoreOf(db, reviewId, policy);
  return { ...base, ratings: policy.dimensions.map((d) => ({ dimension: d.key, label: d.label, weight: d.weight, ...(rows[d.key] || {}), na_approved_by: name(db, rows[d.key]?.na_approved_by) })),
    preview: { status: s.status, score: s.display, band: s.band, missing: s.missing, applied_weights: s.applied_weights }, stored: { outcome: r.outcome, score: r.score_points != null ? (r.score_points / 100).toFixed(2) : null, band: r.band, insufficient_reason: r.insufficient_reason },
    changes: db.prepare('SELECT c.*, u.name by_name FROM perf_rating_changes c JOIN users u ON u.id = c.by_id WHERE c.review_id = ? ORDER BY c.at').all(reviewId),
    ...(rel.founder ? { leadership_note: r.leadership_note, approvals: approvalState(db, r), version: r.version, amendments: db.prepare('SELECT a.*, u.name by_name FROM perf_amendments a JOIN users u ON u.id = a.by_id WHERE a.review_id = ? ORDER BY a.at').all(reviewId) } : {}) };
}

/** The employee's page: current review, next action, and every released result (this model and earlier ones). */
export function myPerformance(db, actor) {
  const r = db.prepare("SELECT r.id FROM perf_reviews r JOIN perf_cycles c ON c.id = r.cycle_id WHERE r.user_id = ? ORDER BY c.year DESC LIMIT 1").get(actor.id);
  const current = r ? reviewView(db, actor, r.id) : null;
  const next = !current ? null : current.state === 'goals' ? (current.goals.length ? 'Your review manager agrees your priorities' : 'Agree up to three priorities with your review manager')
    : current.state === 'reflection' ? 'Write your reflection' : current.state === 'released' ? 'Read your result and acknowledge receipt' : current.state === 'correction' ? 'Your correction request is with the founders'
      : ['manager', 'calibration', 'approval'].includes(current.state) ? 'Your review is with your manager and the founders' : null;
  const history = db.prepare("SELECT r.id, c.year, r.released_json, r.state FROM perf_reviews r JOIN perf_cycles c ON c.id = r.cycle_id WHERE r.user_id = ? AND r.released_json IS NOT NULL ORDER BY c.year DESC").all(actor.id)
    .map((h) => ({ id: h.id, year: h.year, ...P(h.released_json) }));
  const snapshotsToAnswer = db.prepare("SELECT * FROM perf_snapshots WHERE user_id = ? AND status = 'submitted' AND employee_context IS NULL ORDER BY submitted_at DESC LIMIT 5").all(actor.id).map((s) => snapshotView(db, s));
  return { current, next, history, snapshots_new: snapshotsToAnswer };
}

/** Review manager / project lead / founders: people, tasks, evidence coverage and the feedback queue. */
export function teamPerformance(db, actor) {
  const founder = isFounder(db, actor);
  const reviews = db.prepare(`SELECT r.*, c.year, c.status cycle_status FROM perf_reviews r JOIN perf_cycles c ON c.id = r.cycle_id WHERE r.tenant_id = ? AND c.status != 'closed' AND (r.manager_id = ? OR ?) AND r.user_id != ? ORDER BY c.year DESC`)
    .all(actor.tenantId, actor.id, founder ? 1 : 0, actor.id);
  const month = isoMonth(todayIn());
  const people = reviews.map((r) => {
    const pol = P(db.prepare('SELECT policy_frozen_json FROM perf_cycles WHERE id = ?').get(r.cycle_id).policy_frozen_json);
    const snaps = db.prepare("SELECT COUNT(*) n FROM perf_snapshots WHERE user_id = ? AND status = 'submitted' AND triggered_on >= ?").get(r.user_id, `${r.year}-01-01`).n;
    const kick = db.prepare('SELECT COUNT(*) n FROM perf_kickoffs WHERE user_id = ?').get(r.user_id).n;
    const coachingDue = (pol.coaching?.months || []).includes(month) && !db.prepare('SELECT 1 FROM perf_coaching WHERE review_id = ? AND month = ?').get(r.id, month);
    const tasks = [];
    if (r.state === 'goals') tasks.push(db.prepare('SELECT 1 FROM perf_goals WHERE review_id = ?').get(r.id) ? 'Agree priorities' : 'Priorities not drafted yet');
    if (db.prepare("SELECT 1 FROM perf_goal_changes c JOIN perf_goals g ON g.id = c.goal_id WHERE g.review_id = ? AND c.status = 'pending'").get(r.id)) tasks.push('Priority change to approve');
    if (coachingDue && ['in_year', 'goals'].includes(r.state)) tasks.push(month === (pol.coaching?.career_month ?? 6) ? 'Career conversation this month' : 'Coaching this month');
    if (r.state === 'manager') tasks.push('Propose ratings');
    if (r.state === 'calibration' && founder) tasks.push('Calibrate');
    if (r.state === 'approval' && founder && !db.prepare('SELECT 1 FROM perf_approvals WHERE review_id = ? AND founder_id = ? AND version = ?').get(r.id, actor.id, r.version)) tasks.push('Confirm the result');
    return { review_id: r.id, user_id: r.user_id, name: name(db, r.user_id), title: [r.level, r.track].filter(Boolean).join(' – '), state: r.state, year: r.year, mine: r.manager_id === actor.id,
      evidence: { kickoffs: kick, snapshots: snaps, coaching: db.prepare('SELECT COUNT(*) n FROM perf_coaching WHERE review_id = ?').get(r.id).n }, conflicts: deadlineConflicts(db, r.user_id).length, tasks };
  });
  const feedback = db.prepare("SELECT * FROM perf_snapshots WHERE observer_id = ? AND tenant_id = ? AND status IN ('requested','draft') ORDER BY due_on").all(actor.id, actor.tenantId).map((s) => snapshotView(db, s));
  const corrections = db.prepare("SELECT * FROM perf_snapshots WHERE observer_id = ? AND correction_requested_at IS NOT NULL AND status = 'submitted' ORDER BY correction_requested_at DESC LIMIT 10").all(actor.id).map((s) => snapshotView(db, s));
  return { people, feedback, corrections, founder };
}
export function getSnapshot(db, actor, id) {
  const s = db.prepare('SELECT * FROM perf_snapshots WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!s) throw notFound();
  const mgr = db.prepare("SELECT 1 FROM perf_reviews WHERE user_id = ? AND manager_id = ?").get(s.user_id, actor.id);
  if (s.observer_id !== actor.id && !(s.status === 'submitted' && (s.user_id === actor.id || mgr || isFounder(db, actor)))) throw notFound();
  return snapshotView(db, s);
}

/** Founders and admin: cycle progress; founders also get the side-by-side calibration grid. */
export function adminView(db, actor) {
  if (!canSetup(db, actor)) throw forbid();
  const founder = isFounder(db, actor);
  const cycles = db.prepare('SELECT * FROM perf_cycles WHERE tenant_id = ? ORDER BY year DESC').all(actor.tenantId).map((c) => {
    const reviews = db.prepare('SELECT * FROM perf_reviews WHERE cycle_id = ? ORDER BY user_id').all(c.id);
    const pol = P(c.policy_frozen_json);
    return { id: c.id, year: c.year, name: c.name, status: c.status, dates: P(c.dates_json), counts: Object.fromEntries([...new Set(reviews.map((r) => r.state))].map((s) => [s, reviews.filter((r) => r.state === s).length])),
      rows: reviews.map((r) => {
        const base = { review_id: r.id, user_id: r.user_id, name: name(db, r.user_id), title: [r.level, r.track].filter(Boolean).join(' – '), manager: name(db, r.manager_id), state: r.state };
        if (!founder) return base;
        const rows = ratingRows(db, r.id);
        return { ...base, ratings: Object.fromEntries(pol.dimensions.map((d) => [d.key, rows[d.key] ? { proposed: rows[d.key].proposed_score, final: rows[d.key].final_score, na: !!rows[d.key].na_requested, na_ok: !!rows[d.key].na_approved_by, insufficient: !!rows[d.key].insufficient } : null])),
          score: r.score_points != null ? (r.score_points / 100).toFixed(2) : null, band: r.band, outcome: r.outcome, version: r.version, approvals: approvalState(db, r) };
      }).sort((a, b) => a.name.localeCompare(b.name)), dimensions: pol.dimensions };
  });
  return { cycles, policy: currentPolicy(db, actor.tenantId), founder };
}

/** Inbox items. Own tasks go to Home; decisions about others go to Manager → Approvals. */
export function perfInboxItems(db, actor) {
  const items = [];
  const mine = db.prepare("SELECT r.* FROM perf_reviews r JOIN perf_cycles c ON c.id = r.cycle_id WHERE r.user_id = ? AND c.status != 'closed' ORDER BY c.year DESC LIMIT 1").get(actor.id);
  if (mine) {
    if (mine.state === 'goals' && !db.prepare('SELECT 1 FROM perf_goals WHERE review_id = ?').get(mine.id)) items.push({ type: 'perf', kind: 'Performance', title: 'Agree up to three priorities for the year', link: '#/performance', scope: 'mine', action: 'Set my priorities' });
    if (mine.state === 'reflection') items.push({ type: 'perf', kind: 'Annual review', title: 'Write your reflection', link: '#/performance', scope: 'mine', action: 'Write my reflection' });
    if (mine.state === 'released') items.push({ type: 'perf', kind: 'Annual review', title: 'Read your result and acknowledge receipt', link: '#/performance', scope: 'mine', action: 'Read my result' });
  }
  for (const s of db.prepare("SELECT * FROM perf_snapshots WHERE observer_id = ? AND tenant_id = ? AND status IN ('requested','draft') ORDER BY due_on").all(actor.id, actor.tenantId))
    items.push({ type: 'perf_snapshot', kind: 'Project snapshot', title: `Feedback on ${name(db, s.user_id)}${s.project_id ? ` — ${db.prepare('SELECT name FROM projects WHERE id = ?').get(s.project_id)?.name}` : ''}`, due: s.due_on, link: `#/manager/performance?snapshot=${s.id}`, scope: 'team', action: 'Write' });
  try {
    for (const p of teamPerformance(db, actor).people.filter((x) => x.tasks.length))
      items.push({ type: 'perf_team', kind: 'Performance', title: `${p.name}: ${p.tasks.join(', ')}`, link: `#/performance/review/${p.review_id}`, scope: 'team', action: 'Open' });
  } catch { /* no team */ }
  return items;
}
