// GB "2026 PMS – Consultant Reviewers" workbook: three sheets, one loader.
//   Employee Profiles  → HR profile (restricted) + level/joining date/probation on the roster
//   Reviewer Matrix    → section reviewers, project-feedback inputs and the reason for the choice
//   2026 Project Log   → project register (candidate) + assignments as leads for seniors to confirm
// Idempotent: re-running updates in place and never duplicates projects, assignments or invites.
// Nothing here touches ratings. Run with dry=true to see the report without writing.
import { tx, uid, now, audit } from '../db.js';
import { currentEmployment } from '../domain/authz.js';
import { setCategoryReviewer, inviteInput } from '../domain/performance.js';
import { createProject } from '../domain/projects.js';
import { updateProfile } from '../domain/profiles.js';
import { readWorkbook, str, val } from './xlsx.js';

const SOURCE = '2026 PMS – Consultant Reviewers workbook';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const iso = (c) => { const v = val(c); if (v instanceof Date) return v.toISOString().slice(0, 10); const m = /(\d{4}-\d{2}-\d{2})/.exec(String(v ?? '')); return m ? m[1] : null; };

/** Name matcher tolerant of spelling variants ("Ghaith Al Battikhi" ↔ "Ghaith Battikhi"). */
export function nameMatcher(users) {
  const list = users.map((u) => ({ ...u, n: norm(u.name), first: norm(u.name).split(' ')[0], rest: norm(u.name).split(' ').slice(1).join('').replace(/^al/, '') }));
  const common = (a, b) => { let best = 0; for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) { let k = 0; while (a[i + k] && a[i + k] === b[j + k]) k++; best = Math.max(best, k); } return best; };
  return (raw) => {
    const s = norm(String(raw || '').replace(/\(.*?\)/g, ''));
    if (!s || s === 'not identified') return null;
    const exact = list.find((u) => u.n === s || (u.aliases || []).some((a) => norm(a) === s)); if (exact) return exact;
    const [first, ...r] = s.split(' '); const rest = r.join('').replace(/^al/, '');
    const same = list.filter((u) => u.first === first);
    if (same.length === 1 && (!rest || common(rest, same[0].rest) >= 3)) return same[0];
    if (!rest) return null;
    const scored = same.map((u) => [common(rest, u.rest), u]).sort((a, b) => b[0] - a[0]);
    return scored[0] && scored[0][0] >= 3 && (!scored[1] || scored[1][0] < scored[0][0]) ? scored[0][1] : null;
  };
}

/** "Jan–Feb", "H1", "Sep onward", "Oct–Nov" → start/end dates in the given year. */
export function parseWhen(s, year = 2026) {
  const t = String(s || '').toLowerCase();
  if (/\bh1\b/.test(t)) return { start: `${year}-01-01`, end: `${year}-06-30` };
  if (/\bh2\b/.test(t)) return { start: `${year}-07-01`, end: `${year}-12-31` };
  const ms = [...t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/g)].map((m) => MONTHS.indexOf(m[1]));
  if (!ms.length) return { start: null, end: null };
  const a = Math.min(...ms); const b = Math.max(...ms);
  const last = new Date(Date.UTC(year, b + 1, 0)).getUTCDate();
  return { start: `${year}-${String(a + 1).padStart(2, '0')}-01`, end: /onward|ongoing/.test(t) ? null : `${year}-${String(b + 1).padStart(2, '0')}-${last}` };
}

function table(sheet, headerTest) {
  const hi = sheet.rows.findIndex((r) => headerTest(r.map(str)));
  if (hi < 0) return [];
  const head = sheet.rows[hi].map(str);
  const out = [];
  for (let i = hi + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i]; const cells = r.map(str);
    if (!cells.some(Boolean)) continue;
    if (headerTest(cells)) { out.push({ __header: cells }); continue; } // a second block with its own header row
    out.push(Object.fromEntries(head.map((h, j) => [h, r[j]])));
  }
  return out;
}

