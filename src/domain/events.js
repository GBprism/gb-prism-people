// Who gets an email when something happens. Each function is called after the action succeeds.
import { notify, adminRecipients } from './mailer.js';
import { officeAdmins, EXPIRY_WARN_DAYS } from './office.js';

const name = (db, id) => db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || 'Someone';
const range = (a, b) => (a === b ? a : `${a} → ${b}`);

export function leaveChanged(db, r) {
  if (!r) return;
  const who = name(db, r.user_id); const type = db.prepare('SELECT name FROM leave_types WHERE id = ?').get(r.type_id)?.name || 'Time off';
  const base = { tenantId: r.tenant_id, link: `#/request/${r.id}` };
  if (r.state === 'submitted' && r.stage === 'pm') notify(db, { ...base, to: r.pm_id, event: 'leave.pm', key: r.id, subject: `Time off to approve: ${who}`, text: `${who} asked for ${type} (${range(r.start_date, r.end_date)}). As their project manager, please approve or decline first; it then goes to the final approver.` });
  else if (r.state === 'submitted') notify(db, { ...base, to: r.approver_id, event: 'leave.final', key: r.id, subject: `Time off to approve: ${who}`, text: `${who} asked for ${type} (${range(r.start_date, r.end_date)})${r.pm_decided_at ? ', approved by their project manager' : ''}. Please approve or decline.` });
  else if (['approved', 'declined', 'cancelled'].includes(r.state)) notify(db, { ...base, to: r.user_id, event: `leave.${r.state}`, key: r.id, subject: `Your time off was ${r.state}`, text: `Your ${type} request (${range(r.start_date, r.end_date)}) was ${r.state}.${r.decision_note ? ` Note: ${r.decision_note}` : ''}` });
}

export function expenseChanged(db, c) {
  if (!c) return;
  const base = { tenantId: c.tenant_id, link: '#/expenses' };
  const amount = `${(c.total_x100 / 100).toFixed(2)} ${c.currency}`;
  if (c.status === 'submitted') notify(db, { ...base, link: '#/expenses?tab=approve', to: c.approver_id, event: 'expense.submitted', key: `${c.id}:${c.submitted_at}`, subject: `Expense claim to approve: ${name(db, c.user_id)}`, text: `${name(db, c.user_id)} submitted “${c.title}” (${amount}) with receipts. Please approve or return it.` });
  else if (c.status === 'approved') notify(db, { ...base, to: c.user_id, event: 'expense.approved', key: c.id, subject: 'Your expense claim was approved', text: `“${c.title}” (${amount}) was approved and goes to People Ops for payment.` });
  else if (c.status === 'draft' && c.decision_note) notify(db, { ...base, to: c.user_id, event: 'expense.returned', key: `${c.id}:${c.decided_at}`, subject: 'Your expense claim was returned', text: `“${c.title}” needs a change: ${c.decision_note}` });
  else if (c.status === 'paid') notify(db, { ...base, to: c.user_id, event: 'expense.paid', key: c.id, subject: 'Your expenses were paid', text: `“${c.title}” (${amount}) was marked paid.` });
  else if (c.status === 'rejected') notify(db, { ...base, to: c.user_id, event: 'expense.cancelled', key: c.id, subject: 'Your expense claim was cancelled', text: `“${c.title}” was cancelled.${c.decision_note ? ` Note: ${c.decision_note}` : ''}` });
}

