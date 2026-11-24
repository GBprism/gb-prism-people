// Synthetic workspace for development, tests and demos. No real GB records.
import { tx, J } from './db.js';
import { DEFAULT_SCORING } from './domain/scoring.js';
import { CANDIDATE_POLICY } from './domain/leave.js';

export const SYN = {
  tenant: 'gb', other: 'other',
  partner: 'u_partner', manager: 'u_manager', emp: 'u_emp', senior: 'u_senior', am: 'u_am', lead: 'u_lead',
  peer: 'u_peer', unrelated: 'u_unrelated', ops: 'u_ops', otherUser: 'u_other', newbie: 'u_newbie',
};

const anchors = (title) => ({ 1: `${title}: rarely demonstrated; needs close support`, 3: `${title}: consistently demonstrated at role level`, 5: `${title}: role model; coaches others` });

export const TEMPLATES = [
  { role_family: 'consultant', weights: { objective: 40, competency: 40, initiative: 20 }, items: [
    { category: 'objective', title: 'Deliverable quality', kpi: '% deliverables accepted without major rework', weight: 50 },
    { category: 'objective', title: 'Data traceability', kpi: '% of figures traceable to a source', weight: 50 },
    { category: 'competency', title: 'Structured thinking', weight: 50, expected_proficiency: 3 },
    { category: 'competency', title: 'Collaboration', weight: 50, expected_proficiency: 3 },
    { category: 'initiative', title: 'Internal initiative', weight: 100 } ] },
  { role_family: 'senior_consultant', weights: { objective: 50, competency: 30, initiative: 20 }, items: [
    { category: 'objective', title: 'Workstream delivery', kpi: 'Milestones on time', weight: 40 },
    { category: 'objective', title: 'Quality assurance', kpi: 'QA findings closed before client review', weight: 30 },
    { category: 'objective', title: 'Client management', kpi: 'Client feedback score', weight: 30 },
    { category: 'competency', title: 'Analytical depth', weight: 50, expected_proficiency: 4 },
    { category: 'competency', title: 'Coaching juniors', weight: 50, expected_proficiency: 3 },
    { category: 'initiative', title: 'Method or template contribution', weight: 100 } ] },
  { role_family: 'assistant_manager', weights: { objective: 40, competency: 40, initiative: 20 }, items: [
    { category: 'objective', title: 'Engagement margin', kpi: 'Margin vs budget', weight: 40 },
    { category: 'objective', title: 'Proposals', kpi: 'Proposals led / won', weight: 30 },
    { category: 'objective', title: 'Team development', kpi: 'Development plans in place', weight: 30 },
    { category: 'competency', title: 'Commercial judgment', weight: 50, expected_proficiency: 4 },
    { category: 'competency', title: 'People leadership', weight: 50, expected_proficiency: 4 },
    { category: 'initiative', title: 'Firm-building initiative', weight: 100 } ] },
];

