// Workplace content and requests: HR letters, deliverable checklists (and the sign-off before a
// deliverable is submitted), policies with acknowledgements, onboarding, the brand kit and CV updates
// that feed the company profile. Content is loaded from GB's private files; nobody's pay is stored.
import { tx, uid, now, audit, bad, forbid, notFound } from '../db.js';
import { isOps, has, currentEmployment } from './authz.js';
import { PUBLIC_FIELDS, updateProfile } from './profiles.js';
import { storeFile, fileResponse } from './files.js';

const J = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const editor = (a) => isOps(a) || has(a, 'partner');
const str = (v, n = 2000) => String(v ?? '').trim().slice(0, n);

// ------------------------------------------------------------------ letters --
export const LETTER_KINDS = ['experience_letter', 'internship_letter', 'employment_certificate', 'other'];
export function letterTemplates(db, actor) {
  return db.prepare('SELECT key, title, title_ar, language, fields_json, signatory, has_compensation FROM letter_templates WHERE tenant_id = ? AND active = 1 ORDER BY title').all(actor.tenantId)
    .map((t) => ({ ...t, fields: J(t.fields_json, []), fields_json: undefined, has_compensation: !!t.has_compensation }));
}
export function requestLetter(db, actor, { kind, addressee, purpose, language = 'en', needed_by } = {}) {
  if (!LETTER_KINDS.includes(kind)) throw bad('Choose the letter you need');
  const p = str(purpose, 500); if (kind === 'other' && !p) throw bad('Describe the letter you need');
  if (needed_by && !/^\d{4}-\d{2}-\d{2}$/.test(needed_by)) throw bad('Date is yyyy-mm-dd');
  const id = uid('let_');
  db.prepare('INSERT INTO letter_requests (id, tenant_id, user_id, template_key, kind, addressee, purpose, language, needed_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, actor.tenantId, actor.id, kind === 'other' ? null : kind, kind, str(addressee, 200) || 'To whom it may concern', p || null, language === 'ar' ? 'ar' : 'en', needed_by || null, now());
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'letter.request', entity: 'letter_request', entityId: id, after: { kind } });
  return { id };
}
export function listLetters(db, actor) {
  const sql = `SELECT r.*, u.name employee FROM letter_requests r JOIN users u ON u.id = r.user_id WHERE r.tenant_id = ?`;
  const mine = db.prepare(`${sql} AND r.user_id = ? ORDER BY r.created_at DESC`).all(actor.tenantId, actor.id);
  const queue = editor(actor) ? db.prepare(`${sql} ORDER BY r.status = 'requested' DESC, r.created_at DESC LIMIT 200`).all(actor.tenantId) : [];
  return { mine, queue, canIssue: editor(actor), templates: letterTemplates(db, actor) };
}
/** Template plus the facts the portal already knows, for People Ops to check before printing. */
export function letterDraft(db, actor, id) {
  if (!editor(actor)) throw forbid();
  const r = db.prepare('SELECT * FROM letter_requests WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!r) throw notFound();
  const t = r.template_key ? db.prepare('SELECT * FROM letter_templates WHERE tenant_id = ? AND key = ?').get(actor.tenantId, r.template_key) : null;
  const u = db.prepare('SELECT name FROM users WHERE id = ?').get(r.user_id);
  const first = db.prepare('SELECT title, hire_date, effective_from FROM employments WHERE user_id = ? ORDER BY effective_from LIMIT 1').get(r.user_id);
  const cur = currentEmployment(db, r.user_id);
  const fmt = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');
  const known = { today: fmt(new Date().toISOString().slice(0, 10)), employee_name: u.name, addressee: r.addressee, title: cur?.title || '', join_title: first?.title || cur?.title || '',
    join_date: fmt(cur?.hire_date || first?.hire_date), promoted_title: cur?.title !== first?.title ? cur?.title : '', end_date: '', ...J(r.issued_fields_json, {}) };
  return { request: r, template: t ? { ...t, fields: J(t.fields_json, []) } : null, known };
}
/** Mark issued (or rejected). Only non-pay fields are kept, for the record. */
export function decideLetter(db, actor, id, { decision, note, fields = {} } = {}) {
  if (!editor(actor)) throw forbid();
  const r = db.prepare('SELECT * FROM letter_requests WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!r) throw notFound();
  if (r.status !== 'requested') throw bad('Already decided');
  if (!['issue', 'reject'].includes(decision)) throw bad('Issue or reject');
  if (decision === 'reject' && !str(note)) throw bad('Say why');
  const keep = Object.fromEntries(Object.entries(fields).filter(([k]) => !/salary|pay|allowance|compensation|amount/i.test(k)).map(([k, v]) => [k, str(v, 300)]));
  db.prepare('UPDATE letter_requests SET status = ?, decided_by = ?, decided_at = ?, note = ?, issued_fields_json = ? WHERE id = ?')
    .run(decision === 'issue' ? 'issued' : 'rejected', actor.id, now(), str(note, 500) || null, decision === 'issue' ? JSON.stringify(keep) : null, id);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: `letter.${decision}`, entity: 'letter_request', entityId: id });
  return { ok: true };
}
export function cancelLetter(db, actor, id) {
  const r = db.prepare('SELECT * FROM letter_requests WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!r) throw notFound();
  if (r.user_id !== actor.id) throw forbid(); if (r.status !== 'requested') throw bad('Already decided');
  db.prepare("UPDATE letter_requests SET status = 'cancelled' WHERE id = ?").run(id);
  return { ok: true };
}

// --------------------------------------------------------------- checklists --
export function checklistsView(db, actor) {
  return db.prepare('SELECT key, kind, deliverable_type, title, title_ar, items_json, source_name, source_url FROM checklists WHERE tenant_id = ? ORDER BY kind, position').all(actor.tenantId)
    .map((c) => ({ ...c, items: J(c.items_json, []), items_json: undefined }));
}
/**
 * Submit a deliverable for review: the person confirms each item of every general checklist and of the
 * checklist for this deliverable's type. A team member or the lead may submit.
 */
export function submitDeliverable(db, actor, deliverableId, { deliverableType, checked = {}, note, driveUrl } = {}) {
  const d = db.prepare('SELECT d.*, p.lead_user_id, p.tenant_id ptenant FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE d.id = ?').get(deliverableId);
  if (!d || d.ptenant !== actor.tenantId) throw notFound();
  const onTeam = d.lead_user_id === actor.id || db.prepare("SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ? AND status IN ('confirmed','tentative','historical','provisional')").get(d.project_id, actor.id);
  if (!onTeam && !isOps(actor)) throw forbid();
  const lists = checklistsView(db, actor);
  const required = lists.filter((c) => c.kind === 'general' || (deliverableType && c.deliverable_type === deliverableType));
  if (deliverableType && !lists.some((c) => c.deliverable_type === deliverableType)) throw bad('Unknown deliverable type');
  const missing = required.flatMap((c) => c.items.map((_, i) => `${c.key}:${i}`)).filter((k) => !checked[k]);
  if (missing.length) throw bad(`Tick every item before submitting — ${missing.length} left`);
  const url = str(driveUrl, 1000);
  if (url && !/^https:\/\/(drive|docs)\.google\.com\//.test(url)) throw bad('Use the Google Drive link of the deliverable');
  tx(db, () => {
    db.prepare('INSERT INTO deliverable_checks (id, tenant_id, deliverable_id, user_id, checklist_keys, items_checked, note, drive_url, confirmed_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(uid('chk_'), actor.tenantId, deliverableId, actor.id, required.map((c) => c.key).join(','), required.reduce((s, c) => s + c.items.length, 0), str(note, 500) || null, url || null, now());
    db.prepare("UPDATE deliverables SET status = 'submitted', deliverable_type = ?, submitted_by = ?, submitted_at = ?, drive_url = COALESCE(?, drive_url) WHERE id = ?").run(deliverableType || null, actor.id, now(), url || null, deliverableId);
    audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'deliverable.submit', entity: 'deliverable', entityId: deliverableId, after: { checklists: required.map((c) => c.key) } });
  });
  return { ok: true };
}

// ----------------------------------------------------------------- policies --
export function policiesView(db, actor) {
  return db.prepare(`SELECT p.*, a.acked_at, a.version acked_version FROM policies p LEFT JOIN policy_acks a ON a.policy_id = p.id AND a.user_id = ?
      WHERE p.tenant_id = ? ORDER BY p.category, p.title`).all(actor.id, actor.tenantId).map((p) => ({ ...p, rules: J(p.rules_json, []), rules_json: undefined,
    acked: !!p.acked_at && (p.acked_version || '') === (p.version || ''), requires_ack: !!p.requires_ack,
    ack_count: editor(actor) ? db.prepare('SELECT COUNT(*) n FROM policy_acks WHERE policy_id = ? AND COALESCE(version, \'\') = ?').get(p.id, p.version || '').n : undefined }));
}
export function ackPolicy(db, actor, key) {
  const p = db.prepare('SELECT * FROM policies WHERE tenant_id = ? AND key = ?').get(actor.tenantId, key); if (!p) throw notFound();
  db.prepare('INSERT INTO policy_acks (policy_id, user_id, version, acked_at) VALUES (?,?,?,?) ON CONFLICT(policy_id, user_id) DO UPDATE SET version = excluded.version, acked_at = excluded.acked_at').run(p.id, actor.id, p.version, now());
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'policy.ack', entity: 'policy', entityId: p.id, after: { version: p.version } });
  return { ok: true };
}
export function policyAckReport(db, actor, key) {
  if (!editor(actor)) throw forbid();
  const p = db.prepare('SELECT * FROM policies WHERE tenant_id = ? AND key = ?').get(actor.tenantId, key); if (!p) throw notFound();
  return db.prepare(`SELECT u.name, a.acked_at, a.version FROM users u LEFT JOIN policy_acks a ON a.user_id = u.id AND a.policy_id = ? WHERE u.tenant_id = ? AND u.active = 1 ORDER BY a.acked_at IS NULL DESC, u.name`)
    .all(p.id, actor.tenantId).map((r) => ({ name: r.name, acked_at: (r.version || '') === (p.version || '') ? r.acked_at : null }));
}

