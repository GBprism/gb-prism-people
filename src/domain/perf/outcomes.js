// Promotion cases and the restricted compensation workspace.
//
// Promotion: a high score makes a person eligible for consideration; the founders decide the actual role,
// scope and effective date. Performance eligibility, next-level readiness and approval are separate fields.
// Title change, grade movement and probation confirmation are distinct outcomes. Nothing here changes the
// person's job in the roster — an approved case is a decision record; the roster is updated deliberately.
//
// Compensation: founders, plus people the founders name as compensation administrators (setting
// "comp_admins"). The admin role alone does NOT grant access. Values are encrypted at rest. Historical
// (imported) values are kept as communicated and never trigger payroll, emails, title changes or edits.
import { uid, now, audit, bad, forbid, notFound, conflict, J, P } from '../../db.js';
import { seal, open } from '../hrrecords.js';
import { todayIn } from '../dates.js';
import { notify } from '../mailer.js';
import { founders, isFounder } from './cycle.js';
import { promotionGates, DEFAULT_POLICY } from './policy.js';

const clip = (s, n = 1000) => (s == null ? null : String(s).trim().slice(0, n) || null);
const name = (db, id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || null : null);
const setting = (db, t, k) => { const r = db.prepare('SELECT value_json FROM settings WHERE tenant_id = ? AND key = ?').get(t, k); return r ? JSON.parse(r.value_json) : null; };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const monthsBetween = (a, b) => (isDate(a) && isDate(b) ? Math.floor((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (30.44 * 864e5)) : null);
function approvedPolicy(db, tenantId) { const p = db.prepare("SELECT policy_json FROM perf_policies WHERE tenant_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1").get(tenantId); return p ? P(p.policy_json) : null; }

// -------------------------------------------------------------- promotions --
function promoAccess(db, actor, userId) {
  const founder = isFounder(db, actor);
  const manager = !!db.prepare('SELECT 1 FROM perf_reviews WHERE user_id = ? AND manager_id = ? AND tenant_id = ?').get(userId, actor.id, actor.tenantId);
  if (!founder && !manager) throw forbid('Promotion cases are for the founders and the review manager');
  return { founder, manager };
}
function latestScore(db, userId) {
  const r = db.prepare("SELECT r.*, c.policy_frozen_json FROM perf_reviews r JOIN perf_cycles c ON c.id = r.cycle_id WHERE r.user_id = ? AND r.released_json IS NOT NULL ORDER BY c.year DESC LIMIT 1").get(userId);
  if (!r) return { points: null, ratings: {}, review_id: null };
  const rel = P(r.released_json);
  return { points: rel.outcome === 'scored' && rel.score != null ? Math.round(Number(rel.score) * 100) : null, ratings: Object.fromEntries(rel.dimensions.map((d) => [d.key, { score: d.score, na: d.na }])), review_id: r.id, year: P(r.policy_frozen_json) && r.cycle_id };
}
function caseView(db, c, policy) {
  const s = latestScore(db, c.user_id);
  const scopeMonths = c.scope_from ? monthsBetween(c.scope_from, c.scope_to || todayIn()) : null;
  const gates = promotionGates(policy || DEFAULT_POLICY, { points: s.points, ratings: s.ratings, scopeMonths, monthsInGrade: c.months_in_grade, economic: c.economic, payWithinBand: c.pay_within_band == null ? null : !!c.pay_within_band, payException: c.pay_exception });
  return { ...c, person: name(db, c.user_id), sponsor: name(db, c.sponsor_id), approved_by_name: name(db, c.approved_by), override: P(c.override_json), score: s.points != null ? (s.points / 100).toFixed(2) : null, scope_months: scopeMonths, eligibility: gates };
}
export function listPromotions(db, actor) {
  const founder = isFounder(db, actor);
  const rows = db.prepare(`SELECT * FROM promotion_cases WHERE tenant_id = ? ${founder ? '' : 'AND user_id IN (SELECT user_id FROM perf_reviews WHERE manager_id = ?)'} ORDER BY updated_at DESC`).all(...[actor.tenantId, founder ? null : actor.id].filter((x) => x !== null));
  const pol = approvedPolicy(db, actor.tenantId);
  return { cases: rows.map((c) => caseView(db, c, pol)), policy_approved: !!pol, founder };
}
const KINDS = ['title', 'grade', 'probation'];
export function savePromotion(db, actor, id, b = {}) {
  const userId = id ? db.prepare('SELECT user_id FROM promotion_cases WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId)?.user_id : b.user_id;
  if (!userId) throw notFound();
  promoAccess(db, actor, userId);
  if (b.outcome_kind && !KINDS.includes(b.outcome_kind)) throw bad('Outcome is a title change, a grade movement or probation confirmation');
  for (const k of ['scope_from', 'scope_to', 'review_on']) if (b[k] && !isDate(b[k])) throw bad(`${k} must be a date`);
  const f = { outcome_kind: b.outcome_kind || 'title', target_title: clip(b.target_title, 120), target_track: clip(b.target_track, 80), responsibilities: clip(b.responsibilities, 2000), evidence_links: clip(b.evidence_links, 2000),
    scope_from: b.scope_from || null, scope_to: b.scope_to || null, observations: clip(b.observations, 2000), economic: clip(b.economic, 1500),
    pay_within_band: b.pay_within_band == null || b.pay_within_band === '' ? null : b.pay_within_band ? 1 : 0, pay_exception: clip(b.pay_exception, 500), months_in_grade: b.months_in_grade == null || b.months_in_grade === '' ? null : Math.round(Number(b.months_in_grade)),
    opportunity_assignment: clip(b.opportunity_assignment, 600), sponsor_id: b.sponsor_id || null, review_on: b.review_on || null };
  const t = now();
  if (id) {
    const cur = db.prepare('SELECT readiness FROM promotion_cases WHERE id = ?').get(id);
    if (cur.readiness === 'approved') throw conflict('An approved case is a decision record; open a new case for a new decision');
    db.prepare(`UPDATE promotion_cases SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...Object.values(f), t, id);
  } else {
    id = uid('prm_');
    db.prepare(`INSERT INTO promotion_cases (id, tenant_id, user_id, ${Object.keys(f).join(', ')}, created_by, created_at, updated_at) VALUES (?,?,?,${Object.keys(f).map(() => '?').join(',')},?,?,?)`).run(id, actor.tenantId, userId, ...Object.values(f), actor.id, t, t);
  }
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'promotion.save', entity: 'promotion', entityId: id });
  return caseView(db, db.prepare('SELECT * FROM promotion_cases WHERE id = ?').get(id), approvedPolicy(db, actor.tenantId));
}
/** Readiness: ready / development needed / deferred for business reasons — each with a rationale. */
export function setReadiness(db, actor, id, { readiness, rationale } = {}) {
  const c = db.prepare('SELECT * FROM promotion_cases WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!c) throw notFound();
  promoAccess(db, actor, c.user_id);
  if (!['ready', 'development', 'deferred'].includes(readiness)) throw bad('Readiness is ready, development needed or deferred for business reasons');
  if (!clip(rationale)) throw bad('Record the rationale');
  if (readiness === 'development' && (!c.opportunity_assignment || !c.sponsor_id || !c.review_on) && !c.scope_from) throw bad('If they have not had the chance to show the next level, record a concrete assignment, a sponsor and a review date');
  db.prepare('UPDATE promotion_cases SET readiness = ?, readiness_rationale = ?, updated_at = ? WHERE id = ?').run(readiness, clip(rationale, 1500), now(), id);
  return { ok: true };
}
/** Founders approve the role, scope and effective date. A failed gate needs a recorded override. */
export function approvePromotion(db, actor, id, { approved_title, approved_scope, effective_on, override } = {}) {
  const c = db.prepare('SELECT * FROM promotion_cases WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!c) throw notFound();
  if (!isFounder(db, actor)) throw forbid('A founder approves the role, scope and effective date');
  if (c.readiness !== 'ready') throw bad('Record readiness as ready first');
  if (!clip(approved_title) || !clip(approved_scope) || !isDate(effective_on)) throw bad('Approve the role, its scope and the effective date');
  const view = caseView(db, c, approvedPolicy(db, actor.tenantId));
  let ov = null;
  if (!view.eligibility.eligible) {
    if (!override?.clause || !override?.reason || !isDate(override?.review_on)) throw bad(`Gates not met (${view.eligibility.blocking.join('; ') || 'evidence pending'}). An override needs the policy clause, the reason and a review date.`);
    ov = { clause: clip(override.clause, 200), reason: clip(override.reason, 1000), approver: actor.id, review_on: override.review_on, at: now() };
  }
  db.prepare("UPDATE promotion_cases SET readiness = 'approved', approved_by = ?, approved_at = ?, approved_title = ?, approved_scope = ?, effective_on = ?, override_json = ?, updated_at = ? WHERE id = ?")
    .run(actor.id, now(), clip(approved_title, 120), clip(approved_scope, 2000), effective_on, ov ? J(ov) : null, now(), id);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: ov ? 'promotion.approve_override' : 'promotion.approve', entity: 'promotion', entityId: id, after: { effective_on, override: !!ov } });
  return { ok: true };
}

// ------------------------------------------------------------ compensation --
export function compAccess(db, actor) { return isFounder(db, actor) || (setting(db, actor.tenantId, 'comp_admins') || []).includes(actor.id); }
const requireComp = (db, a) => { if (!compAccess(db, a)) throw forbid('Compensation is for the founders and named compensation administrators'); };
const x1000 = (v) => (v == null || v === '' ? null : Math.round(Number(String(v).replace(/,/g, '')) * 1000));
const money = (n) => (n == null ? null : n / 1000);
function derive(d, policy) {
  const prior = d.prior_x1000; const next = d.approved_x1000 ?? d.proposed_x1000;
  const inc = prior != null && next != null ? next - prior : null;
  const pct = prior ? Math.round(((next - prior) / prior) * 1000) / 10 : null; // one decimal, from the amounts
  const basis = d.bonus_basis === 'prior' ? prior : next;
  const bonus = d.bonus_type === 'months' && d.bonus_months != null && basis != null ? Math.round(basis * d.bonus_months) : d.bonus_type === 'fixed' ? d.bonus_amount_x1000 : null;
  const bands = policy?.compensation?.bands;
  return { increase: money(inc), increase_pct: pct, bonus_value: money(bonus), annual_cost: inc != null || bonus != null ? money((inc || 0) * 12 + (bonus || 0)) : null,
    band_position: bands ? (d.band_position || 'Not recorded') : 'Bands not configured — founders have not approved them' };
}
function compView(db, c, policy) {
  const d = open(c.data_enc);
  return { id: c.id, user_id: c.user_id, person: name(db, c.user_id) || d.name_in_source, year: c.year, source: c.source, status: c.status, approved_by: name(db, c.approved_by), approved_at: c.approved_at, released_at: c.released_at, acknowledged_at: c.acknowledged_at,
    prior: money(d.prior_x1000), proposed: money(d.proposed_x1000), approved: money(d.approved_x1000), currency: d.currency || 'JOD', bonus_type: d.bonus_type || null, bonus_months: d.bonus_months ?? null, bonus_amount: money(d.bonus_amount_x1000), bonus_basis: d.bonus_basis || null,
    effective: d.effective || null, title: d.title || null, outcome_label: d.outcome_label || null, quoted_pct: d.quoted_pct ?? null, rating_in_source: d.rating_in_source ?? null, sent_at: d.sent_at || null, source_url: d.source_url || null, note: d.note || null,
    has_message: !!d.body, ...derive(d, policy) };
}
export function listComp(db, actor, { year } = {}) {
  requireComp(db, actor);
  const pol = approvedPolicy(db, actor.tenantId);
  const rows = db.prepare(`SELECT * FROM comp_records WHERE tenant_id = ? ${year ? 'AND year = ?' : ''} ORDER BY year DESC, created_at`).all(...[actor.tenantId, year].filter(Boolean)).map((c) => compView(db, c, pol));
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'comp.view', entity: 'tenant', entityId: actor.tenantId });
  return { rows, bands_configured: !!pol?.compensation?.bands, employee_release: !!pol?.compensation?.employee_release, bonus_guidance_months: pol?.compensation?.bonus_guidance_months ?? null };
}
export function compMessage(db, actor, id) {
  requireComp(db, actor);
  const c = db.prepare('SELECT * FROM comp_records WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!c) throw notFound();
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'comp.view_message', entity: 'comp', entityId: id });
  return { body: open(c.data_enc).body || null };
}
export function saveCompProposal(db, actor, id, b = {}) {
  requireComp(db, actor);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ?').get(b.user_id, actor.tenantId)) throw bad('Choose the person');
  const year = Number(b.year); if (!(year >= 2026 && year <= 2100)) throw bad('Choose the year');
  if (b.bonus_type && !['months', 'fixed', 'none'].includes(b.bonus_type)) throw bad('Bonus is months of salary, a fixed amount or none');
  if (b.effective && !/^\d{4}-\d{2}(-\d{2})?$/.test(b.effective)) throw bad('Effective month or date, e.g. 2027-01');
  const d = { prior_x1000: x1000(b.prior), proposed_x1000: x1000(b.proposed), approved_x1000: null, currency: 'JOD', bonus_type: b.bonus_type || 'none', bonus_months: b.bonus_type === 'months' ? Number(b.bonus_months) : null,
    bonus_amount_x1000: b.bonus_type === 'fixed' ? x1000(b.bonus_amount) : null, bonus_basis: b.bonus_basis === 'prior' ? 'prior' : 'new', effective: b.effective || null, band_position: clip(b.band_position, 120), note: clip(b.note, 1000), title: clip(b.title, 120) };
  if (d.proposed_x1000 != null && !(d.proposed_x1000 > 0)) throw bad('Proposed salary must be positive');
  const t = now();
  if (id) {
    const c = db.prepare("SELECT * FROM comp_records WHERE id = ? AND tenant_id = ? AND source = 'proposal'").get(id, actor.tenantId); if (!c) throw notFound();
    if (c.status !== 'draft') throw conflict('Approved compensation is not edited; record a new proposal');
    db.prepare('UPDATE comp_records SET user_id = ?, year = ?, data_enc = ?, updated_at = ? WHERE id = ?').run(b.user_id, year, seal(d), t, id);
  } else {
    id = uid('cmp_');
    db.prepare("INSERT INTO comp_records (id, tenant_id, user_id, year, source, source_ref, status, data_enc, created_by, created_at, updated_at) VALUES (?,?,?,?, 'proposal', ?, 'draft', ?,?,?,?)").run(id, actor.tenantId, b.user_id, year, id, seal(d), actor.id, t, t);
  }
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'comp.proposal', entity: 'comp', entityId: id });
  return { id };
}
/** A founder approves the proposed amounts (salary, bonus and promotion vary independently). */
export function approveComp(db, actor, id) {
  if (!isFounder(db, actor)) throw forbid('A founder approves compensation');
  const c = db.prepare("SELECT * FROM comp_records WHERE id = ? AND tenant_id = ? AND source = 'proposal'").get(id, actor.tenantId); if (!c) throw notFound();
  if (c.status !== 'draft') throw conflict('Already approved');
  const d = open(c.data_enc); d.approved_x1000 = d.proposed_x1000;
  db.prepare("UPDATE comp_records SET status = 'approved', data_enc = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?").run(seal(d), actor.id, now(), now(), id);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'comp.approve', entity: 'comp', entityId: id });
  return { ok: true };
}
/** Show approved compensation to the employee — only if the approved policy allows it. The email has no amounts. */
export function releaseComp(db, actor, id) {
  if (!isFounder(db, actor)) throw forbid();
  const pol = approvedPolicy(db, actor.tenantId);
  if (!pol?.compensation?.employee_release) throw bad('The approved policy does not release compensation to employees in GB People');
  const c = db.prepare("SELECT * FROM comp_records WHERE id = ? AND tenant_id = ? AND source = 'proposal' AND status = 'approved'").get(id, actor.tenantId); if (!c) throw notFound();
  db.prepare("UPDATE comp_records SET status = 'released', released_at = ? WHERE id = ?").run(now(), id);
  notify(db, { tenantId: actor.tenantId, to: c.user_id, event: 'comp.released', key: id, link: '#/performance', subject: 'Your outcome letter is ready', text: 'Your confirmed outcome is ready to read privately in GB People.' });
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'comp.release', entity: 'comp', entityId: id });
  return { ok: true };
}
/** The employee's own released outcome only. */
export function myOutcome(db, actor) {
  const pol = approvedPolicy(db, actor.tenantId);
  const comp = db.prepare("SELECT * FROM comp_records WHERE user_id = ? AND status = 'released' ORDER BY year DESC").all(actor.id).map((c) => { const v = compView(db, c, pol); return { year: v.year, effective: v.effective, title: v.title, salary: v.approved, currency: v.currency, bonus_type: v.bonus_type, bonus_months: v.bonus_months, bonus_amount: v.bonus_amount, released_at: v.released_at, acknowledged_at: v.acknowledged_at, id: c.id }; });
  const promo = db.prepare("SELECT approved_title, approved_scope, effective_on, outcome_kind FROM promotion_cases WHERE user_id = ? AND readiness = 'approved' ORDER BY approved_at DESC LIMIT 3").all(actor.id);
  return { compensation: comp, promotions: promo };
}
export function acknowledgeComp(db, actor, id) {
  const c = db.prepare("SELECT * FROM comp_records WHERE id = ? AND user_id = ? AND status = 'released'").get(id, actor.id); if (!c) throw notFound();
  db.prepare('UPDATE comp_records SET acknowledged_at = ? WHERE id = ?').run(now(), id);
  return { ok: true };
}
/** Private outcome preview (founders): title, effective date, responsibilities, development priorities, approved pay. */
export function outcomePreview(db, actor, userId, year) {
  if (!isFounder(db, actor)) throw forbid();
  const pol = approvedPolicy(db, actor.tenantId);
  const promo = db.prepare("SELECT * FROM promotion_cases WHERE user_id = ? AND tenant_id = ? AND readiness = 'approved' ORDER BY approved_at DESC LIMIT 1").get(userId, actor.tenantId);
  const rev = db.prepare("SELECT r.released_json FROM perf_reviews r JOIN perf_cycles c ON c.id = r.cycle_id WHERE r.user_id = ? AND c.year = ?").get(userId, Number(year));
  const comp = db.prepare("SELECT * FROM comp_records WHERE user_id = ? AND year = ? AND source = 'proposal' AND status IN ('approved','released') ORDER BY approved_at DESC LIMIT 1").get(userId, Number(year));
  const growth = rev ? P(rev.released_json).dimensions.map((d) => d.growth_action).filter(Boolean) : [];
  return { person: name(db, userId), title: promo?.approved_title || null, effective_on: promo?.effective_on || (comp ? compView(db, comp, pol).effective : null), responsibilities: promo?.approved_scope || null,
    development: growth, compensation: comp ? (({ approved, currency, bonus_type, bonus_months, bonus_amount, effective }) => ({ approved, currency, bonus_type, bonus_months, bonus_amount, effective }))(compView(db, comp, pol)) : null,
    compensation_released_to_employee: !!pol?.compensation?.employee_release };
}
export function compAdmins(db, actor, ids) {
  if (!isFounder(db, actor)) throw forbid();
  if (ids) { const ok = ids.filter((i) => db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ? AND active = 1').get(i, actor.tenantId)); db.prepare('INSERT INTO settings (tenant_id, key, value_json) VALUES (?,?,?) ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json').run(actor.tenantId, 'comp_admins', J(ok)); audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'comp.admins', entity: 'settings', entityId: 'comp_admins', after: { count: ok.length } }); }
  return { admins: (setting(db, actor.tenantId, 'comp_admins') || []).map((id) => ({ id, name: name(db, id) })), founders: founders(db, actor.tenantId).map((id) => ({ id, name: name(db, id) })) };
}
export { approvedPolicy };