export function seedSynthetic(db, { year = 2026 } = {}) {
  return tx(db, () => {
    if (db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(SYN.tenant)) return false;
    db.prepare("INSERT INTO tenants (id, name) VALUES (?, 'GB Advisory (synthetic)'), (?, 'Other workspace')").run(SYN.tenant, SYN.other);
    const U = (id, name, email, roles = [], t = SYN.tenant) => {
      db.prepare('INSERT INTO users (id, tenant_id, email, name, synthetic) VALUES (?,?,?,?,1)').run(id, t, email, name);
      for (const r of roles) db.prepare('INSERT INTO user_roles VALUES (?,?)').run(id, r);
    };
    U(SYN.partner, 'Pat Partner', 'partner@example.test', ['partner']);
    U(SYN.manager, 'Maya Manager', 'manager@example.test');
    U(SYN.emp, 'Eli Employee', 'eli@example.test');
    U(SYN.senior, 'Sara Senior', 'sara@example.test');
    U(SYN.am, 'Adam Assistant', 'adam@example.test');
    U(SYN.lead, 'Leo Lead', 'leo@example.test');
    U(SYN.peer, 'Pia Peer', 'pia@example.test');
    U(SYN.unrelated, 'Uma Unrelated', 'uma@example.test');
    U(SYN.ops, 'Ola Ops', 'ops@example.test', ['people_ops', 'admin']);
    U(SYN.newbie, 'Nour New', 'nour@example.test');
    U(SYN.otherUser, 'Otto Other', 'otto@example.test', ['people_ops', 'admin', 'partner'], SYN.other);
    const E = (user, title, family, manager, extra = {}) => db.prepare(`INSERT INTO employments (id, tenant_id, user_id, title, role_family, manager_id, backup_approver_id, country, hire_date, probation_end, effective_from)
        VALUES (?,?,?,?,?,?,?, 'JO', ?, ?, ?)`).run(`emp_${user}`, SYN.tenant, user, title, family, manager, extra.backup ?? SYN.partner, extra.hire ?? '2024-01-01', extra.probation ?? '2024-04-01', extra.from ?? '2024-01-01');
    E(SYN.emp, 'Consultant', 'consultant', SYN.manager);
    E(SYN.senior, 'Senior Consultant', 'senior_consultant', SYN.manager);
    E(SYN.am, 'Assistant Manager', 'assistant_manager', SYN.manager);
    E(SYN.lead, 'Senior Consultant', 'senior_consultant', SYN.manager);
    E(SYN.peer, 'Consultant', 'consultant', SYN.unrelated);
    E(SYN.manager, 'Consulting Manager', 'manager', SYN.partner, { backup: null });
    E(SYN.unrelated, 'Consulting Manager', 'manager', SYN.partner, { backup: null });
    E(SYN.ops, 'Admin Lead', 'admin', SYN.manager);
    E(SYN.partner, 'Managing Partner', 'partner', null, { backup: null });
    E(SYN.newbie, 'Analyst', 'consultant', SYN.manager, { hire: `${year}-10-01`, probation: `${year + 1}-01-01`, from: `${year}-10-01` });

    // templates (candidate until GB approves)
    for (const t of TEMPLATES) db.prepare(`INSERT INTO role_templates (id, tenant_id, role_family, version, category_weights_json, starter_items_json, status, source_note) VALUES (?,?,?,1,?,?,'candidate',?)`)
      .run(`tpl_${t.role_family}`, SYN.tenant, t.role_family, J(t.weights), J(t.items.map((i) => ({ ...i, anchors: i.category === 'competency' ? anchors(i.title) : undefined }))),
        'Weights from 2026 sample forms (40/40/20, 50/30/20) — candidate, verify per approved plan');

    db.prepare(`INSERT INTO cycles (id, tenant_id, year, name, status, self_due, manager_due, calibration_due, scoring_json) VALUES (?,?,?,?, 'open', ?,?,?,?)`)
      .run(`cyc_${year}`, SYN.tenant, year, `${year} year-end review`, `${year}-12-10`, `${year}-12-20`, `${year}-12-28`, J(DEFAULT_SCORING));
    db.prepare(`INSERT INTO cycles (id, tenant_id, year, name, status, self_due, scoring_json) VALUES (?,?,?,?, 'planning', ?, ?)`)
      .run(`cyc_${year + 1}`, SYN.tenant, year + 1, `${year + 1} plan`, `${year + 1}-02-15`, J(DEFAULT_SCORING));
    db.prepare(`INSERT INTO cycles (id, tenant_id, year, name, status, scoring_json) VALUES ('cyc_other', ?, ?, 'Other cycle', 'open', ?)`).run(SYN.other, year, J(DEFAULT_SCORING));

    // leave types (vendor_label = LeaveBoard category name)
    const LT = (code, name, category, o = {}) => db.prepare(`INSERT INTO leave_types (id, tenant_id, code, name, category, tracks_balance, allow_partial, requires_cover, reason_required, vendor_label)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(`lt_${code}`, SYN.tenant, code, name, category, o.balance === false ? 0 : 1, o.partial === false ? 0 : 1, o.cover ? 1 : 0, o.reason ? 1 : 0, o.vendor === undefined ? name : o.vendor);
    LT('AV', 'Annual vacation', 'leave', { cover: true, vendor: 'Annual Vacation' });
    LT('SL', 'Sick leave', 'leave', { reason: true, vendor: 'Sick leave' });
    LT('WFH', 'Work from home / off-site', 'offsite', { balance: false, vendor: 'Work From Home' });
    LT('COO', 'Compensation of overtime', 'leave', { vendor: 'Compensation of Overtime' });
    LT('OT', 'Overtime', 'overtime', { balance: false, vendor: 'Overtime' });
    LT('WL', 'Wedding leave', 'leave', { partial: false, vendor: 'Wedding Leave' });
    LT('AC', 'At client', 'client', { balance: false, vendor: null });
    db.prepare(`INSERT INTO policy_versions (id, tenant_id, version, effective_from, status, settings_json, note) VALUES ('pol_1', ?, 1, '2024-01-01', 'awaiting_confirmation', ?, ?)`)
      .run(SYN.tenant, J(CANDIDATE_POLICY), 'Transcribed from the handbook and LeaveBoard; every value awaits GB confirmation');
    const H = (d, n) => db.prepare("INSERT INTO holidays (id, tenant_id, calendar, date, name) VALUES (?,?, 'JO', ?, ?)").run(`hol_${d}`, SYN.tenant, d, n);
    H(`${year}-12-25`, 'Christmas Day (sample)'); H(`${year + 1}-01-01`, "New Year's Day (sample)"); H(`${year}-05-25`, 'Independence Day (sample)');

    // synthetic opening balances (AV 14, SL 14) for the current year
    for (const u of [SYN.emp, SYN.senior, SYN.am, SYN.lead, SYN.peer, SYN.manager, SYN.newbie]) {
      for (const [code, amt] of [['AV', 1400], ['SL', 1400], ['COO', 300]]) {
        db.prepare(`INSERT INTO leave_ledger (tenant_id, user_id, type_id, period_year, kind, amount_x100, effective_date, note, entry_key, created_at)
            VALUES (?,?,?,?, 'grant', ?, ?, 'Synthetic grant', ?, datetime('now'))`).run(SYN.tenant, u, `lt_${code}`, year, amt, `${year}-01-01`, `seedgrant:${u}:${code}:${year}`);
      }
    }
    // projects
    const P = (id, name, lead, status = 'approved', kind = 'engagement') => db.prepare(`INSERT INTO projects (id, tenant_id, name, client, kind, lead_user_id, register_status, start_date, end_date) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, SYN.tenant, name, 'Synthetic client', kind, lead, status, `${year}-01-01`, `${year}-12-31`);
    P('prj_alpha', 'Project Alpha — strategy', SYN.lead);
    P('prj_beta', 'Project Beta — feasibility', SYN.am);
    P('prj_prop', 'Proposal Gamma', SYN.am, 'approved', 'proposal');
    const A = (id, p, u, role, status) => db.prepare(`INSERT INTO project_assignments (id, tenant_id, project_id, user_id, role, status, start_date, end_date, source) VALUES (?,?,?,?,?,?,?,?, 'seed')`)
      .run(id, SYN.tenant, p, u, role, status, `${year}-02-01`, `${year}-11-30`);
    A('asg_emp_alpha', 'prj_alpha', SYN.emp, 'analyst', 'confirmed');
    A('asg_lead_alpha', 'prj_alpha', SYN.lead, 'lead', 'confirmed');
    A('asg_senior_alpha', 'prj_alpha', SYN.senior, 'author', 'confirmed');
    A('asg_emp_beta', 'prj_beta', SYN.emp, 'support', 'provisional');
    A('asg_senior_beta', 'prj_beta', SYN.senior, 'author', 'confirmed');
    db.prepare("INSERT INTO deliverables (id, tenant_id, project_id, workstream, title, version, milestone, status) VALUES ('dlv_alpha_report', ?, 'prj_alpha', 'Strategy', 'Final strategy report', 'v3', 'Board submission', 'accepted')").run(SYN.tenant);
    db.prepare("INSERT INTO settings (tenant_id, key, value_json) VALUES (?, 'notification_test_inbox', ?), (?, 'notification_mode', ?)").run(SYN.tenant, J('prism-test-inbox@example.test'), SYN.tenant, J('test'));
    // leaveboard alias examples (synthetic)
    db.prepare("INSERT INTO identity_aliases (id, tenant_id, user_id, source, alias, verified) VALUES ('al1', ?, ?, 'leaveboard', 'Eli Employe', 1), ('al2', ?, ?, 'leaveboard', 'Sara Snr', 0)").run(SYN.tenant, SYN.emp, SYN.tenant, SYN.senior);
    return true;
  });
}

