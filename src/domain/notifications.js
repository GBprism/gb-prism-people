// Review reminders. Plan → preview → queue → deliver.
// * Recipients and links are permission-checked when the item is built AND
//   again at send time; completed tasks are suppressed.
// * Content never includes ratings, comments or attachments.
// * dedupe_key = cycle/task/event/recipient, so a job can run any number of times.
// * mode 'test' redirects every message to the configured test inbox.
import { tx, uid, now, J, P, audit, bad, forbid } from '../db.js';
import { isOps, planAccess, loadActor } from './authz.js';
import { addBusinessDays, todayIn } from './dates.js';

export const DEFAULT_CADENCE = { dueSoonBusinessDays: 3, overdueBusinessDays: 1, workweek: [0, 1, 2, 3, 4], timezone: 'Asia/Amman', sendHour: 9 };

const T = {
  launch: (c) => ({ subject: `${c.cycle} self-assessment is open`, body: `Hi ${c.first},\n\nYour ${c.cycle} self-assessment is open in GB Prism. Please complete it by ${c.due} (Amman time).\n\nStart with the objectives, competencies and initiatives in your agreed plan. If your approved plan or a project assignment looks wrong, flag it with your manager.\n\nOpen your review: ${c.link}\n\nThank you,\n${c.sender}` }),
  due_soon: (c) => ({ subject: `Reminder — ${c.cycle} self-assessment due ${c.due}`, body: `Hi ${c.first}, your ${c.cycle} self-assessment is due on ${c.due} (Amman time). Please submit through ${c.link}. If you're missing your approved plan or a project assignment needs correcting, flag it with your manager. Thank you, ${c.sender}.` }),
  overdue: (c) => ({ subject: `${c.cycle} self-assessment is overdue`, body: `Hi ${c.first}, your ${c.cycle} self-assessment was due on ${c.due}. Please submit it as soon as you can: ${c.link}. Thank you, ${c.sender}.` }),
  manager_review: (c) => ({ subject: `Review ready: ${c.employee}`, body: `Hi ${c.first}, ${c.employee} has submitted their ${c.cycle} self-assessment. Please complete the manager review${c.managerDue ? ` by ${c.managerDue}` : ''}: ${c.link}` }),
  calibration: (c) => ({ subject: `Calibration waiting: ${c.employee}`, body: `Hi ${c.first}, a ${c.cycle} review for ${c.employee} is ready for partner calibration: ${c.link}` }),
  release: (c) => ({ subject: `Your ${c.cycle} review result is available`, body: `Hi ${c.first}, your ${c.cycle} review result is available in GB Prism. Please read it before your 1:1 and acknowledge receipt (acknowledging is not the same as agreeing): ${c.link}` }),
  goal_approval: (c) => ({ subject: `${c.cycle} goals waiting for approval: ${c.employee}`, body: `Hi ${c.first}, ${c.employee} has drafted ${c.cycle} goals. Please review measures, targets, weights and support, then approve: ${c.link}` }),
};

export function settings(db, tenantId) {
  const get = (k, d) => { const r = db.prepare('SELECT value_json FROM settings WHERE tenant_id = ? AND key = ?').get(tenantId, k); return r ? P(r.value_json) : d; };
  return { cadence: { ...DEFAULT_CADENCE, ...get('reminder_cadence', {}) }, mode: get('notification_mode', 'test'), testInbox: get('notification_test_inbox', null),
    sender: get('notification_sender_name', 'People & Performance'), baseUrl: get('base_url', process.env.BASE_URL || 'http://localhost:3000') };
}