// --------------------------------------------------------------- onboarding --
export function onboardingView(db, actor, userId = actor.id) {
  if (userId !== actor.id && !editor(actor) && currentEmployment(db, userId)?.manager_id !== actor.id) throw forbid();
  const items = db.prepare(`SELECT i.*, p.done_at, p.done_by FROM onboarding_items i LEFT JOIN onboarding_progress p ON p.item_id = i.id AND p.user_id = ?
      WHERE i.tenant_id = ? ORDER BY i.position`).all(userId, actor.tenantId)
    // HR's own documents (offer, contract) can be filled-in examples with someone's pay: People Ops and partners only
    .map((i) => (editor(actor) || i.owner === 'new_joiner' ? i : { ...i, source_url: null }));
  const people = editor(actor) ? db.prepare(`SELECT u.id, u.name, e.hire_date, (SELECT COUNT(*) FROM onboarding_progress p WHERE p.user_id = u.id) done
      FROM users u LEFT JOIN employments e ON e.user_id = u.id AND e.effective_to IS NULL WHERE u.tenant_id = ? AND u.active = 1 ORDER BY e.hire_date DESC, u.name`).all(actor.tenantId) : null;
  return { user_id: userId, items, people, total: items.length, canManage: editor(actor) };
}
export function setOnboardingDone(db, actor, userId, itemId, done) {
  const it = db.prepare('SELECT * FROM onboarding_items WHERE id = ? AND tenant_id = ?').get(itemId, actor.tenantId); if (!it) throw notFound();
  const self = userId === actor.id;
  if (!editor(actor) && !(self && it.owner === 'new_joiner')) throw forbid();
  if (done) db.prepare('INSERT INTO onboarding_progress (user_id, item_id, tenant_id, done_by, done_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING').run(userId, itemId, actor.tenantId, actor.id, now());
  else db.prepare('DELETE FROM onboarding_progress WHERE user_id = ? AND item_id = ?').run(userId, itemId);
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: done ? 'onboarding.done' : 'onboarding.undone', entity: 'user', entityId: userId, after: { item: it.key } });
  return { ok: true };
}

