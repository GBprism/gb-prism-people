// Engagement board. Cards ARE the project's deliverables (one record across the board, the project
// page, the register, Home and reminders). Columns are the existing deliverable statuses plus two new ones:
//   todo → in_progress → submitted (Internal review) → ready (Ready to send) → accepted (Done)
// Blocked is a flag with a short reason, not a column. Moving a card only changes the internal workflow;
// sending to the client and formal acceptance stay with their own actions.
// Access: the project's lead and current team, partners and People Ops — checked on every call. Anyone
// else gets "not found", so a deep link does not reveal that a card exists.
import { uid, now, audit, bad, forbid, notFound, conflict } from '../db.js';
import { isOps, has } from './authz.js';
import { todayIn } from './dates.js';
import { notify } from './mailer.js';

export const COLUMNS = [
  { key: 'todo', label: 'To do' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'submitted', label: 'Internal review' },
  { key: 'ready', label: 'Ready to send' },
  { key: 'accepted', label: 'Done' },
];
const KEYS = COLUMNS.map((c) => c.key);
const LABEL = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));
const statusOf = (s) => (s === 'done' ? 'accepted' : KEYS.includes(s) ? s : 'in_progress');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const okUrl = (u) => /^https:\/\/[^\s]+$/i.test(u || '');

// ------------------------------------------------------------------ access --
/** People who take part in a project: its lead and everyone on it now. */
export function participants(db, projectId) {
  const p = db.prepare('SELECT lead_user_id FROM projects WHERE id = ?').get(projectId);
  const ids = db.prepare(`SELECT DISTINCT a.user_id FROM project_assignments a JOIN users u ON u.id = a.user_id AND u.active = 1
      WHERE a.project_id = ? AND a.status IN ('confirmed','tentative','provisional') AND (a.end_date IS NULL OR a.end_date >= ?)`).all(projectId, todayIn()).map((r) => r.user_id);
  return [...new Set([p?.lead_user_id, ...ids].filter(Boolean))];
}
export function projectAccess(db, actor, projectId) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND tenant_id = ?').get(projectId, actor.tenantId);
  if (!p) throw notFound();
  const onTeam = participants(db, p.id).includes(actor.id);
  const manage = p.lead_user_id === actor.id || has(actor, 'partner') || isOps(actor);
  if (!onTeam && !manage) throw notFound();
  return { p, onTeam, manage, lead: p.lead_user_id === actor.id };
}
export function canSeeProject(db, actor, projectId) { try { projectAccess(db, actor, projectId); return true; } catch { return false; } }
function cardAccess(db, actor, cardId) {
  const c = db.prepare('SELECT d.* FROM deliverables d WHERE d.id = ? AND d.tenant_id = ?').get(cardId, actor.tenantId);
  if (!c) throw notFound();
  return { c, ...projectAccess(db, actor, c.project_id) };
}
const userName = (db, id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || null : null);
const link = (c, extra = '') => `#/project/${c.project_id}/board?card=${c.id}${extra}`;

function activity(db, c, actorId, action, detail = null) {
  db.prepare('INSERT INTO card_activity (id, tenant_id, card_id, actor_id, action, detail, created_at) VALUES (?,?,?,?,?,?,?)').run(uid('act_'), c.tenant_id, c.id, actorId, action, detail, now());
}
function touch(db, id) { db.prepare("UPDATE deliverables SET rev = rev + 1, updated_at = ? WHERE id = ?").run(now(), id); }

/** One action can create several alerts for the same person (assigned + mentioned): send one email each. */
function alerts(db, tenantId) {
  const sent = new Set();
  return (to, { event, key, subject, text, link: l }) => {
    const list = [].concat(to).filter((u) => u && !sent.has(u));
    list.forEach((u) => sent.add(u));
    if (list.length) notify(db, { tenantId, to: list, event, key, subject, text, link: l });
  };
}

