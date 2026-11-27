// Internal messages: one-to-one and group conversations between colleagues. Only members read a
// conversation; nobody else — not partners, not admins — can open it.
// A project's discussion is a group conversation tied to the project (direct_key "project:<id>"). Its
// members follow the project: the lead and current team (partners and People Ops join when they open it);
// people who leave the project lose access even if they are still listed as members.
import { tx, uid, now, audit, bad, forbid, notFound } from '../db.js';
import { projectAccess, participants, recordMentions, canSeeProject, markMentionsSeen } from './board.js';
import { notify } from './mailer.js';

const member = (db, cid, uid_) => db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(cid, uid_);
const isProjectConv = (c) => !!c.project_id && String(c.direct_key || '').startsWith('project:');
function load(db, actor, id) {
  const c = db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId);
  if (!c) throw notFound();
  if (isProjectConv(c)) {
    projectAccess(db, actor, c.project_id); // not on the project any more → not found
    if (!member(db, id, actor.id)) db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?,?,?)').run(id, actor.id, now());
    return c;
  }
  if (!member(db, id, actor.id)) throw forbid();
  return c;
}

/** The project's discussion: created on first use; membership follows the project team. */
export function projectConversation(db, actor, projectId) {
  const { p } = projectAccess(db, actor, projectId);
  const key = `project:${p.id}`;
  let c = db.prepare('SELECT * FROM conversations WHERE tenant_id = ? AND direct_key = ?').get(actor.tenantId, key);
  if (!c) {
    const id = uid('cnv_'); const t = now();
    db.prepare("INSERT INTO conversations (id, tenant_id, title, kind, direct_key, project_id, created_by, created_at, last_at) VALUES (?,?,?, 'group', ?,?,?,?,?)").run(id, actor.tenantId, `${p.name} — discussion`, key, p.id, actor.id, t, t);
    c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  }
  const team = new Set(participants(db, p.id));
  for (const u of new Set([...team, actor.id])) db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?,?,?)').run(c.id, u, now());
  // people who left the project drop out of the list (partners / People Ops stay once they joined)
  for (const m of db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(c.id))
    if (!team.has(m.user_id) && !db.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role IN ('partner','people_ops','admin')").get(m.user_id)) db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(c.id, m.user_id);
  return { id: c.id, project_id: p.id, title: c.title };
}
const colleagues = (db, actor, ids) => {
  for (const id of ids) if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ? AND active = 1').get(id, actor.tenantId)) throw bad('Unknown colleague');
};

export function listConversations(db, actor) {
  // project discussions the person can no longer open are not listed
  const hide = new Set(db.prepare("SELECT c.id, c.project_id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = ? WHERE c.direct_key LIKE 'project:%'").all(actor.id)
    .filter((c) => !canSeeProject(db, actor, c.project_id)).map((c) => c.id));
  return db.prepare(`SELECT c.*, m.last_read_at,
      (SELECT COUNT(*) FROM messages x WHERE x.conversation_id = c.id AND x.sender_id != ? AND (m.last_read_at IS NULL OR x.created_at > m.last_read_at)) unread,
      (SELECT body FROM messages x WHERE x.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) last_body,
      (SELECT sender_id FROM messages x WHERE x.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) last_sender
    FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = ? WHERE c.tenant_id = ? ORDER BY c.last_at DESC`).all(actor.id, actor.id, actor.tenantId)
    .map((c) => {
      const people = db.prepare('SELECT u.id, u.name FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? ORDER BY u.name').all(c.id);
      const others = people.filter((p) => p.id !== actor.id);
      return { id: c.id, kind: c.kind, title: c.kind === 'direct' ? others[0]?.name || 'Just you' : c.title, people, other_id: c.kind === 'direct' ? others[0]?.id : null,
        unread: c.unread, last_at: c.last_at, last_body: c.last_body ? c.last_body.slice(0, 120) : null, last_mine: c.last_sender === actor.id, project_id: isProjectConv(c) ? c.project_id : null };
    }).filter((c) => !hide.has(c.id));
}

export const unreadCount = (db, actor) => db.prepare(`SELECT COUNT(*) n FROM messages x JOIN conversation_members m ON m.conversation_id = x.conversation_id AND m.user_id = ?
    WHERE x.sender_id != ? AND (m.last_read_at IS NULL OR x.created_at > m.last_read_at)`).get(actor.id, actor.id).n;