// --------------------------------------------------------------------- brand --
export function brandFiles(db, actor) {
  return db.prepare('SELECT b.id, b.label, b.variant, b.orientation, f.filename, f.mime, f.size FROM brand_files b JOIN files f ON f.id = b.file_id WHERE b.tenant_id = ? ORDER BY b.position').all(actor.tenantId);
}
export function brandFile(db, actor, id, download) {
  const b = db.prepare('SELECT file_id FROM brand_files WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!b) throw notFound();
  return fileResponse(db, actor.tenantId, b.file_id, { download });
}

// ---------------------------------------------------------------- CV updates --
/** Employees propose changes to their CV facts; People Ops or a partner applies them to the profile. */
export function proposeCvUpdate(db, actor, fields = {}) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([k]) => PUBLIC_FIELDS.includes(k)).map(([k, v]) => [k, str(v, 4000)]));
  if (!Object.keys(clean).length) throw bad('Nothing to update');
  const open = db.prepare("SELECT id FROM cv_updates WHERE user_id = ? AND status = 'pending'").get(actor.id);
  if (open) db.prepare('UPDATE cv_updates SET fields_json = ?, created_at = ? WHERE id = ?').run(JSON.stringify(clean), now(), open.id);
  else db.prepare('INSERT INTO cv_updates (id, tenant_id, user_id, fields_json, created_at) VALUES (?,?,?,?,?)').run(uid('cvu_'), actor.tenantId, actor.id, JSON.stringify(clean), now());
  return { ok: true };
}
export function cvUpdates(db, actor) {
  const rows = db.prepare(`SELECT c.*, u.name FROM cv_updates c JOIN users u ON u.id = c.user_id WHERE c.tenant_id = ? AND (c.user_id = ? OR ?) ORDER BY c.status = 'pending' DESC, c.created_at DESC LIMIT 100`)
    .all(actor.tenantId, actor.id, editor(actor) ? 1 : 0);
  return rows.map((r) => ({ ...r, fields: J(r.fields_json, {}), fields_json: undefined }));
}
export function decideCvUpdate(db, actor, id, { decision, note } = {}) {
  if (!editor(actor)) throw forbid();
  const r = db.prepare('SELECT * FROM cv_updates WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId); if (!r) throw notFound();
  if (r.status !== 'pending') throw bad('Already decided');
  if (decision === 'apply') updateProfile(db, actor, r.user_id, J(r.fields_json, {}), { source: 'CV update from the employee' });
  else if (decision !== 'reject') throw bad('Apply or reject');
  db.prepare('UPDATE cv_updates SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?').run(decision === 'apply' ? 'applied' : 'rejected', actor.id, now(), str(note, 500) || null, id);
  return { ok: true };
}

// --------------------------------------------------------------------- loader --
/** Load letters, checklists, policies, onboarding and brand files from GB's private files. Re-runnable. */
export function applyWorkplace(db, actor, { letters = [], checklists = { general: [], specific: [] }, policies = [], onboarding = [], brand = [] }) {
  const T = actor.tenantId; const rep = { letters: 0, checklists: 0, policies: 0, onboarding: 0, brand: 0 };
  tx(db, () => {
    for (const l of letters) {
      db.prepare(`INSERT INTO letter_templates (id, tenant_id, key, title, title_ar, language, fields_json, body, signatory, has_compensation, source_url) VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(tenant_id, key) DO UPDATE SET title = excluded.title, title_ar = excluded.title_ar, language = excluded.language, fields_json = excluded.fields_json, body = excluded.body,
          signatory = excluded.signatory, has_compensation = excluded.has_compensation, source_url = excluded.source_url`)
        .run(uid('lt_'), T, l.key, l.title, l.title_ar || null, l.language || 'en', JSON.stringify(l.fields || []), l.body, l.signatory || null, l.has_compensation ? 1 : 0, l.source?.url || null); rep.letters++;
    }
    const lists = [...(checklists.general || []).map((c) => ({ ...c, kind: 'general' })), ...(checklists.specific || []).map((c) => ({ ...c, kind: 'specific' }))];
    lists.forEach((c, i) => {
      db.prepare(`INSERT INTO checklists (id, tenant_id, key, kind, deliverable_type, title, title_ar, items_json, source_name, source_url, position) VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(tenant_id, key) DO UPDATE SET kind = excluded.kind, deliverable_type = excluded.deliverable_type, title = excluded.title, title_ar = excluded.title_ar, items_json = excluded.items_json,
          source_name = excluded.source_name, source_url = excluded.source_url, position = excluded.position`)
        .run(uid('cl_'), T, c.key, c.kind, c.kind === 'specific' ? c.deliverable_type : null, c.title, c.title_ar || null, JSON.stringify(c.items || []), c.source?.name || null, c.source?.url || null, i); rep.checklists++;
    });
    for (const p of policies) {
      db.prepare(`INSERT INTO policies (id, tenant_id, key, category, title, title_ar, version, effective, summary, rules_json, applies_to, source_url, requires_ack) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(tenant_id, key) DO UPDATE SET category = excluded.category, title = excluded.title, title_ar = excluded.title_ar, version = excluded.version, effective = excluded.effective,
          summary = excluded.summary, rules_json = excluded.rules_json, applies_to = excluded.applies_to, source_url = excluded.source_url, requires_ack = excluded.requires_ack`)
        .run(uid('pol_'), T, p.key, p.category || 'AI', p.title, p.title_ar || null, p.version || null, p.effective || null, p.summary || null, JSON.stringify(p.rules || []), p.applies_to || null, p.source?.url || null, p.requires_ack === false ? 0 : 1); rep.policies++;
    }
    onboarding.forEach((o, i) => {
      db.prepare(`INSERT INTO onboarding_items (id, tenant_id, key, title, title_ar, purpose, stage, owner, action, source_url, position) VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(tenant_id, key) DO UPDATE SET title = excluded.title, title_ar = excluded.title_ar, purpose = excluded.purpose, stage = excluded.stage, owner = excluded.owner,
          action = excluded.action, source_url = excluded.source_url, position = excluded.position`)
        .run(uid('onb_'), T, o.key, o.title, o.title_ar || null, o.purpose || null, o.stage || 'day1', o.owner || 'new_joiner', o.action || 'read', o.source?.url || null, i); rep.onboarding++;
    });
    brand.forEach((b, i) => {
      const ex = db.prepare('SELECT b.id, f.sha256 FROM brand_files b JOIN files f ON f.id = b.file_id WHERE b.tenant_id = ? AND b.label = ?').get(T, b.label);
      const fileId = storeFile(db, actor, { purpose: 'brand', filename: b.filename, buffer: b.buffer, maxBytes: 8 * 1024 * 1024 });
      if (ex) db.prepare('UPDATE brand_files SET file_id = ?, variant = ?, orientation = ?, position = ? WHERE id = ?').run(fileId, b.variant || null, b.orientation || null, i, ex.id);
      else db.prepare('INSERT INTO brand_files (id, tenant_id, file_id, label, variant, orientation, position) VALUES (?,?,?,?,?,?,?)').run(uid('br_'), T, fileId, b.label, b.variant || null, b.orientation || null, i);
      db.prepare("DELETE FROM files WHERE purpose = 'brand' AND tenant_id = ? AND id NOT IN (SELECT file_id FROM brand_files)").run(T);
      rep.brand++;
    });
    audit(db, { tenantId: T, actorId: actor.id, action: 'workplace.import', entity: 'workplace', entityId: null, after: rep });
  });
  return rep;
}