/** @mentions: only people who can open the project; stored for Home until seen. */
export function recordMentions(db, actor, { projectId, userIds = [], cardId = null, commentId = null, conversationId = null, messageId = null, send, where, href }) {
  const allowed = new Set(participants(db, projectId));
  const out = [];
  for (const u of new Set(userIds)) {
    if (u === actor.id) continue;
    const ok = allowed.has(u) || (() => { const x = db.prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role IN (\'partner\',\'people_ops\',\'admin\')').get(u); return !!x; })();
    if (!ok) continue;
    db.prepare('INSERT INTO mentions (id, tenant_id, user_id, by_id, project_id, card_id, comment_id, conversation_id, message_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(uid('men_'), actor.tenantId, u, actor.id, projectId, cardId, commentId, conversationId, messageId, now());
    out.push(u);
  }
  if (out.length) send(out, { event: 'mention', key: `mention:${commentId || messageId}`, subject: `${actor.name} mentioned you`, text: `${actor.name} mentioned you ${where}.`, link: href });
  return out;
}
export function markMentionsSeen(db, actor, { cardId, messageIds = [] }) {
  if (cardId) db.prepare('UPDATE mentions SET seen_at = ? WHERE user_id = ? AND card_id = ? AND seen_at IS NULL').run(now(), actor.id, cardId);
  for (const m of messageIds) db.prepare('UPDATE mentions SET seen_at = ? WHERE user_id = ? AND message_id = ? AND seen_at IS NULL').run(now(), actor.id, m);
}

// -------------------------------------------------------------------- board --
function cardRow(db, c) {
  const chk = db.prepare('SELECT COUNT(*) n, COUNT(done_at) d FROM card_checklist WHERE card_id = ?').get(c.id);
  return { id: c.id, project_id: c.project_id, title: c.title, status: statusOf(c.status), workstream: c.workstream, milestone: c.milestone, due_date: c.due_date,
    owner_id: c.owner_id, owner: userName(db, c.owner_id), reviewer_id: c.qa_reviewer_id, reviewer: userName(db, c.qa_reviewer_id),
    blocked: c.blocked_reason ? { reason: c.blocked_reason, by: userName(db, c.blocked_by), at: c.blocked_at } : null,
    checklist: { total: chk.n, done: chk.d }, links: db.prepare('SELECT COUNT(*) n FROM card_links WHERE card_id = ?').get(c.id).n + (c.drive_url ? 1 : 0),
    comments: db.prepare('SELECT COUNT(*) n FROM card_comments WHERE card_id = ?').get(c.id).n, position: c.position, rev: c.rev };
}

export function boardView(db, actor, projectId) {
  const acc = projectAccess(db, actor, projectId);
  const cards = db.prepare("SELECT * FROM deliverables WHERE project_id = ? AND status != 'cancelled' ORDER BY COALESCE(position, 1e9), COALESCE(due_date, '9999'), title").all(projectId).map((c) => cardRow(db, c));
  const people = participants(db, projectId).map((id) => ({ id, name: userName(db, id) })).sort((a, b) => a.name.localeCompare(b.name));
  return { project: { id: acc.p.id, name: acc.p.name, lead_id: acc.p.lead_user_id, lead: userName(db, acc.p.lead_user_id) }, columns: COLUMNS, cards, people,
    workstreams: [...new Set(cards.map((c) => c.workstream).filter(Boolean))].sort(), today: todayIn(), can: { edit: acc.onTeam || acc.manage, manage: acc.manage, pin: acc.manage } };
}

export function cardDetail(db, actor, cardId) {
  const { c, manage, onTeam } = cardAccess(db, actor, cardId);
  markMentionsSeen(db, actor, { cardId });
  const src = c.source_message_id ? db.prepare('SELECT x.id, x.body, x.conversation_id, x.created_at, u.name sender FROM messages x JOIN users u ON u.id = x.sender_id WHERE x.id = ?').get(c.source_message_id) : null;
  return { ...cardRow(db, c), description: c.description, expected_output: c.expected_output, drive_url: c.drive_url,
    review: c.review_passed_by ? { by: userName(db, c.review_passed_by), at: c.review_passed_at } : null,
    checklist_items: db.prepare('SELECT id, text, done_at, done_by FROM card_checklist WHERE card_id = ? ORDER BY position, created_at').all(c.id).map((i) => ({ ...i, done_by_name: userName(db, i.done_by) })),
    link_items: db.prepare('SELECT id, url, label, added_by, created_at FROM card_links WHERE card_id = ? ORDER BY created_at').all(c.id),
    comment_items: db.prepare('SELECT k.id, k.body, k.created_at, k.author_id, u.name author FROM card_comments k JOIN users u ON u.id = k.author_id WHERE k.card_id = ? ORDER BY k.created_at').all(c.id),
    activity: db.prepare('SELECT a.action, a.detail, a.created_at, u.name actor FROM card_activity a LEFT JOIN users u ON u.id = a.actor_id WHERE a.card_id = ? ORDER BY a.created_at DESC LIMIT 50').all(c.id),
    source: src ? { id: src.id, text: src.body.slice(0, 200), sender: src.sender, at: src.created_at, link: `#/project/${c.project_id}/discussion?m=${src.id}` } : null,
    can: { edit: onTeam || manage, review: manage || c.qa_reviewer_id === actor.id, manage } };
}

/** New card. From a column ("Add task") or from a discussion message. */
export function createCard(db, actor, projectId, b = {}) {
  const acc = projectAccess(db, actor, projectId);
  if (!acc.onTeam && !acc.manage) throw forbid();
  const title = clip(b.title, 160); if (!title) throw bad('Give the task a title');
  const status = KEYS.includes(b.status) && !['submitted', 'ready', 'accepted'].includes(b.status) ? b.status : 'todo';
  const team = participants(db, projectId);
  if (b.owner_id && !team.includes(b.owner_id)) throw bad('The owner must be on this project');
  if (b.due_date && !isDate(b.due_date)) throw bad('Due date must be a date');
  let source = null;
  if (b.source_message_id) {
    source = db.prepare('SELECT x.id, x.conversation_id FROM messages x JOIN conversations c ON c.id = x.conversation_id WHERE x.id = ? AND c.project_id = ? AND c.tenant_id = ?').get(b.source_message_id, projectId, actor.tenantId);
    if (!source) throw bad('That message is not in this project’s discussion');
  }
  const pos = (db.prepare('SELECT MAX(position) m FROM deliverables WHERE project_id = ? AND status = ?').get(projectId, status).m ?? 0) + 1;
  const id = uid('dlv_'); const t = now();
  db.prepare(`INSERT INTO deliverables (id, tenant_id, project_id, workstream, title, due_date, status, owner_id, qa_reviewer_id, position, source_message_id, created_by, created_at, updated_at, description)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, actor.tenantId, projectId, clip(b.workstream, 60) || null, title, b.due_date || null, status, b.owner_id || null, null, pos, source?.id || null, actor.id, t, t, clip(b.description, 4000) || null);
  const c = db.prepare('SELECT * FROM deliverables WHERE id = ?').get(id);
  activity(db, c, actor.id, 'created', source ? 'from a discussion message' : LABEL[status]);
  if (c.owner_id && c.owner_id !== actor.id) alerts(db, actor.tenantId)(c.owner_id, { event: 'card.assigned', key: `assign:${id}:${c.owner_id}`, link: link(c), subject: `Assigned to you: ${title}`, text: `${actor.name} assigned you “${title}” on ${acc.p.name}${c.due_date ? `, due ${c.due_date}` : ''}.` });
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'card.create', entity: 'deliverable', entityId: id });
  return cardRow(db, c);
}

const FIELDS = { title: 160, description: 4000, expected_output: 2000, workstream: 60, milestone: 80 };
export function updateCard(db, actor, cardId, b = {}) {
  const { c, p, onTeam, manage } = cardAccess(db, actor, cardId);
  if (!onTeam && !manage) throw forbid();
  if (b.rev != null && Number(b.rev) !== c.rev) throw conflict('Someone else changed this card a moment ago. The latest version is shown.', cardRow(db, c));
  const team = participants(db, c.project_id);
  const set = {}; const notes = [];
  for (const [k, n] of Object.entries(FIELDS)) if (k in b) { const v = clip(b[k], n) || null; if (k === 'title' && !v) throw bad('A card needs a title'); if (v !== c[k]) { set[k] = v; notes.push(k.replace('_', ' ')); } }
  if ('due_date' in b) { if (b.due_date && !isDate(b.due_date)) throw bad('Due date must be a date'); if ((b.due_date || null) !== c.due_date) { set.due_date = b.due_date || null; notes.push(`due ${b.due_date || 'cleared'}`); } }
  if ('drive_url' in b) { if (b.drive_url && !okUrl(b.drive_url)) throw bad('Paste a full https:// link'); if ((b.drive_url || null) !== c.drive_url) { set.drive_url = b.drive_url || null; notes.push('working file'); } }
  if ('owner_id' in b && (b.owner_id || null) !== c.owner_id) { if (b.owner_id && !team.includes(b.owner_id)) throw bad('The owner must be on this project'); set.owner_id = b.owner_id || null; notes.push(`owner ${userName(db, b.owner_id) || 'cleared'}`); }
  if ('reviewer_id' in b && (b.reviewer_id || null) !== c.qa_reviewer_id) {
    if (b.reviewer_id && !team.includes(b.reviewer_id) && !manage) throw bad('The reviewer must be on this project');
    set.qa_reviewer_id = b.reviewer_id || null; notes.push(`reviewer ${userName(db, b.reviewer_id) || 'cleared'}`);
  }
  if (!Object.keys(set).length) return cardRow(db, c);
  db.prepare(`UPDATE deliverables SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(set), c.id);
  touch(db, c.id);
  activity(db, c, actor.id, 'edited', notes.join(', '));
  const send = alerts(db, actor.tenantId);
  if (set.owner_id && set.owner_id !== actor.id) send(set.owner_id, { event: 'card.assigned', key: `assign:${c.id}:${set.owner_id}`, link: link(c), subject: `Assigned to you: ${set.title || c.title}`, text: `${actor.name} assigned you “${set.title || c.title}” on ${p.name}.` });
  return cardRow(db, db.prepare('SELECT * FROM deliverables WHERE id = ?').get(c.id));
}

/**
 * Move a card to a column and/or a place in it. The review rules:
 *  - Internal review: by the owner or the lead; the checklist must be complete, nothing blocking;
 *    the reviewer is the card's reviewer, else the project lead. The reviewer is asked by email.
 *  - Ready to send: only the reviewer, the lead, a partner or People Ops — not the owner — and only
 *    from Internal review. Recorded as "review passed".
 *  - Done: from Ready to send (or straight from work when the card has no reviewer), by reviewer / lead.
 *  - Back from review to In progress = changes requested; the owner is told.
 */
export function moveCard(db, actor, cardId, { status, before_id = null, after_id = null, rev } = {}) {
  const { c, p, onTeam, manage } = cardAccess(db, actor, cardId);
  if (!onTeam && !manage) throw forbid();
  if (rev != null && Number(rev) !== c.rev) throw conflict('This card changed since you loaded the board. The latest version is shown.', cardRow(db, c));
  const from = statusOf(c.status); const to = status ? statusOf(status) : from;
  if (status && !KEYS.includes(status)) throw bad('Unknown column');
  const reviewer = c.qa_reviewer_id || (p.lead_user_id !== c.owner_id ? p.lead_user_id : null);
  const isReviewer = actor.id === reviewer || manage;
  const send = alerts(db, actor.tenantId);
  const set = {};
  if (to !== from) {
    if (to === 'submitted') {
      if (!(actor.id === c.owner_id || manage)) throw forbid('Only the owner or the project lead sends a card to internal review');
      if (c.blocked_reason) throw bad(`Clear the blocker first: ${c.blocked_reason}`);
      const chk = db.prepare('SELECT COUNT(*) n, COUNT(done_at) d FROM card_checklist WHERE card_id = ?').get(c.id);
      if (chk.n && chk.d < chk.n) throw bad(`Finish the checklist first (${chk.d} of ${chk.n} done)`);
      if (!reviewer) throw bad('Choose a reviewer first — the owner cannot review their own work');
      if (reviewer === c.owner_id) throw bad('The reviewer must be someone other than the owner');
      Object.assign(set, { status: 'submitted', qa_reviewer_id: reviewer, submitted_by: actor.id, submitted_at: now(), review_passed_by: null, review_passed_at: null });
    } else if (to === 'ready') {
      if (from !== 'submitted') throw bad('A card reaches Ready to send only after internal review');
      if (!isReviewer || actor.id === c.owner_id) throw forbid(`Only the reviewer (${userName(db, reviewer) || 'the project lead'}) or the project lead can pass the review`);
      Object.assign(set, { status: 'ready', review_passed_by: actor.id, review_passed_at: now() });
    } else if (to === 'accepted') {
      const needsReview = !!c.qa_reviewer_id;
      if (needsReview && from !== 'ready') throw bad('This card has a reviewer: it goes through Internal review and Ready to send first');
      if (!(isReviewer || (!needsReview && actor.id === c.owner_id))) throw forbid('Only the reviewer or the project lead marks it done');
      set.status = 'accepted';
    } else {
      // back to To do / In progress
      if (['submitted', 'ready', 'accepted'].includes(from) && !(isReviewer || actor.id === c.owner_id)) throw forbid('Only the owner, reviewer or lead can reopen a card in review');
      set.status = to;
    }
  }
  // position: between the given neighbours (fractional), else at the end of the column
  const pos = (id) => (id ? db.prepare('SELECT position FROM deliverables WHERE id = ? AND project_id = ?').get(id, c.project_id)?.position : null);
  const a = pos(after_id); const b = pos(before_id);
  if (a != null && b != null) set.position = (a + b) / 2;
  else if (a != null) set.position = a + 1;
  else if (b != null) set.position = b - 1;
  else if (to !== from) set.position = (db.prepare('SELECT MAX(position) m FROM deliverables WHERE project_id = ? AND status = ?').get(c.project_id, set.status).m ?? 0) + 1;
  if (!Object.keys(set).length) return cardRow(db, c);
  db.prepare(`UPDATE deliverables SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(set), c.id);
  touch(db, c.id);
  if (to !== from) {
    activity(db, c, actor.id, 'moved', `${LABEL[from]} → ${LABEL[to]}`);
    // only the moves that ask someone to act are announced; routine moves stay quiet
    if (to === 'submitted' && set.qa_reviewer_id !== actor.id) send(set.qa_reviewer_id, { event: 'card.review', key: `review:${c.id}:${set.submitted_at}`, link: link(c), subject: `Review requested: ${c.title}`, text: `${actor.name} sent “${c.title}” (${p.name}) to you for internal review.` });
    if (from === 'submitted' && ['todo', 'in_progress'].includes(to) && c.owner_id && c.owner_id !== actor.id) send(c.owner_id, { event: 'card.changes', key: `changes:${c.id}:${now()}`, link: link(c), subject: `Changes requested: ${c.title}`, text: `${actor.name} sent “${c.title}” back for changes. See the comments on the card.` });
    if (to === 'ready' && c.owner_id && c.owner_id !== actor.id) send(c.owner_id, { event: 'card.passed', key: `passed:${c.id}:${set.review_passed_at}`, link: link(c), subject: `Review passed: ${c.title}`, text: `${actor.name} passed the internal review of “${c.title}”. It is ready to send.` });
  }
  return cardRow(db, db.prepare('SELECT * FROM deliverables WHERE id = ?').get(c.id));
}

export function setBlocked(db, actor, cardId, { reason } = {}) {
  const { c, onTeam, manage } = cardAccess(db, actor, cardId);
  if (!onTeam && !manage) throw forbid();
  const r = clip(reason, 200);
  if (r) db.prepare('UPDATE deliverables SET blocked_reason = ?, blocked_by = ?, blocked_at = ? WHERE id = ?').run(r, actor.id, now(), c.id);
  else db.prepare('UPDATE deliverables SET blocked_reason = NULL, blocked_by = NULL, blocked_at = NULL WHERE id = ?').run(c.id);
  touch(db, c.id); activity(db, c, actor.id, r ? 'blocked' : 'unblocked', r || null);
  return cardRow(db, db.prepare('SELECT * FROM deliverables WHERE id = ?').get(c.id));
}

// ------------------------------------------------------------- checklist --
export function addChecklistItem(db, actor, cardId, { text } = {}) {
  const { c, onTeam, manage } = cardAccess(db, actor, cardId); if (!onTeam && !manage) throw forbid();
  const t = clip(text, 200); if (!t) throw bad('Write the checklist item');
  const pos = (db.prepare('SELECT MAX(position) m FROM card_checklist WHERE card_id = ?').get(c.id).m ?? 0) + 1;
  const id = uid('chk_'); db.prepare('INSERT INTO card_checklist (id, tenant_id, card_id, text, position, created_at) VALUES (?,?,?,?,?,?)').run(id, c.tenant_id, c.id, t, pos, now());
  touch(db, c.id); return { id };
}
export function setChecklistItem(db, actor, itemId, { done, text, remove } = {}) {
  const it = db.prepare('SELECT * FROM card_checklist WHERE id = ? AND tenant_id = ?').get(itemId, actor.tenantId); if (!it) throw notFound();
  const { c, onTeam, manage } = cardAccess(db, actor, it.card_id); if (!onTeam && !manage) throw forbid();
  if (remove) db.prepare('DELETE FROM card_checklist WHERE id = ?').run(itemId);
  else {
    if (text != null) { const t = clip(text, 200); if (!t) throw bad('Write the checklist item'); db.prepare('UPDATE card_checklist SET text = ? WHERE id = ?').run(t, itemId); }
    if (done != null) { db.prepare('UPDATE card_checklist SET done_by = ?, done_at = ? WHERE id = ?').run(done ? actor.id : null, done ? now() : null, itemId); activity(db, c, actor.id, done ? 'ticked' : 'unticked', it.text); }
  }
  touch(db, c.id); return { ok: true };
}

// ------------------------------------------------------------------ links --
export function addLink(db, actor, cardId, { url, label } = {}) {
  const { c, onTeam, manage } = cardAccess(db, actor, cardId); if (!onTeam && !manage) throw forbid();
  if (!okUrl(url)) throw bad('Paste a full https:// link (Google Drive, Docs, Sheets or Slides)');
  const id = uid('lnk_'); db.prepare('INSERT INTO card_links (id, tenant_id, card_id, url, label, added_by, created_at) VALUES (?,?,?,?,?,?,?)').run(id, c.tenant_id, c.id, url.trim(), clip(label, 80) || null, actor.id, now());
  touch(db, c.id); activity(db, c, actor.id, 'linked a file', clip(label, 80) || null); return { id };
}
export function removeLink(db, actor, linkId) {
  const l = db.prepare('SELECT * FROM card_links WHERE id = ? AND tenant_id = ?').get(linkId, actor.tenantId); if (!l) throw notFound();
  const { c, onTeam, manage } = cardAccess(db, actor, l.card_id); if (!onTeam && !manage) throw forbid();
  db.prepare('DELETE FROM card_links WHERE id = ?').run(linkId); touch(db, c.id); return { ok: true };
}

// --------------------------------------------------------------- comments --
export function addComment(db, actor, cardId, { body, mentions = [] } = {}) {
  const { c, p } = cardAccess(db, actor, cardId);
  const t = clip(body, 4000); if (!t) throw bad('Write a comment');
  const id = uid('cmt_'); db.prepare('INSERT INTO card_comments (id, tenant_id, card_id, author_id, body, created_at) VALUES (?,?,?,?,?,?)').run(id, c.tenant_id, c.id, actor.id, t, now());
  activity(db, c, actor.id, 'commented');
  const send = alerts(db, actor.tenantId);
  recordMentions(db, actor, { projectId: c.project_id, userIds: mentions, cardId: c.id, commentId: id, send, where: `on “${c.title}” (${p.name})`, href: link(c, `&comment=${id}`) });
  return { id };
}

// ------------------------------------------------------- personal queue --
/** For Home: my cards due soon or overdue, reviews I am asked for, mentions I have not opened. */
export function myCardItems(db, actor) {
  const today = todayIn(); const soon = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 864e5).toISOString().slice(0, 10);
  const visible = (pid) => canSeeProject(db, actor, pid);
  const items = [];
  // my open cards that are due within a week or overdue, blocked, or sent back to me from review
  const sentBack = db.prepare(`SELECT 1 FROM card_activity a WHERE a.card_id = ? AND a.action = 'moved' AND a.detail LIKE 'Internal review →%'
      AND a.created_at >= COALESCE((SELECT MAX(created_at) FROM card_activity WHERE card_id = a.card_id AND action = 'moved' AND detail LIKE '%→ Internal review'), '')`);
  for (const c of db.prepare(`SELECT d.*, p.name project FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE d.tenant_id = ? AND d.owner_id = ?
      AND d.status IN ('todo','in_progress') ORDER BY COALESCE(d.due_date, '9999') LIMIT 40`).all(actor.tenantId, actor.id)) {
    const back = !!sentBack.get(c.id);
    if (!(back || c.blocked_reason || (c.due_date && c.due_date <= soon)) || !visible(c.project_id)) continue;
    items.push({ type: 'card', kind: back ? 'Changes requested' : c.blocked_reason ? 'Blocked' : 'Your task', title: c.title, detail: c.blocked_reason ? `${c.project} · blocked: ${c.blocked_reason}` : c.project,
      due: c.due_date, link: link(c), action: back ? 'See the feedback' : 'Open task', scope: 'mine' });
  }
  for (const c of db.prepare(`SELECT d.*, p.name project FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE d.tenant_id = ? AND d.status = 'submitted' AND d.qa_reviewer_id = ? AND COALESCE(d.owner_id, '') != ?`).all(actor.tenantId, actor.id, actor.id)) {
    if (!visible(c.project_id)) continue;
    items.push({ type: 'card_review', kind: 'Review requested', title: `Review “${c.title}”`, detail: `${c.project} · from ${userName(db, c.submitted_by || c.owner_id) || 'the team'}`, due: c.due_date, link: link(c), action: 'Review', scope: 'mine' });
  }
  for (const m of db.prepare(`SELECT m.*, u.name by_name, p.name project, d.title card_title, d.project_id card_project FROM mentions m JOIN users u ON u.id = m.by_id LEFT JOIN projects p ON p.id = m.project_id LEFT JOIN deliverables d ON d.id = m.card_id
      WHERE m.user_id = ? AND m.seen_at IS NULL ORDER BY m.created_at DESC LIMIT 10`).all(actor.id)) {
    if (m.project_id && !visible(m.project_id)) continue;
    const where = m.card_id ? `on “${m.card_title}”` : 'in the project discussion';
    const l = m.card_id ? `#/project/${m.card_project}/board?card=${m.card_id}` : `#/project/${m.project_id}/discussion?m=${m.message_id}`;
    items.push({ type: 'mention', kind: 'Mentioned you', title: `${m.by_name} mentioned you ${where}`, detail: m.project, link: l, action: 'Open', scope: 'mine' });
  }
  return items;
}

/** Daily: the owner hears once when a card is due tomorrow and once when it becomes overdue. */
export function remindCardsDue(db, tenantId) {
  const today = todayIn(); const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  for (const c of db.prepare("SELECT d.*, p.name project FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE d.tenant_id = ? AND d.owner_id IS NOT NULL AND d.status IN ('todo','in_progress') AND d.due_date IS NOT NULL AND d.due_date <= ? AND p.status = 'active'").all(tenantId, tomorrow)) {
    const overdue = c.due_date < today;
    notify(db, { tenantId, to: c.owner_id, event: overdue ? 'card.overdue' : 'card.due', key: `${overdue ? 'overdue' : 'due'}:${c.id}:${c.due_date}`, link: link(c),
      subject: overdue ? `Overdue: ${c.title}` : `Due tomorrow: ${c.title}`, text: `“${c.title}” on ${c.project} ${overdue ? `was due ${c.due_date}` : 'is due tomorrow'}.` });
  }
}

/** Search: cards in projects the person can open. */
export function searchCards(db, actor, q) {
  const like = `%${q.replace(/[%_]/g, '')}%`;
  return db.prepare(`SELECT d.id, d.title, d.project_id, d.status, p.name project FROM deliverables d JOIN projects p ON p.id = d.project_id
      WHERE d.tenant_id = ? AND d.status != 'cancelled' AND (d.title LIKE ? OR d.description LIKE ?) ORDER BY d.updated_at DESC LIMIT 40`).all(actor.tenantId, like, like)
    .filter((c) => canSeeProject(db, actor, c.project_id)).slice(0, 10).map((c) => ({ id: c.id, title: c.title, project: c.project, status: LABEL[statusOf(c.status)], link: link(c) }));
}
