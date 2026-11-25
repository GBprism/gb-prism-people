// Internal messages: one-to-one and group conversations between colleagues. Only members read a
// conversation; nobody else — not partners, not admins — can open it.
import { tx, uid, now, audit, bad, forbid, notFound } from '../db.js';

const member = (db, cid, uid_) => db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(cid, uid_);
function load(db, actor, id) {
  const c = db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId);
  if (!c) throw notFound();
  if (!member(db, id, actor.id)) throw forbid();
  return c;
}
const colleagues = (db, actor, ids) => {
  for (const id of ids) if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ? AND active = 1').get(id, actor.tenantId)) throw bad('Unknown colleague');
};

export function listConversations(db, actor) {
  return db.prepare(`SELECT c.*, m.last_read_at,
      (SELECT COUNT(*) FROM messages x WHERE x.conversation_id = c.id AND x.sender_id != ? AND (m.last_read_at IS NULL OR x.created_at > m.last_read_at)) unread,
      (SELECT body FROM messages x WHERE x.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) last_body,
      (SELECT sender_id FROM messages x WHERE x.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) last_sender
    FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = ? WHERE c.tenant_id = ? ORDER BY c.last_at DESC`).all(actor.id, actor.id, actor.tenantId)
    .map((c) => {
      const people = db.prepare('SELECT u.id, u.name FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? ORDER BY u.name').all(c.id);
      const others = people.filter((p) => p.id !== actor.id);
      return { id: c.id, kind: c.kind, title: c.kind === 'direct' ? others[0]?.name || 'Just you' : c.title, people, other_id: c.kind === 'direct' ? others[0]?.id : null,
        unread: c.unread, last_at: c.last_at, last_body: c.last_body ? c.last_body.slice(0, 120) : null, last_mine: c.last_sender === actor.id };
    });
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

/** Messages, oldest first; opening them marks the conversation read. `after` returns only newer ones (polling). */
export function readMessages(db, actor, id, { after = null, limit = 200 } = {}) {
  const c = load(db, actor, id);
  const rows = db.prepare(`SELECT x.id, x.sender_id, u.name sender, x.body, x.created_at FROM messages x JOIN users u ON u.id = x.sender_id
      WHERE x.conversation_id = ? ${after ? 'AND x.created_at > ?' : ''} ORDER BY x.created_at DESC LIMIT ?`).all(...[id, after, limit].filter((v) => v !== null)).reverse();
  db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?').run(now(), id, actor.id);
  return { id: c.id, kind: c.kind, messages: rows.map((m) => ({ ...m, mine: m.sender_id === actor.id })) };
}

export function sendMessage(db, actor, id, text) {
  load(db, actor, id);
  const body = String(text || '').replace(/\s+$/, '').slice(0, 4000);
  if (!body.trim()) throw bad('Write a message');
  const mid = uid('msg_'); const t = now();
  tx(db, () => {
    db.prepare('INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?,?,?,?,?)').run(mid, id, actor.id, body, t);
    db.prepare('UPDATE conversations SET last_at = ? WHERE id = ?').run(t, id);
    db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?').run(t, id, actor.id);
  });
  return { id: mid, created_at: t };
}