/** Work out which reminders are due on `asOf` (Amman date). Returns items, nothing is written unless queue=true. */
export function planReminders(db, actor, { cycleId, asOf = todayIn(), queue = false }) {
  if (!isOps(actor)) throw forbid();
  const cycle = db.prepare('SELECT * FROM cycles WHERE id = ? AND tenant_id = ?').get(cycleId, actor.tenantId);
  if (!cycle) throw bad('Unknown cycle');
  const s = settings(db, actor.tenantId); const c = s.cadence;
  const hol = new Set(db.prepare("SELECT date FROM holidays WHERE tenant_id = ? AND calendar = 'JO'").all(actor.tenantId).map((h) => h.date));
  const items = [];
  const plans = db.prepare('SELECT * FROM plans WHERE cycle_id = ? AND tenant_id = ?').all(cycleId, actor.tenantId);
  for (const p of plans) {
    const emp = db.prepare('SELECT * FROM users WHERE id = ?').get(p.user_id);
    const push = (event, recipientId, extra = {}) => {
      const r = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(recipientId || '');
      if (!r) return;
      const ra = loadActor(db, r.id);
      if (!planAccess(db, ra, p)) return; // never link someone to a record they cannot open
      const link = `${s.baseUrl}/#/review/${p.id}`;
      const ctx = { first: r.name.split(' ')[0], cycle: cycle.name, due: cycle.self_due, managerDue: cycle.manager_due, employee: emp.name, link, sender: s.sender, ...extra };
      const { subject, body } = T[event](ctx);
      items.push({ dedupe_key: `${cycle.id}:${p.id}:${event}:${r.id}`, event, recipient_id: r.id, to_email: r.email, subject, body, link, task_ref: `${p.id}:${p.state}` });
    };
    const selfOpen = ['approved_plan', 'self_assessment'].includes(p.state);
    if (selfOpen) {
      push('launch', p.user_id);
      if (cycle.self_due) {
        const soon = addBusinessDays(cycle.self_due, -c.dueSoonBusinessDays, c.workweek, hol);
        const late = addBusinessDays(cycle.self_due, c.overdueBusinessDays, c.workweek, hol);
        if (asOf >= soon && asOf <= cycle.self_due) push('due_soon', p.user_id);
        if (asOf >= late) push('overdue', p.user_id);
      }
    }
    if (p.state === 'manager_review') push('manager_review', p.reviewer_id);
    if (p.state === 'partner_calibration') push('calibration', p.partner_id);
    if (p.state === 'released') push('release', p.user_id);
    if (p.state === 'draft_plan' && cycle.status === 'planning') push('goal_approval', p.reviewer_id);
  }
  const fresh = items.filter((i) => !db.prepare('SELECT 1 FROM notification_outbox WHERE tenant_id = ? AND dedupe_key = ?').get(actor.tenantId, i.dedupe_key));
  if (queue) {
    tx(db, () => {
      const scheduled = `${asOf}T${String(c.sendHour).padStart(2, '0')}:00:00+03:00`;
      for (const i of fresh) {
        const to = s.mode === 'test' ? (s.testInbox || bad('Set a test inbox before queueing in test mode')) : i.to_email;
        db.prepare(`INSERT OR IGNORE INTO notification_outbox (id, tenant_id, dedupe_key, event, recipient_id, to_email, subject, body, link, task_ref, scheduled_for, mode, status, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'queued',?)`).run(uid('ntf_'), actor.tenantId, i.dedupe_key, i.event, i.recipient_id, to, i.subject, i.body, i.link, i.task_ref, scheduled, s.mode, now());
      }
      audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'notifications.queue', entity: 'cycle', entityId: cycleId, after: { queued: fresh.length, mode: s.mode } });
    });
  }
  return { asOf, mode: s.mode, testInbox: s.testInbox, items: fresh, already_sent_or_queued: items.length - fresh.length };
}

/** Is the task behind a reminder still outstanding? */
function stillOutstanding(db, n) {
  const [planId, stateAtQueue] = n.task_ref.split(':');
  const p = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!p) return false;
  if (p.state !== stateAtQueue) return false; // task completed or moved on
  const r = loadActor(db, n.recipient_id);
  return !!(r && planAccess(db, r, p));
}

/**
 * Deliver queued (and retry failed) messages. `transport(msg)` must throw on
 * failure. Safe to run repeatedly: sent items are never re-sent.
 */
export async function deliver(db, { tenantId, transport, maxAttempts = 5, nowIso = new Date().toISOString() }) {
  const due = db.prepare("SELECT * FROM notification_outbox WHERE tenant_id = ? AND status IN ('queued','failed') AND attempts < ? ORDER BY created_at")
    .all(tenantId, maxAttempts);
  const res = { sent: 0, failed: 0, suppressed: 0 };
  for (const n of due) {
    if (new Date(n.scheduled_for) > new Date(nowIso)) continue;
    if (!stillOutstanding(db, n)) {
      db.prepare("UPDATE notification_outbox SET status = 'suppressed', last_error = 'Task completed or access changed before send' WHERE id = ?").run(n.id);
      res.suppressed++; continue;
    }
    // claim the row first so a parallel worker cannot send it too
    const claim = db.prepare("UPDATE notification_outbox SET attempts = attempts + 1 WHERE id = ? AND status IN ('queued','failed') AND attempts = ?").run(n.id, n.attempts);
    if (claim.changes !== 1) continue;
    try {
      await transport({ to: n.to_email, subject: n.subject, text: n.body, headers: { 'X-Prism-Dedupe': n.dedupe_key } });
      db.prepare("UPDATE notification_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?").run(new Date().toISOString(), n.id);
      res.sent++;
    } catch (e) {
      db.prepare("UPDATE notification_outbox SET status = 'failed', last_error = ? WHERE id = ?").run(String(e.message).slice(0, 300), n.id);
      res.failed++;
    }
  }
  return res;
}

export function outbox(db, actor, { limit = 200 } = {}) {
  if (!isOps(actor)) throw forbid();
  return db.prepare('SELECT id, event, to_email, subject, status, attempts, last_error, scheduled_for, sent_at, mode FROM notification_outbox WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?').all(actor.tenantId, limit);
}

/** Dev transport: writes .eml files instead of sending. Production wires Prism's mailer here. */
export function fileTransport(dir) {
  return async (m) => {
    const fs = await import('node:fs'); const path = await import('node:path');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.eml`), `To: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n`);
  };
}