export async function parseGbWorkbook(buffer) {
  const sheets = await readWorkbook(buffer);
  const get = (re) => sheets.find((s) => re.test(s.name));
  const prof = get(/employee profiles/i); const mat = get(/reviewer matrix/i); const log = get(/project log/i);
  const out = { profiles: [], matrix: [], log: [] };
  if (prof) {
    for (const r of table(prof, (c) => c[0] === 'Employee')) {
      const g = (re) => { const k = Object.keys(r).find((x) => re.test(x)); return k ? r[k] : null; };
      const ageHead = Object.keys(r).find((x) => /^age/i.test(x)) || '';
      const ageOn = /\((\w{3})\w*\s+(\d{4})\)/.exec(ageHead);
      out.profiles.push({
        name: str(g(/^employee$/i)), level: str(g(/^level/i)), hire_date: iso(g(/joining date/i)),
        age_recorded: Number.isFinite(Number(val(g(/^age/i)))) && val(g(/^age/i)) !== null ? Number(val(g(/^age/i))) : null,
        age_recorded_on: ageOn ? `${ageOn[2]}-${String(MONTHS.indexOf(ageOn[1].toLowerCase()) + 1).padStart(2, '0')}-01` : null,
        date_of_birth: iso(g(/date of birth/i)), probation_status: str(g(/probation/i)), probation_end: iso(g(/probation/i)),
        contract_status: str(g(/contract/i)), social_security_status: str(g(/social security/i)), medical_insurance_status: str(g(/medical/i)),
        gym_stipend_status: str(g(/gym/i)), projects_summary: str(g(/projects/i)), proposals_summary: str(g(/proposals/i)), gaps: str(g(/gaps/i)),
      });
    }
  }
  if (mat) {
    let section = null;
    for (const r of table(mat, (c) => /^(consultant|senior consultant)$/i.test(c[0]) && c.some((x) => /competenc/i.test(x)))) {
      if (r.__header) { section = r.__header; continue; }
      const cells = Object.values(r).map(str);
      if (cells.filter(Boolean).length < 3) continue; // a section title such as "Senior Consultants – reviewed by …"
      const head = section || Object.keys(r);
      const senior = /senior consultant/i.test(head[0]);
      const at = (re) => cells[head.findIndex((h) => re.test(h))] || '';
      out.matrix.push({ name: cells[0], senior, competency: at(/competenc/i), technical: at(/technical/i),
        primary: senior ? at(/assistant manager/i) : at(/primary/i), secondary: senior ? at(/backup|second/i) : at(/secondary/i),
        rationale: at(/projects behind/i), status: at(/^status/i) });
    }
  }
  if (log) {
    for (const r of table(log, (c) => c[0] === 'Consultant' && c.some((x) => /evidence/i.test(x)))) {
      const g = (re) => str(r[Object.keys(r).find((x) => re.test(x))]);
      out.log.push({ name: g(/^consultant/i), project: g(/project/i), work: g(/^work/i), when: g(/^when/i), senior: g(/senior/i), evidence: g(/evidence/i), confidence: g(/confidence/i) });
    }
  }
  return out;
}

const STATUS = (s) => (/^confirmed/i.test(s) ? 'confirmed' : /change/i.test(s) ? 'change_requested' : 'draft');

