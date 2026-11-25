// Claude accounts (GB's Team-plan seats): which are active, who uses each and what they work on.
// Everyone can see the register (so they know which seat to use); partners and People Ops edit it.
// Seeded once from the confirmed seat attributions already in the portal.
import { tx, uid, now, audit, bad, forbid, notFound } from '../db.js';
import { isOps, has } from './authz.js';

const editor = (a) => isOps(a) || has(a, 'partner');

export function seedFromAttributions(db, actor) {
  if (db.prepare('SELECT COUNT(*) n FROM claude_accounts WHERE tenant_id = ?').get(actor.tenantId).n) return 0;
  const rows = db.prepare("SELECT seat_email, user_id, candidate_name FROM ai_seat_attributions WHERE tenant_id = ? AND tool = 'claude' AND status = 'confirmed'").all(actor.tenantId);
  let n = 0;
  tx(db, () => {
    for (const seat of [...new Set(rows.map((r) => r.seat_email))]) {
      const id = uid('cla_');
      db.prepare('INSERT INTO claude_accounts (id, tenant_id, seat_email, updated_by, updated_at) VALUES (?,?,?,?,?)').run(id, actor.tenantId, seat, actor.id, now()); n++;
      for (const r of rows.filter((x) => x.seat_email === seat)) {
        const u = r.user_id || db.prepare('SELECT id FROM users WHERE tenant_id = ? AND lower(email) = lower(?)').get(actor.tenantId, r.candidate_name)?.id;
        if (u) db.prepare('INSERT OR IGNORE INTO claude_account_users (account_id, user_id) VALUES (?,?)').run(id, u);
      }
    }
  });
  return n;
}

export function claudeView(db, actor) {
  const accounts = db.prepare('SELECT * FROM claude_accounts WHERE tenant_id = ? ORDER BY status, seat_email').all(actor.tenantId).map((a) => ({ ...a,
    users: db.prepare(`SELECT u.id, u.name, cu.working_on, cu.since, p.id project_id, p.name project FROM claude_account_users cu JOIN users u ON u.id = cu.user_id
        LEFT JOIN projects p ON p.id = cu.project_id WHERE cu.account_id = ? ORDER BY u.name`).all(a.id) }));
  const covered = new Set(accounts.filter((a) => a.status === 'active').flatMap((a) => a.users.map((u) => u.id)));
  const without = db.prepare('SELECT id, name FROM users WHERE tenant_id = ? AND active = 1 ORDER BY name').all(actor.tenantId).filter((u) => !covered.has(u.id));
  return { accounts, without, canEdit: editor(actor), active: accounts.filter((a) => a.status === 'active').length };
}

export function saveAccount(db, actor, id, b = {}) {
  if (!editor(actor)) throw forbid();
  const email = String(b.seat_email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) throw bad('Enter the seat’s email address');
  if (b.status && !['active', 'paused', 'closed'].includes(b.status)) throw bad('Status is active, paused or closed');
  const vals = [email, String(b.plan || 'Team').slice(0, 40), b.status || 'active', String(b.monthly_limit || '').slice(0, 80) || null, String(b.notes || '').slice(0, 500) || null, actor.id, now()];
  return tx(db, () => {
    if (id) { const r = db.prepare('UPDATE claude_accounts SET seat_email = ?, plan = ?, status = ?, monthly_limit = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ? AND tenant_id = ?').run(...vals, id, actor.tenantId); if (!r.changes) throw notFound(); }
    else { id = uid('cla_'); db.prepare('INSERT INTO claude_accounts (seat_email, plan, status, monthly_limit, notes, updated_by, updated_at, id, tenant_id) VALUES (?,?,?,?,?,?,?,?,?)').run(...vals, id, actor.tenantId); }
    if (Array.isArray(b.users)) {
      db.prepare('DELETE FROM claude_account_users WHERE account_id = ?').run(id);
      for (const u of b.users) {
        if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ?').get(u.user_id, actor.tenantId)) throw bad('Unknown person');
        if (u.project_id && !db.prepare('SELECT 1 FROM projects WHERE id = ? AND tenant_id = ?').get(u.project_id, actor.tenantId)) throw bad('Unknown project');
        db.prepare('INSERT OR REPLACE INTO claude_account_users (account_id, user_id, project_id, working_on, since) VALUES (?,?,?,?,?)').run(id, u.user_id, u.project_id || null, String(u.working_on || '').slice(0, 200) || null, u.since || null);
      }
    }
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'claude.account', entity: 'claude_account', entityId: id, after: { email, status: vals[2], users: b.users?.length } });
    return { id };
  });
}

/** A person updates what they are using their seat for. */
export function setMyWork(db, actor, accountId, { project_id, working_on }) {
  const r = db.prepare('UPDATE claude_account_users SET project_id = ?, working_on = ? WHERE account_id = ? AND user_id = ?').run(project_id || null, String(working_on || '').slice(0, 200) || null, accountId, actor.id);
  if (!r.changes) throw forbid('You are not on this account');
  return { ok: true };
}
