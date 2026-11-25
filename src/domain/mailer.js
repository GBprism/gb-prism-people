// Email notifications for things that need someone's action: a leave request, an expense claim, a
// letter request, a CV update, a message… They go through the same outbox as review reminders
// (deduplicated, retried, audited) and are sent by SMTP when the server has SMTP settings.
// Content is a one-line summary and a link — never balances, amounts of pay, ratings or attachments.
import { uid, now } from '../db.js';

const settingOf = (db, t, k) => { const r = db.prepare('SELECT value_json FROM settings WHERE tenant_id = ? AND key = ?').get(t, k); return r ? JSON.parse(r.value_json) : null; };
const baseUrl = (db, t) => (settingOf(db, t, 'base_url') || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

/** People who handle requests: GB's leave approver and People Ops. */
export function adminRecipients(db, tenantId, exclude = null) {
  const ids = new Set();
  const a = settingOf(db, tenantId, 'leave_approver'); if (a) ids.add(a);
  for (const r of db.prepare("SELECT DISTINCT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'people_ops' WHERE u.tenant_id = ? AND u.active = 1").all(tenantId)) ids.add(r.id);
  ids.delete(exclude);
  return [...ids];
}

export function emailOn(db, userId) {
  const r = db.prepare("SELECT value_json FROM user_prefs WHERE user_id = ? AND key = 'email_notifications'").get(userId);
  return r ? JSON.parse(r.value_json) !== false : true;
}

/**
 * Queue one email per recipient. `key` makes it idempotent (same event, same person → one email).
 * Recipients who switched emails off still see the item in their inbox in the portal.
 */
export function notify(db, { tenantId, to, event, subject, text, link, key }) {
  const list = [].concat(to).filter(Boolean);
  for (const userId of new Set(list)) {
    const u = db.prepare('SELECT id, name, email, active FROM users WHERE id = ? AND tenant_id = ?').get(userId, tenantId);
    if (!u?.active || !u.email || !emailOn(db, u.id)) continue;
    const url = `${baseUrl(db, tenantId)}/${link || ''}`;
    const body = `Hi ${u.name.split(' ')[0]},\n\n${text}\n\nOpen it in GB People: ${url}\n\n— GB People & Performance\n(You can turn these emails off in My profile.)`;
    db.prepare(`INSERT OR IGNORE INTO notification_outbox (id, tenant_id, dedupe_key, event, recipient_id, to_email, subject, body, link, task_ref, scheduled_for, mode, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?, 'event', ?, 'live', 'queued', ?)`).run(uid('ntf_'), tenantId, `ev:${event}:${key}:${u.id}`, event, u.id, u.email, subject.slice(0, 180), body, url, now(), now());
  }
}

/** SMTP transport from server-only settings (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM). */
export async function smtpTransport(env = process.env) {
  if (!env.SMTP_HOST) return null;
  const nodemailer = (await import('nodemailer')).default;
  const t = nodemailer.createTransport({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: Number(env.SMTP_PORT) === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined, disableFileAccess: true, disableUrlAccess: true });
  const from = env.MAIL_FROM || env.SMTP_USER;
  return async (m) => { await t.sendMail({ from, to: m.to, subject: m.subject, text: m.text, headers: m.headers }); };
}
