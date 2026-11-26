// Engagement close-out: what went well, what to improve, what the client said, and reusable assets
// (templates, tools, frameworks, models) with Drive links. Assets form the Toolkit in the Library.
// The lead (or anyone on the team, a partner or People Ops) writes it; everyone can read it.
// Feeds strategy objective 3.1 and the KPI “% completion of knowledge base”.
import { tx, uid, now, audit, bad, forbid, notFound } from '../db.js';
import { isOps, has } from './authz.js';

export const ASSET_KINDS = ['template', 'tool', 'framework', 'model', 'training', 'other'];
const editorFor = (db, actor, projectId) => isOps(actor) || has(actor, 'partner') || (projectId && (
  db.prepare('SELECT 1 FROM projects WHERE id = ? AND lead_user_id = ?').get(projectId, actor.id)
  || db.prepare("SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ? AND status IN ('confirmed','tentative','historical')").get(projectId, actor.id)));

export function closeoutFor(db, actor, engagementId) {
  const e = db.prepare('SELECT e.*, c.name_en client FROM engagements e JOIN clients c ON c.id = e.client_id WHERE e.id = ? AND e.tenant_id = ?').get(engagementId, actor.tenantId); if (!e) throw notFound();
  const c = db.prepare('SELECT co.*, u.name submitted_by_name FROM closeouts co JOIN users u ON u.id = co.submitted_by WHERE co.engagement_id = ?').get(engagementId);
  return { engagement: { id: e.id, title: e.title_en, client: e.client, status: e.status, project_id: e.project_id }, closeout: c || null,
    assets: c ? db.prepare('SELECT * FROM reusable_assets WHERE closeout_id = ? ORDER BY title').all(c.id) : [], canEdit: !!editorFor(db, actor, e.project_id) };
}

export function saveCloseout(db, actor, engagementId, b = {}) {
  const e = db.prepare('SELECT * FROM engagements WHERE id = ? AND tenant_id = ?').get(engagementId, actor.tenantId); if (!e) throw notFound();
  if (!editorFor(db, actor, e.project_id)) throw forbid();
  const t = (v) => String(v ?? '').trim().slice(0, 4000) || null;
  if (!t(b.went_well) && !t(b.to_improve)) throw bad('Write at least what went well or what to improve');
  const assets = Array.isArray(b.assets) ? b.assets : [];
  for (const a of assets) {
    if (!String(a.title || '').trim()) throw bad('Every asset needs a title');
    if (!ASSET_KINDS.includes(a.kind)) throw bad('Choose the asset type');
    if (!/^https:\/\/(drive|docs)\.google\.com\//.test(a.drive_url || '')) throw bad(`“${a.title}”: use its Google Drive link`);
  }
  return tx(db, () => {
    let c = db.prepare('SELECT * FROM closeouts WHERE engagement_id = ?').get(engagementId);
    const vals = [t(b.went_well), t(b.to_improve), t(b.client_feedback), String(b.tags || '').slice(0, 300) || null, now()];
    if (c) db.prepare('UPDATE closeouts SET went_well = ?, to_improve = ?, client_feedback = ?, tags = ?, updated_at = ? WHERE id = ?').run(...vals, c.id);
    else { const id = uid('clo_'); db.prepare('INSERT INTO closeouts (went_well, to_improve, client_feedback, tags, updated_at, id, tenant_id, engagement_id, project_id, submitted_by, submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...vals, id, actor.tenantId, engagementId, e.project_id, actor.id, now()); c = { id }; }
    db.prepare('DELETE FROM reusable_assets WHERE closeout_id = ?').run(c.id);
    for (const a of assets) db.prepare('INSERT INTO reusable_assets (id, tenant_id, closeout_id, title, kind, service_line, drive_url, description, added_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(uid('ast_'), actor.tenantId, c.id, String(a.title).trim().slice(0, 160), a.kind, e.service_line || null, a.drive_url, String(a.description || '').slice(0, 500) || null, actor.id, now());
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'closeout.save', entity: 'engagement', entityId: engagementId, after: { assets: assets.length } });
    return { id: c.id };
  });
}

/** Toolkit: every reusable asset, searchable, with the engagement it came from. */
export function toolkit(db, actor) {
  return db.prepare(`SELECT a.*, e.title_en engagement, e.id engagement_id, c.name_en client, u.name added_by_name FROM reusable_assets a
      JOIN closeouts co ON co.id = a.closeout_id JOIN engagements e ON e.id = co.engagement_id JOIN clients c ON c.id = e.client_id LEFT JOIN users u ON u.id = a.added_by
      WHERE a.tenant_id = ? ORDER BY a.created_at DESC`).all(actor.tenantId);
}

/** KPI: share of completed engagements (from 2025) that have a close-out. */
export function knowledgeKpi(db, tenantId) {
  const done = db.prepare("SELECT COUNT(*) n FROM engagements WHERE tenant_id = ? AND status = 'completed' AND COALESCE(year_to, year_from) >= 2025").get(tenantId).n;
  const with_ = db.prepare("SELECT COUNT(*) n FROM engagements e WHERE e.tenant_id = ? AND e.status = 'completed' AND COALESCE(e.year_to, e.year_from) >= 2025 AND EXISTS (SELECT 1 FROM closeouts c WHERE c.engagement_id = e.id)").get(tenantId).n;
  return { done, with_closeout: with_, pct: done ? Math.round((with_ / done) * 100) : null, assets: db.prepare('SELECT COUNT(*) n FROM reusable_assets WHERE tenant_id = ?').get(tenantId).n };
}

/** Inbox: completed engagements I led (or worked on) without a close-out. */
export function missingCloseouts(db, actor) {
  return db.prepare(`SELECT DISTINCT e.id, e.title_en, c.short, c.name_en FROM engagements e JOIN clients c ON c.id = e.client_id JOIN projects p ON p.id = e.project_id
      WHERE e.tenant_id = ? AND e.status = 'completed' AND COALESCE(e.year_to, e.year_from) >= 2025 AND p.lead_user_id = ?
        AND NOT EXISTS (SELECT 1 FROM closeouts x WHERE x.engagement_id = e.id)`).all(actor.tenantId, actor.id);
}
