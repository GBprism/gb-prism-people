// Import batches: preview → (reviewed) apply → optional reversal.
// A batch stores every source row with its match result, issues and the
// proposed action. Re-uploading an identical file returns the existing batch
// (file fingerprint), and every write uses stable source keys so applying
// twice can never duplicate data.
import { tx, uid, now, J, P, audit, bad, conflict, forbid, notFound } from '../db.js';
import { isOps } from '../domain/authz.js';

export function findExisting(db, tenantId, kind, sha) {
  return db.prepare("SELECT * FROM import_batches WHERE tenant_id = ? AND kind = ? AND file_sha256 = ? AND status IN ('previewed','applied') ORDER BY created_at DESC LIMIT 1").get(tenantId, kind, sha);
}

export function saveBatch(db, actor, { kind, filename, sha, vendor, generatedAt, reportingFrom, reportingTo, filtersNote, summary, rows }) {
  if (!isOps(actor)) throw forbid();
  return tx(db, () => {
    const id = uid('imp_');
    db.prepare(`INSERT INTO import_batches (id, tenant_id, kind, filename, file_sha256, vendor, generated_at, reporting_from, reporting_to, filters_note, status, summary_json, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'previewed',?,?,?)`).run(id, actor.tenantId, kind, filename, sha, vendor ?? null, generatedAt ?? null,
      reportingFrom ?? null, reportingTo ?? null, filtersNote ?? null, J(summary), actor.id, now());
    const ins = db.prepare('INSERT INTO import_rows (batch_id, sheet, row_no, source_key, raw_json, match_user_id, match_status, issues_json, action) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const r of rows) ins.run(id, r.sheet ?? null, r.rowNo ?? null, r.sourceKey ?? null, J(r.raw), r.userId ?? null, r.matchStatus || 'n/a', J(r.issues || []), r.action);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'import.preview', entity: 'import_batch', entityId: id, after: { kind, filename, sha } });
    return getBatch(db, actor, id);
  });
}

export function getBatch(db, actor, id) {
  if (!isOps(actor)) throw forbid();
  const b = db.prepare('SELECT * FROM import_batches WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId);
  if (!b) throw notFound('Import batch not found');
  const rows = db.prepare('SELECT * FROM import_rows WHERE batch_id = ? ORDER BY id').all(id)
    .map((r) => ({ ...r, raw: P(r.raw_json), issues: P(r.issues_json, []), raw_json: undefined, issues_json: undefined }));
  return { ...b, summary: P(b.summary_json), summary_json: undefined, rows };
}

/** Matching: verified work email, then verified alias. Never auto-creates or merges people. */
export function matchPerson(db, tenantId, { email, name, source }) {
  if (email) {
    const u = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND lower(email) = lower(?)').get(tenantId, email.trim());
    if (u) return { userId: u.id, matchStatus: 'email' };
  }
  if (name) {
    const a = db.prepare('SELECT user_id, verified FROM identity_aliases WHERE tenant_id = ? AND source = ? AND lower(alias) = lower(?)').get(tenantId, source, name.trim());
    if (a && a.verified && a.user_id) return { userId: a.user_id, matchStatus: 'alias' };
    if (a && !a.verified) return { userId: null, matchStatus: 'alias_unverified' };
    const exact = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND lower(name) = lower(?)').all(tenantId, name.trim());
    if (exact.length === 1) return { userId: null, matchStatus: 'name_only_needs_confirmation', suggestion: exact[0].id };
  }
  return { userId: null, matchStatus: 'unmatched' };
}

export function markApplied(db, actor, batch) {
  const r = db.prepare("UPDATE import_batches SET status = 'applied', approved_by = ?, applied_at = ? WHERE id = ? AND status = 'previewed'").run(actor.id, now(), batch.id);
  if (r.changes !== 1) throw conflict('Batch was already applied or rejected');
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'import.apply', entity: 'import_batch', entityId: batch.id, after: { kind: batch.kind } });
}

export function requirePreviewed(batch) {
  if (batch.status === 'applied') throw conflict('This batch has already been applied (re-import is a no-op)');
  if (batch.status !== 'previewed') throw conflict(`Batch is ${batch.status}`);
  if (batch.summary?.blocking?.length) throw bad('Batch has blocking problems; fix the source and upload again', batch.summary.blocking);
}

/** Generic reversal: removes rows written by the batch, with an audit record. */
export function reverseBatch(db, actor, id, { reason }) {
  if (!isOps(actor)) throw forbid();
  if (!String(reason || '').trim()) throw bad('Reversal needs a reason');
  return tx(db, () => {
    const b = db.prepare('SELECT * FROM import_batches WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId);
    if (!b) throw notFound();
    if (b.status !== 'applied') throw conflict('Only applied batches can be reversed');
    const counts = {};
    counts.snapshot = db.prepare('DELETE FROM vendor_snapshot_values WHERE batch_id = ?').run(id).changes;
    counts.attendance = db.prepare('DELETE FROM attendance_days WHERE batch_id = ?').run(id).changes;
    // ledger is append-only: post compensating entries instead of deleting
    const led = db.prepare('SELECT * FROM leave_ledger WHERE batch_id = ?').all(id);
    for (const e of led) db.prepare(`INSERT OR IGNORE INTO leave_ledger (tenant_id, user_id, type_id, period_year, kind, amount_x100, effective_date, request_id, note, actor_id, entry_key, batch_id, created_at)
        VALUES (?,?,?,?, 'adjustment', ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.tenant_id, e.user_id, e.type_id, e.period_year, -e.amount_x100, e.effective_date, e.request_id, `Reversal of import ${id}: ${reason}`, actor.id, `reverse:${e.entry_key}`, null, now());
    counts.ledger_compensations = led.length;
    // released / closed plans are never touched by reversal
    const plans = db.prepare("SELECT id FROM plans WHERE source_ref LIKE ? AND state IN ('draft_plan','approved_plan')").all(`${id}:%`);
    for (const p of plans) { db.prepare('DELETE FROM plan_items WHERE plan_id = ?').run(p.id); db.prepare('DELETE FROM plan_transitions WHERE plan_id = ?').run(p.id); db.prepare('DELETE FROM plan_revisions WHERE plan_id = ?').run(p.id); db.prepare('DELETE FROM plans WHERE id = ?').run(p.id); }
    counts.plans = plans.length;
    counts.requests = db.prepare("UPDATE leave_requests SET state = 'cancelled', decision_note = ? WHERE source_ref LIKE ? AND source = 'leaveboard'").run(`Import ${id} reversed`, `${id}%`).changes;
    db.prepare("UPDATE import_batches SET status = 'reversed', reversed_by = ?, reversed_at = ?, reversal_reason = ? WHERE id = ?").run(actor.id, now(), reason, id);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'import.reverse', entity: 'import_batch', entityId: id, reason, after: counts });
    return counts;
  });
}
