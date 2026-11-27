// "What is running now and who is on it", from GB's own list (config/private/real/active-projects.json).
// The list is authoritative for today:
//   - each listed project is active, linked to its library engagement (marked running), and has
//     exactly the listed people on it from today (others on it get an end date of yesterday);
//   - every other running engagement project is marked completed and its open assignments end yesterday,
//     so timesheets stop drafting hours on it;
//   - library engagements still "running" that are not on the list are reported, not changed.
// Project leads are kept as they are. Dry run by default from the script.
import { uid, now, audit, bad } from '../db.js';
import { todayIn } from '../domain/dates.js';

const yesterday = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
const norm = (s) => String(s || '').toLowerCase().replace(/[–—-]/g, ' ').replace(/\s+/g, ' ').trim();

export function applyActiveProjects(db, actor, file, { asOf = todayIn() } = {}) {
  const T = actor.tenantId;
  if (!Array.isArray(file?.projects) || !file.projects.length) throw bad('The file lists no projects');
  const report = { projects: [], people: [], closed: [], library_still_running: [], warnings: [] };
  const end = yesterday(asOf);
  const users = db.prepare('SELECT id, name, email FROM users WHERE tenant_id = ? AND active = 1').all(T);
  const person = (key) => users.find((u) => u.email.toLowerCase() === String(key).toLowerCase() || norm(u.name) === norm(key)) || null;
  const keep = new Set();

  for (const item of file.projects) {
    const eng = item.engagement ? db.prepare('SELECT * FROM engagements WHERE tenant_id = ? AND key = ?').get(T, item.engagement) : null;
    if (item.engagement && !eng) report.warnings.push(`Library engagement “${item.engagement}” not found — ${item.name} is added without it`);
    // find the project: the engagement's project, then by name, else create it
    let p = eng?.project_id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(eng.project_id) : null;
    p ||= db.prepare('SELECT * FROM projects WHERE tenant_id = ? AND kind = ?').all(T, 'engagement').find((x) => norm(x.name) === norm(item.name)) || null;
    if (!p) {
      const id = uid('prj_');
      db.prepare(`INSERT INTO projects (id, tenant_id, name, client, kind, status, start_date, register_status, source_ref)
          VALUES (?,?,?,?, 'engagement', 'active', ?, 'approved', 'GB active projects list')`).run(id, T, item.name, item.client || null, item.start || asOf);
      p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      report.projects.push(`Added project: ${item.name}`);
    } else {
      const changes = [];
      if (p.status !== 'active') changes.push(`status ${p.status} → active`);
      if (p.register_status === 'archived' || p.register_status === 'candidate') changes.push('approved in the register');
      if (p.end_date && p.end_date < asOf) changes.push(`end date ${p.end_date} cleared`);
      db.prepare(`UPDATE projects SET status = 'active', register_status = 'approved', end_date = CASE WHEN end_date < ? THEN NULL ELSE end_date END WHERE id = ?`).run(asOf, p.id);
      report.projects.push(`${p.name}${changes.length ? `: ${changes.join(', ')}` : ': already active'}`);
    }
    if (eng) {
      if (!eng.project_id) db.prepare('UPDATE engagements SET project_id = ? WHERE id = ?').run(p.id, eng.id);
      if (eng.status !== 'running') { db.prepare("UPDATE engagements SET status = 'running' WHERE id = ?").run(eng.id); report.projects.push(`  library: ${eng.title_en} marked running`); }
    }
    keep.add(p.id);

    // the team: exactly the listed people from today
    const listed = [];
    for (const key of item.people || []) {
      const u = person(key);
      if (!u) { report.warnings.push(`${item.name}: nobody active matches “${key}”`); continue; }
      listed.push(u.id);
      const a = db.prepare('SELECT * FROM project_assignments WHERE project_id = ? AND user_id = ? ORDER BY (end_date IS NULL) DESC, COALESCE(end_date, \'9999\') DESC').get(p.id, u.id);
      if (a) {
        db.prepare("UPDATE project_assignments SET status = 'confirmed', end_date = NULL, confirmed_by = COALESCE(confirmed_by, ?), confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ?").run(actor.id, now(), a.id);
        report.people.push(`${u.name} on ${p.name}${a.status !== 'confirmed' || a.end_date ? ' (confirmed, open-ended)' : ''}`);
      } else {
        db.prepare("INSERT INTO project_assignments (id, tenant_id, project_id, user_id, role, status, start_date, source, confirmed_by, confirmed_at) VALUES (?,?,?,?,?, 'confirmed', ?, 'GB active projects list', ?, ?)")
          .run(uid('asg_'), T, p.id, u.id, item.role || 'team member', asOf, actor.id, now());
        report.people.push(`${u.name} added to ${p.name}`);
      }
    }
    const lead = db.prepare('SELECT lead_user_id FROM projects WHERE id = ?').get(p.id).lead_user_id;
    for (const a of db.prepare("SELECT a.id, u.name FROM project_assignments a JOIN users u ON u.id = a.user_id WHERE a.project_id = ? AND (a.end_date IS NULL OR a.end_date >= ?) AND a.status != 'historical'").all(p.id, asOf)) {
      const uidOf = db.prepare('SELECT user_id FROM project_assignments WHERE id = ?').get(a.id).user_id;
      if (listed.includes(uidOf) || uidOf === lead) continue;
      db.prepare('UPDATE project_assignments SET end_date = ? WHERE id = ?').run(end, a.id);
      report.people.push(`${a.name} no longer on ${p.name} (ended ${end})`);
    }
    if (!lead) report.warnings.push(`${p.name} has no project lead — set one in Deliverables & contributions`);
  }

  // everything else that was running is now completed
  for (const p of db.prepare("SELECT id, name FROM projects WHERE tenant_id = ? AND kind = 'engagement' AND status = 'active' AND register_status != 'archived'").all(T)) {
    if (keep.has(p.id)) continue;
    db.prepare("UPDATE projects SET status = 'completed', end_date = COALESCE(CASE WHEN end_date > ? THEN ? ELSE end_date END, ?) WHERE id = ?").run(end, end, end, p.id);
    const n = db.prepare("UPDATE project_assignments SET end_date = ? WHERE project_id = ? AND (end_date IS NULL OR end_date > ?)").run(end, p.id, end).changes;
    report.closed.push(`${p.name} — completed${n ? `, ${n} assignment${n === 1 ? '' : 's'} ended ${end}` : ''}`);
  }
  for (const e of db.prepare("SELECT e.key, e.title_en, c.name_en client, e.project_id FROM engagements e LEFT JOIN clients c ON c.id = e.client_id WHERE e.tenant_id = ? AND e.status = 'running'").all(T))
    if (!keep.has(e.project_id)) report.library_still_running.push(`${e.client || ''} — ${e.title_en} (${e.key})`);
  audit(db, { tenantId: T, actorId: actor.id, action: 'projects.active_list', entity: 'tenant', entityId: T, after: { as_of: asOf, active: [...keep] } });
  return report;
}