/** Open (or reuse) the direct conversation with one colleague. */
export function directWith(db, actor, otherId) {
  if (!otherId || otherId === actor.id) throw bad('Choose a colleague');
  colleagues(db, actor, [otherId]);
  const key = [actor.id, otherId].sort().join('|');
  const ex = db.prepare('SELECT id FROM conversations WHERE tenant_id = ? AND direct_key = ?').get(actor.tenantId, key);
  if (ex) return { id: ex.id };
  const id = uid('cnv_'); const t = now();
  tx(db, () => {
    db.prepare("INSERT INTO conversations (id, tenant_id, kind, direct_key, created_by, created_at, last_at) VALUES (?,?, 'direct', ?,?,?,?)").run(id, actor.tenantId, key, actor.id, t, t);
    for (const u of [actor.id, otherId]) db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?,?,?)').run(id, u, t);
  });
  return { id };
}

export function createGroup(db, actor, { title, memberIds = [], projectId = null } = {}) {
  const name = String(title || '').trim().slice(0, 80); if (!name) throw bad('Name the group');
  let ids = [...new Set([actor.id, ...memberIds])];
  if (projectId) {
    const p = db.prepare('SELECT lead_user_id FROM projects WHERE id = ? AND tenant_id = ?').get(projectId, actor.tenantId); if (!p) throw bad('Unknown project');
    ids = [...new Set([...ids, p.lead_user_id, ...db.prepare("SELECT user_id FROM project_assignments WHERE project_id = ? AND status IN ('confirmed','tentative','historical')").all(projectId).map((r) => r.user_id)].filter(Boolean))];
  }
  if (ids.length < 2) throw bad('Add at least one colleague');
  colleagues(db, actor, ids);
  const id = uid('cnv_'); const t = now();
  tx(db, () => {
    db.prepare("INSERT INTO conversations (id, tenant_id, title, kind, project_id, created_by, created_at, last_at) VALUES (?,?,?, 'group', ?,?,?,?)").run(id, actor.tenantId, name, projectId, actor.id, t, t);
    for (const u of ids) db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?,?,?)').run(id, u, t);
  });
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'messages.group', entity: 'conversation', entityId: id, after: { members: ids.length } });
  return { id };
}

export function addMembers(db, actor, id, memberIds = []) {
  const c = load(db, actor, id); if (c.kind !== 'group') throw bad('Only groups take new members');
  colleagues(db, actor, memberIds);
  for (const u of memberIds) db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?,?,?)').run(id, u, now());
  return { ok: true };
}
export function leaveConversation(db, actor, id) {
  const c = load(db, actor, id); if (c.kind !== 'group') throw bad('You can leave group conversations only');
  db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(id, actor.id);
  return { ok: true };
}

const shape = (db, actor, m) => ({ ...m, mine: m.sender_id === actor.id, pinned: m.pinned_at ? { by: db.prepare('SELECT name FROM users WHERE id = ?').get(m.pinned_by)?.name, at: m.pinned_at } : null,
  replies: db.prepare('SELECT COUNT(*) n FROM messages WHERE parent_id = ?').get(m.id).n,
  tasks: db.prepare("SELECT id, title, project_id FROM deliverables WHERE source_message_id = ? AND status != 'cancelled'").all(m.id), pinned_by: undefined, pinned_at: undefined });
const COLS = 'x.id, x.sender_id, u.name sender, x.body, x.created_at, x.parent_id, x.pinned_by, x.pinned_at';

/** Messages, oldest first; opening them marks the conversation read. `after` returns only newer ones (polling).
 *  In a project discussion, replies live in threads: `thread` returns one message and its replies. */