export function applyGbWorkbook(db, actor, parsed, { cycleId, year = 2026, dry = false } = {}) {
  const users = db.prepare('SELECT id, name FROM users WHERE tenant_id = ? AND active = 1').all(actor.tenantId)
    .map((u) => ({ ...u, aliases: db.prepare('SELECT alias FROM identity_aliases WHERE user_id = ?').all(u.id).map((a) => a.alias) }));
  const match = nameMatcher(users);
  const report = { profiles: [], reviewers: [], projects: [], skipped: [] };
  const alias = (u, name) => { if (norm(u.name) !== norm(name)) db.prepare('INSERT OR IGNORE INTO identity_aliases (id, tenant_id, user_id, source, alias, verified) VALUES (?,?,?,?,?,1)').run(uid('ali_'), actor.tenantId, u.id, 'gb-workbook', name); };
  const run = () => {
    // ---------------------------------------------------------- profiles
    for (const p of parsed.profiles) {
      const u = match(p.name);
      if (!u) { report.skipped.push(`Profile: ${p.name} — not on the roster (left or excluded)`); continue; }
      alias(u, p.name);
      const { name, hire_date, probation_end, ...fields } = p;
      updateProfile(db, actor, u.id, fields, { source: SOURCE });
      const notes = [];
      const emp = currentEmployment(db, u.id);
      if (emp) {
        if (hire_date && emp.hire_date !== hire_date) { db.prepare('UPDATE employments SET hire_date = ? WHERE id = ?').run(hire_date, emp.id); notes.push(`joining date ${emp.hire_date || '—'} → ${hire_date}`); }
        if (probation_end && emp.probation_end !== probation_end) { db.prepare('UPDATE employments SET probation_end = ? WHERE id = ?').run(probation_end, emp.id); notes.push(`probation end → ${probation_end}`); }
        if (p.level && emp.title !== p.level) {
          db.prepare("UPDATE employments SET effective_to = date('now','-1 day') WHERE id = ?").run(emp.id);
          db.prepare(`INSERT INTO employments (id, tenant_id, user_id, title, role_family, manager_id, backup_approver_id, country, hire_date, probation_end, effective_from)
              SELECT ?, tenant_id, user_id, ?, role_family, manager_id, backup_approver_id, country, hire_date, probation_end, date('now') FROM employments WHERE id = ?`).run(uid('emp_'), p.level, emp.id);
          notes.push(`title ${emp.title} → ${p.level}`);
        }
        if (notes.length) audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'roster.workbook', entity: 'user', entityId: u.id, reason: SOURCE, after: { notes } });
      }
      report.profiles.push(`${u.name}: profile saved${notes.length ? `; ${notes.join('; ')}` : ''}`);
    }
    // ---------------------------------------------------------- reviewers
    const cycle = cycleId ? db.prepare('SELECT * FROM cycles WHERE id = ? AND tenant_id = ?').get(cycleId, actor.tenantId)
      : db.prepare('SELECT * FROM cycles WHERE tenant_id = ? AND year = ? ORDER BY status = \'historical\' LIMIT 1').get(actor.tenantId, year);
    for (const m of parsed.matrix) {
      const u = match(m.name);
      if (!u) { report.skipped.push(`Reviewers: ${m.name} — not on the roster (left or excluded)`); continue; }
      const plan = cycle && db.prepare('SELECT * FROM plans WHERE cycle_id = ? AND user_id = ?').get(cycle.id, u.id);
      if (!plan) { report.skipped.push(`Reviewers: ${u.name} — no ${cycle?.name || String(year)} plan yet`); continue; }
      if (['partner_calibration', 'released', 'acknowledged', 'closed'].includes(plan.state)) { report.skipped.push(`Reviewers: ${u.name} — review already past manager stage, not changed`); continue; }
      const comp = match(m.competency); const tech = match(m.technical);
      // the competencies reviewer leads the review (approves the plan, writes the summary, submits)
      if (comp && comp.id !== plan.reviewer_id) {
        db.prepare('UPDATE plans SET reviewer_id = ? WHERE id = ?').run(comp.id, plan.id);
        audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'plan.reviewer', entity: 'plan', entityId: plan.id, reason: SOURCE, after: { reviewerId: comp.id } });
      }
      if (comp) setCategoryReviewer(db, actor, plan.id, { category: 'competency', userId: comp.id });
      if (tech) setCategoryReviewer(db, actor, plan.id, { category: 'objective', userId: tech.id });
      const given = new Set([comp?.id, tech?.id, u.id]);
      const inputs = [[m.primary, m.senior ? 'Assistant Manager review' : 'Project feedback (primary senior)'], [m.secondary, m.senior ? 'Second input' : 'Project feedback (secondary senior)']];
      const invited = [];
      for (const [who, label] of inputs) {
        const x = match(who); if (!x || given.has(x.id)) continue;
        given.add(x.id); inviteInput(db, actor, plan.id, { inviteeId: x.id, label }); invited.push(`${x.name} (${label})`);
      }
      db.prepare(`INSERT INTO plan_reviewer_notes (plan_id, tenant_id, rationale, status, source, updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(plan_id) DO UPDATE SET rationale = excluded.rationale, source = excluded.source, updated_at = excluded.updated_at,
          status = CASE WHEN plan_reviewer_notes.confirmed_by IS NULL THEN excluded.status ELSE plan_reviewer_notes.status END`)
        .run(plan.id, actor.tenantId, m.rationale || null, STATUS(m.status), SOURCE, now());
      report.reviewers.push(`${u.name}: competencies ${comp?.name || '—'} (leads), objectives ${tech?.name || '—'}${invited.length ? `, input from ${invited.join(', ')}` : ''} · ${m.status || 'Draft'}`);
    }
    // ---------------------------------------------------------- project log
    const groups = new Map();
    for (const r of parsed.log) {
      const proposal = /proposal/i.test(`${r.project} ${r.work}`);
      const name = proposal && !/proposal/i.test(r.project) ? `${r.project} – ${r.work}` : r.project;
      const key = `${proposal ? 'proposal' : 'engagement'}|${norm(name)}`;
      if (!groups.has(key)) groups.set(key, { name, kind: proposal ? 'proposal' : 'engagement', rows: [] });
      groups.get(key).rows.push(r);
    }
    for (const g of groups.values()) {
      for (const r of g.rows) if (!match(r.name)) report.skipped.push(`Project log: ${r.name} on ${g.name} — not on the roster`);
      g.rows = g.rows.filter((r) => match(r.name));
      if (!g.rows.length) continue;
      const leads = g.rows.map((r) => match(String(r.senior).split('/')[0])).filter(Boolean);
      const counts = new Map(); for (const l of leads) counts.set(l.id, (counts.get(l.id) || 0) + 1);
      const leadId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      let prj = db.prepare('SELECT * FROM projects WHERE tenant_id = ? AND kind = ? AND lower(name) = lower(?)').get(actor.tenantId, g.kind, g.name);
      const spans = g.rows.map((r) => parseWhen(r.when, year));
      if (!prj) {
        const id = createProject(db, actor, { name: g.name, client: g.name.split(/[–(/]/)[0].trim(), kind: g.kind, leadUserId: leadId, sourceRef: SOURCE,
          startDate: spans.map((s) => s.start).filter(Boolean).sort()[0] || null, endDate: spans.some((s) => !s.end) ? null : spans.map((s) => s.end).sort().at(-1) || null });
        prj = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
        report.projects.push(`${g.kind === 'proposal' ? 'Proposal' : 'Project'} added: ${g.name} (lead ${users.find((u) => u.id === leadId)?.name || 'to be identified'})`);
      } else if (!prj.lead_user_id && leadId) db.prepare('UPDATE projects SET lead_user_id = ? WHERE id = ?').run(leadId, prj.id);
      g.rows.forEach((r, i) => {
        const u = match(r.name);
        const source = `${SOURCE}: senior ${r.senior || '—'}; evidence: ${r.evidence || '—'}; confidence: ${r.confidence || '—'}`;
        // evidence is a lead, not a confirmation: the project lead confirms in Projects
        const status = /^confirmed$/i.test(r.confidence) ? 'tentative' : 'provisional';
        const ex = db.prepare('SELECT id, status FROM project_assignments WHERE project_id = ? AND user_id = ? AND role = ?').get(prj.id, u.id, r.work || 'team member');
        if (ex) { if (!['confirmed', 'historical'].includes(ex.status)) db.prepare('UPDATE project_assignments SET source = ?, status = ?, start_date = ?, end_date = ? WHERE id = ?').run(source, status, spans[i].start, spans[i].end, ex.id); return; }
        db.prepare(`INSERT INTO project_assignments (id, tenant_id, project_id, user_id, role, status, start_date, end_date, source) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(uid('asg_'), actor.tenantId, prj.id, u.id, r.work || 'team member', status, spans[i].start, spans[i].end, source);
        report.projects.push(`  ${u.name} → ${g.name}: ${r.work} (${r.when}; ${r.confidence || 'unrated'})`);
      });
    }
    if (dry) throw Object.assign(new Error('dry-run'), { dry: true });
  };
  try { tx(db, run); } catch (e) { if (!e.dry) throw e; report.dry = true; }
  return report;
}

/**
 * Apply verified HR facts found in email (insurer member list, contract and probation emails)
 * on top of the workbook. evidence = { sources, people: [{ name, <profile fields>, probation_end, remove_gaps: [] }] }.
 * Only profile fields are accepted; anything else in the file is ignored.
 */
export function applyHrEvidence(db, actor, evidence, { dry = false } = {}) {
  const users = db.prepare('SELECT id, name FROM users WHERE tenant_id = ? AND active = 1').all(actor.tenantId)
    .map((u) => ({ ...u, aliases: db.prepare('SELECT alias FROM identity_aliases WHERE user_id = ?').all(u.id).map((a) => a.alias) }));
  const match = nameMatcher(users);
  const allowed = ['date_of_birth', 'probation_status', 'contract_status', 'social_security_status', 'medical_insurance_status', 'gym_stipend_status'];
  const report = { updated: [], skipped: [] };
  const run = () => {
    for (const p of evidence.people || []) {
      const u = match(p.name);
      if (!u) { report.skipped.push(`${p.name} — not on the roster`); continue; }
      const cur = db.prepare('SELECT gaps FROM employee_profiles WHERE user_id = ?').get(u.id);
      const drop = (p.remove_gaps || []).map((g) => g.toLowerCase());
      const gaps = (cur?.gaps || '').split(/;\s*/).map((g) => g.trim()).filter((g) => g && !drop.some((d) => g.toLowerCase().startsWith(d)));
      const fields = Object.fromEntries(allowed.filter((k) => p[k]).map((k) => [k, p[k]]));
      if (drop.length) fields.gaps = gaps.join('; ');
      if (Object.keys(fields).length) updateProfile(db, actor, u.id, fields, { source: 'Gmail evidence (insurer list, contract and probation emails)' });
      if (p.probation_end) {
        const emp = currentEmployment(db, u.id);
        if (emp && emp.probation_end !== p.probation_end) db.prepare('UPDATE employments SET probation_end = ? WHERE id = ?').run(p.probation_end, emp.id);
      }
      report.updated.push(`${u.name}: ${[...Object.keys(fields), p.probation_end ? 'probation_end' : null].filter(Boolean).join(', ')}`);
    }
    if (dry) throw Object.assign(new Error('dry-run'), { dry: true });
  };
  try { tx(db, run); } catch (e) { if (!e.dry) throw e; report.dry = true; }
  return report;
}