export function letterRequested(db, r) {
  notify(db, { tenantId: r.tenant_id, to: adminRecipients(db, r.tenant_id, r.user_id), event: 'letter.requested', key: r.id, link: '#/letters', subject: `Letter request: ${name(db, r.user_id)}`, text: `${name(db, r.user_id)} asked for a ${r.kind.replace(/_/g, ' ')}${r.needed_by ? `, needed by ${r.needed_by}` : ''}.` });
}
export function letterDecided(db, r) {
  notify(db, { tenantId: r.tenant_id, to: r.user_id, event: `letter.${r.status}`, key: r.id, link: '#/letters', subject: `Your letter request was ${r.status === 'issued' ? 'issued' : 'declined'}`, text: r.status === 'issued' ? 'Your letter is ready — People Ops will hand it over.' : `Your letter request was declined. ${r.note || ''}` });
}
export function cvUpdateProposed(db, tenantId, userId) {
  notify(db, { tenantId, to: adminRecipients(db, tenantId, userId), event: 'cv.proposed', key: `${userId}:${new Date().toISOString().slice(0, 13)}`, link: '#/company', subject: `Profile update to review: ${name(db, userId)}`, text: `${name(db, userId)} sent changes to their profile / CV for approval.` });
}
export function timesheetSubmitted(db, tenantId, userId, month) {
  notify(db, { tenantId, to: adminRecipients(db, tenantId, userId), event: 'timesheet.submitted', key: `${userId}:${month}`, link: `#/timesheet?tab=report&m=${month}`, subject: `Timesheet submitted: ${name(db, userId)} (${month})`, text: `${name(db, userId)} submitted their ${month} timesheet.` });
}
export function gymSubmitted(db, g) {
  notify(db, { tenantId: g.tenant_id, to: adminRecipients(db, g.tenant_id, g.user_id), event: 'gym.submitted', key: g.id, link: '#/expenses?tab=gym', subject: `Gym allowance to approve: ${name(db, g.user_id)}`, text: `${name(db, g.user_id)} attached a gym registration (${g.gym_name}, ${range(g.valid_from, g.valid_to)}) for the gym allowance.` });
}
export function gymDecided(db, g) {
  notify(db, { tenantId: g.tenant_id, to: g.user_id, event: `gym.${g.status}`, key: g.id, link: '#/expenses?tab=gym', subject: `Your gym allowance was ${g.status}`, text: g.status === 'approved' ? `Your gym registration (${range(g.valid_from, g.valid_to)}) is approved; the allowance applies for that period.` : `Your gym allowance request was not approved. ${g.note || ''}` });
}
/** A new message: email members who have not read the conversation, at most one email per conversation per hour. */
export function messageSent(db, conversationId, senderId) {
  const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  // project discussions stay quiet: only @mentions send an email (handled when the message is sent)
  if (String(c.direct_key || '').startsWith('project:')) return;
  const hour = new Date().toISOString().slice(0, 13);
  const others = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?').all(conversationId, senderId).map((r) => r.user_id);
  notify(db, { tenantId: c.tenant_id, to: others, event: 'message', key: `${conversationId}:${hour}`, link: `#/messages?c=${conversationId}`, subject: `New message from ${name(db, senderId)}${c.kind === 'group' && c.title ? ` in ${c.title}` : ''}`, text: `${name(db, senderId)} sent you a message in GB People.` });
}
/** Daily: documents that expired or expire within the warning window, once a week per document. */
export function remindExpiringDocuments(db, tenantId) {
  const today = new Date().toISOString().slice(0, 10);
  const limit = new Date(Date.now() + EXPIRY_WARN_DAYS * 864e5).toISOString().slice(0, 10);
  const week = `${today.slice(0, 4)}-w${Math.ceil(((Date.parse(today) - Date.parse(`${today.slice(0, 4)}-01-01`)) / 864e5 + 1) / 7)}`;
  const to = [...new Set([...officeAdmins(db, tenantId), ...adminRecipients(db, tenantId)])];
  for (const d of db.prepare('SELECT * FROM company_documents WHERE tenant_id = ? AND archived = 0 AND expires_on IS NOT NULL AND expires_on <= ?').all(tenantId, limit)) {
    notify(db, { tenantId, to: [...to, d.renewal_owner_id], event: 'document.expiry', key: `${d.id}:${week}`, link: '#/documents', subject: `${d.expires_on < today ? 'Expired' : 'Renew soon'}: ${d.title}`, text: `${d.title}${d.number ? ` (${d.number})` : ''} ${d.expires_on < today ? 'expired' : 'expires'} on ${d.expires_on}.` });
  }
}