export function readMessages(db, actor, id, { after = null, limit = 200, thread = null } = {}) {
  const c = load(db, actor, id);
  const proj = isProjectConv(c);
  let rows;
  if (thread) {
    const parent = db.prepare(`SELECT ${COLS} FROM messages x JOIN users u ON u.id = x.sender_id WHERE x.id = ? AND x.conversation_id = ?`).get(thread, id);
    if (!parent) throw notFound();
    rows = [parent, ...db.prepare(`SELECT ${COLS} FROM messages x JOIN users u ON u.id = x.sender_id WHERE x.parent_id = ? ORDER BY x.created_at`).all(thread)];
  } else {
    rows = db.prepare(`SELECT ${COLS} FROM messages x JOIN users u ON u.id = x.sender_id
      WHERE x.conversation_id = ? ${proj ? 'AND x.parent_id IS NULL' : ''} ${after ? 'AND x.created_at > ?' : ''} ORDER BY x.created_at DESC LIMIT ?`).all(...[id, after, limit].filter((v) => v !== null)).reverse();
  }
  db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?').run(now(), id, actor.id);
  markMentionsSeen(db, actor, { messageIds: rows.map((r) => r.id) });
  const pinned = proj && !thread && !after ? db.prepare(`SELECT ${COLS} FROM messages x JOIN users u ON u.id = x.sender_id WHERE x.conversation_id = ? AND x.pinned_at IS NOT NULL ORDER BY x.pinned_at DESC`).all(id).map((m) => shape(db, actor, m)) : undefined;
  return { id: c.id, kind: c.kind, project_id: proj ? c.project_id : null, messages: rows.map((m) => shape(db, actor, m)), pinned,
    can: proj ? { pin: projectAccess(db, actor, c.project_id).manage } : undefined };
}

/** Decisions worth finding later: the project lead, partners and People Ops pin a message. */
export function pinMessage(db, actor, id, messageId, pin = true) {
  const c = load(db, actor, id);
  if (!isProjectConv(c)) throw bad('Pin messages in a project discussion');
  if (!projectAccess(db, actor, c.project_id).manage) throw forbid('Only the project lead, a partner or People Ops can pin');
  const r = db.prepare('UPDATE messages SET pinned_by = ?, pinned_at = ? WHERE id = ? AND conversation_id = ?').run(pin ? actor.id : null, pin ? now() : null, messageId, id);
  if (!r.changes) throw notFound();
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: pin ? 'message.pin' : 'message.unpin', entity: 'message', entityId: messageId });
  return { ok: true };
}

/** Search messages the person can read (their conversations; project discussions only while on the project). */
export function searchMessages(db, actor, q) {
  const like = `%${q.replace(/[%_]/g, '')}%`;
  return db.prepare(`SELECT x.id, x.body, x.created_at, x.conversation_id, x.parent_id, c.title, c.kind, c.direct_key, c.project_id, u.name sender FROM messages x
      JOIN conversations c ON c.id = x.conversation_id JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = ? JOIN users u ON u.id = x.sender_id
      WHERE c.tenant_id = ? AND x.body LIKE ? ORDER BY x.created_at DESC LIMIT 40`).all(actor.id, actor.tenantId, like)
    .filter((m) => !isProjectConv(m) || canSeeProject(db, actor, m.project_id)).slice(0, 10)
    .map((m) => ({ id: m.id, snippet: m.body.replace(/\[\[card:[^|\]]+\|([^\]]+)\]\]/g, '$1').slice(0, 120), sender: m.sender, where: isProjectConv(m) ? m.title : m.kind === 'direct' ? 'Direct message' : m.title,
      link: isProjectConv(m) ? `#/project/${m.project_id}/discussion?m=${m.parent_id || m.id}` : `#/messages?c=${m.conversation_id}` }));
}

export function sendMessage(db, actor, id, text, { parentId = null, mentions = [] } = {}) {
  const c = load(db, actor, id);
  const body = String(text || '').replace(/\s+$/, '').slice(0, 4000);
  if (!body.trim()) throw bad('Write a message');
  if (parentId) { const par = db.prepare('SELECT parent_id FROM messages WHERE id = ? AND conversation_id = ?').get(parentId, id); if (!par) throw bad('That message is not in this conversation'); if (par.parent_id) parentId = par.parent_id; }
  const mid = uid('msg_'); const t = now();
  tx(db, () => {
    db.prepare('INSERT INTO messages (id, conversation_id, sender_id, body, created_at, parent_id) VALUES (?,?,?,?,?,?)').run(mid, id, actor.id, body, t, parentId);
    db.prepare('UPDATE conversations SET last_at = ? WHERE id = ?').run(t, id);
    db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?').run(t, id, actor.id);
  });
  if (isProjectConv(c) && mentions.length) {
    const p = db.prepare('SELECT name FROM projects WHERE id = ?').get(c.project_id);
    recordMentions(db, actor, { projectId: c.project_id, userIds: mentions, conversationId: id, messageId: mid, where: `in the ${p.name} discussion`, href: `#/project/${c.project_id}/discussion?m=${parentId || mid}`,
      send: (to, o) => notify(db, { tenantId: actor.tenantId, to, ...o }) });
  }
  return { id: mid, created_at: t, project: isProjectConv(c) };
}
