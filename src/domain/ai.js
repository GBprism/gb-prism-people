// AI adoption & enablement — deliberately separate from performance scoring.
// Nothing in this module is read by scoring.js; usage counts, spend and model
// mix can never change a rating. Seat ≠ person: shared seats are attributed
// only through confirmed seat attributions.
import { tx, uid, now, J, audit, bad, forbid, notFound } from '../db.js';
import { isOps, aiExampleAccess } from './authz.js';
import { sha256 } from '../imports/xlsx.js';

/** Import a usage export already flattened to rows {account_email, access, metric, value|null}. */
export function importUsage(db, actor, { tool, report, windowFrom, windowTo, exportedAt, planNote, spendScope, rows, fileBuffer }) {
  if (!isOps(actor)) throw forbid();
  if (!['gemini', 'claude'].includes(tool)) throw bad('tool must be gemini or claude');
  if (!windowFrom || !windowTo) throw bad('Record the export\'s actual date window');
  const sha = sha256(fileBuffer || Buffer.from(J({ tool, report, windowFrom, windowTo, rows })));
  return tx(db, () => {
    const ex = db.prepare('SELECT id FROM ai_usage_exports WHERE tenant_id = ? AND file_sha256 = ?').get(actor.tenantId, sha);
    if (ex) return { exportId: ex.id, duplicate: true };
    const id = uid('aix_');
    db.prepare('INSERT INTO ai_usage_exports (id, tenant_id, tool, report, window_from, window_to, exported_at, plan_note, spend_scope, imported_by, file_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, actor.tenantId, tool, report, windowFrom, windowTo, exportedAt || now(), planNote ?? null, spendScope ?? null, actor.id, sha);
    const ins = db.prepare('INSERT INTO ai_usage_rows (export_id, account_email, user_id, access, metric, value, availability) VALUES (?,?,?,?,?,?,?)');
    for (const r of rows) {
      const u = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND lower(email) = lower(?)').get(actor.tenantId, r.account_email);
      const access = r.access || 'unknown';
      // keep zero, not-reported and no-access distinct
      const availability = access === 'no_access' ? 'not_applicable' : r.value === null || r.value === undefined || r.value === '' ? 'not_reported' : 'reported';
      ins.run(id, r.account_email, u?.id ?? null, access, r.metric, availability === 'reported' ? Number(r.value) : null, availability);
    }
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'ai.import', entity: 'ai_usage_export', entityId: id, after: { tool, report, windowFrom, windowTo, rows: rows.length } });
    return { exportId: id, duplicate: false };
  });
}

/** Adoption view per export: counts with denominators, never summed across snapshots or tools. */
export function adoptionSummary(db, actor) {
  if (!isOps(actor)) throw forbid();
  return db.prepare('SELECT * FROM ai_usage_exports WHERE tenant_id = ? ORDER BY tool, window_from').all(actor.tenantId).map((e) => {
    const rows = db.prepare('SELECT * FROM ai_usage_rows WHERE export_id = ?').all(e.id);
    const accounts = [...new Set(rows.map((r) => r.account_email))];
    const state = (acct) => {
      const rs = rows.filter((r) => r.account_email === acct);
      if (rs.every((r) => r.access === 'no_access')) return 'no_access';
      if (rs.every((r) => r.availability === 'not_reported')) return 'not_reported';
      // passive_* metrics (features the tool runs by itself) never count as use
      return rs.some((r) => r.availability === 'reported' && r.value > 0 && !/^passive/.test(r.metric)) ? 'active' : 'zero';
    };
    const by = accounts.reduce((a, x) => { const s = state(x); a[s] = (a[s] || 0) + 1; return a; }, {});
    const unmatched = accounts.filter((a) => !rows.find((r) => r.account_email === a && r.user_id));
    const licensed = accounts.filter((a) => rows.some((r) => r.account_email === a && r.access === 'licensed')).length;
    const metrics = [...new Set(rows.map((r) => r.metric))].map((m) => ({ metric: m,
      reported_accounts: rows.filter((r) => r.metric === m && r.availability === 'reported').length,
      total: rows.filter((r) => r.metric === m && r.availability === 'reported').reduce((a, r) => a + r.value, 0) }));
    const shared = db.prepare("SELECT seat_email, COUNT(DISTINCT candidate_name) n FROM ai_seat_attributions WHERE tenant_id = ? AND tool = ? AND status != 'rejected' GROUP BY seat_email HAVING n > 1").all(actor.tenantId, e.tool);
    return { export: e, denominators: { accounts: accounts.length, licensed }, accounts_by_state: by, unmatched_accounts: unmatched, metrics,
      shared_seats: shared.map((s) => s.seat_email),
      caveats: [`Window ${e.window_from} → ${e.window_to}; compare only with exports of the same window and tool`,
        e.tool === 'claude' ? 'Claude requests are not comparable with Gemini interactions' : 'Gemini interactions are not comparable with Claude requests',
        ...(e.spend_scope ? [`Spend scope: ${e.spend_scope}`] : []),
        ...(shared.length ? ['Some seats are shared by several people — seat figures are not individual figures'] : [])] };
  });
}