/** Create 2026 plans from templates for the synthetic team and approve them. */
export function seedPlans(db, { year = 2026 } = {}) {
  const map = [[SYN.emp, 'consultant'], [SYN.senior, 'senior_consultant'], [SYN.am, 'assistant_manager'], [SYN.lead, 'senior_consultant'], [SYN.peer, 'consultant']];
  for (const [u, fam] of map) {
    if (db.prepare('SELECT 1 FROM plans WHERE cycle_id = ? AND user_id = ?').get(`cyc_${year}`, u)) continue;
    const t = TEMPLATES.find((x) => x.role_family === fam);
    const reviewer = u === SYN.peer ? SYN.unrelated : SYN.manager;
    const pid = `plan_${u}_${year}`;
    db.prepare(`INSERT INTO plans (id, tenant_id, cycle_id, user_id, reviewer_id, partner_id, template_id, role_title, state, category_weights_json, rubric_version, approved_revision, basis_status, created_at)
        VALUES (?,?,?,?,?,?,?,?, 'approved_plan', ?, ?, 1, 'verified', datetime('now'))`).run(pid, SYN.tenant, `cyc_${year}`, u, reviewer, SYN.partner, `tpl_${fam}`, fam, J(t.weights), `${fam}@v1`);
    t.items.forEach((it, i) => db.prepare(`INSERT INTO plan_items (id, tenant_id, plan_id, category, position, title, kpi, target, weight, expected_proficiency, anchors_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(`${pid}_i${i}`, SYN.tenant, pid, it.category, i, it.title, it.kpi ?? null, it.category === 'objective' ? 'Target agreed in plan' : null, it.weight, it.expected_proficiency ?? null, it.category === 'competency' ? J(anchors(it.title)) : null));
    db.prepare("INSERT INTO plan_revisions (id, plan_id, revision, kind, snapshot_json, approved_by, approved_at, note) VALUES (?, ?, 1, 'approval', '{}', ?, datetime('now'), 'Seeded approved plan')").run(`rev_${pid}`, pid, reviewer);
  }
}