// ------------------------------------------------------- seat attribution --
export function importSeatCandidates(db, actor, rows, { source }) {
  if (!isOps(actor)) throw forbid();
  return tx(db, () => {
    let n = 0;
    for (const r of rows) {
      const u = r.candidate_email ? db.prepare('SELECT id FROM users WHERE tenant_id = ? AND lower(email) = lower(?)').get(actor.tenantId, r.candidate_email) : null;
      const dupe = db.prepare('SELECT 1 FROM ai_seat_attributions WHERE tenant_id = ? AND seat_email = ? AND IFNULL(engagement,\'\') = IFNULL(?,\'\') AND candidate_name = ? AND evidence_type = ?')
        .get(actor.tenantId, r.seat_email, r.engagement ?? null, r.candidate_name, r.evidence_type);
      if (dupe) continue;
      db.prepare(`INSERT INTO ai_seat_attributions (id, tenant_id, tool, seat_email, engagement, user_id, candidate_name, evidence_type, evidence_detail, confidence, source, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(uid('seat_'), actor.tenantId, r.tool || 'claude', r.seat_email, r.engagement ?? null, u?.id ?? null, r.candidate_name,
        r.evidence_type, r.evidence_detail ?? null, ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'low', source, now());
      if (r.status === 'confirmed') db.prepare("UPDATE ai_seat_attributions SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE tenant_id = ? AND seat_email = ? AND candidate_name = ? AND evidence_type = ?")
        .run(actor.id, now(), actor.tenantId, r.seat_email, r.candidate_name, r.evidence_type);
      n++;
    }
    return n;
  });
}

/** The person themself confirms (or rejects) that they used a seat for an engagement. */
export function confirmSeatAttribution(db, actor, id, { decision }) {
  return tx(db, () => {
    const a = db.prepare('SELECT * FROM ai_seat_attributions WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId);
    if (!a) throw notFound();
    if (a.user_id !== actor.id && !isOps(actor)) throw forbid();
    const status = decision === 'reject' ? 'rejected' : 'confirmed';
    db.prepare('UPDATE ai_seat_attributions SET status = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ?').run(status, actor.id, now(), id);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: `seat.${status}`, entity: 'ai_seat_attribution', entityId: id });
    return status;
  });
}

export function mySeatAttributions(db, actor) {
  return db.prepare("SELECT id, tool, seat_email, engagement, evidence_type, evidence_detail, confidence, status FROM ai_seat_attributions WHERE tenant_id = ? AND user_id = ? ORDER BY seat_email, engagement").all(actor.tenantId, actor.id);
}

// ------------------------------------------------------------- examples --
export function saveExample(db, actor, ex) {
  for (const k of ['task', 'tool', 'verification']) if (!String(ex[k] || '').trim()) throw bad(`${k} is required`);
  if (ex.timeSavedEstimate && !String(ex.estimateBasis || '').trim()) throw bad('Time-saved estimates need a stated basis');
  if (ex.linkedPlanItemId) {
    const it = db.prepare('SELECT i.id FROM plan_items i JOIN plans p ON p.id = i.plan_id WHERE i.id = ? AND p.user_id = ?').get(ex.linkedPlanItemId, actor.id);
    if (!it) throw bad('AI examples can only support an objective or competency in your own plan');
  }
  const id = ex.id || uid('aie_');
  db.prepare(`INSERT INTO ai_examples (id, tenant_id, user_id, project_id, deliverable_id, task, tool, why, contribution, verification, risk_handling, outcome, time_saved_estimate, estimate_basis, linked_plan_item_id, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, actor.tenantId, actor.id, ex.projectId ?? null, ex.deliverableId ?? null, ex.task, ex.tool, ex.why ?? null,
    ex.contribution ?? null, ex.verification, ex.riskHandling ?? null, ex.outcome ?? null, ex.timeSavedEstimate ? `Estimate: ${ex.timeSavedEstimate}` : null,
    ex.estimateBasis ?? null, ex.linkedPlanItemId ?? null, ex.submit ? 'approved' : 'draft', now());
  return id;
}

export function getExample(db, actor, id) {
  const ex = db.prepare('SELECT * FROM ai_examples WHERE id = ?').get(id);
  if (!ex || !aiExampleAccess(db, actor, ex)) throw forbid();
  return ex;
}
