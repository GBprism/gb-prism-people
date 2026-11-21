// SQLite persistence (node:sqlite). Every business table carries tenant_id so
// queries can be tenant-scoped server-side. Amounts that must keep decimals
// exactly (leave units) are stored as integer hundredths (`*_x100`) and the
// original vendor string is kept alongside in raw columns.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const MIGRATIONS = [
  // ---- 001 core identity, roster, audit ---------------------------------
  `CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Asia/Amman');
   CREATE TABLE users (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
     email TEXT NOT NULL, name TEXT NOT NULL, employee_code TEXT,
     active INTEGER NOT NULL DEFAULT 1, synthetic INTEGER NOT NULL DEFAULT 0,
     UNIQUE(tenant_id, email));
   -- capability roles. 'manager' and 'project_lead' are mostly derived from
   -- assignments; these rows grant workspace-level scopes.
   CREATE TABLE user_roles (user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL
     CHECK (role IN ('employee','partner','people_ops','admin')), PRIMARY KEY(user_id, role));
   -- effective-dated employment / reporting line. Prior rows are retained so
   -- historical reviews keep their original reviewer and role.
   CREATE TABLE employments (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
     title TEXT NOT NULL, role_family TEXT NOT NULL, level TEXT,
     manager_id TEXT REFERENCES users(id), backup_approver_id TEXT REFERENCES users(id),
     country TEXT NOT NULL DEFAULT 'JO', office TEXT, hire_date TEXT, probation_end TEXT,
     effective_from TEXT NOT NULL, effective_to TEXT);
   CREATE TABLE identity_aliases (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT REFERENCES users(id),
     source TEXT NOT NULL, alias TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
     UNIQUE(tenant_id, source, alias));
   -- explicit grants: e.g. people_ops given review access to a cycle. Admin
   -- rights over roster/balances never imply review access on their own.
   CREATE TABLE access_grants (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, scope TEXT NOT NULL,
     object_id TEXT, granted_by TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL);
   CREATE TABLE audit_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, actor_id TEXT,
     action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, reason TEXT,
     before_json TEXT, after_json TEXT, at TEXT NOT NULL);
   CREATE INDEX audit_entity ON audit_events(tenant_id, entity, entity_id);`,

  // ---- 002 projects, deliverables, contributions -------------------------
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, code TEXT, name TEXT NOT NULL, client TEXT,
     kind TEXT NOT NULL DEFAULT 'engagement' CHECK (kind IN ('engagement','proposal','initiative','method')),
     lead_user_id TEXT REFERENCES users(id), status TEXT NOT NULL DEFAULT 'active',
     start_date TEXT, end_date TEXT, register_status TEXT NOT NULL DEFAULT 'candidate'
       CHECK (register_status IN ('candidate','approved','archived')),
     drive_url TEXT, source_ref TEXT, restricted INTEGER NOT NULL DEFAULT 1);
   CREATE TABLE project_assignments (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
     user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('provisional','tentative','confirmed','historical')),
     start_date TEXT, end_date TEXT, source TEXT, confirmed_by TEXT, confirmed_at TEXT);
   CREATE TABLE deliverables (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
     workstream TEXT, title TEXT NOT NULL, version TEXT, milestone TEXT, due_date TEXT,
     status TEXT NOT NULL DEFAULT 'in_progress', drive_url TEXT,
     qa_reviewer_id TEXT REFERENCES users(id), acceptance TEXT);
   CREATE TABLE contributions (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
     user_id TEXT NOT NULL REFERENCES users(id),
     responsibility TEXT NOT NULL CHECK (responsibility IN ('lead','author','analyst','reviewer','support')),
     description TEXT, evidence_url TEXT, lead_source TEXT,
     status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','confirmed','corrected','rejected')),
     reviewed_by TEXT, reviewed_at TEXT, review_note TEXT,
     UNIQUE(deliverable_id, user_id, responsibility));`,

  // ---- 003 performance ---------------------------------------------------
  `CREATE TABLE cycles (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, year INTEGER NOT NULL, name TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'annual', status TEXT NOT NULL DEFAULT 'planning'
       CHECK (status IN ('planning','open','closed','historical')),
     self_due TEXT, manager_due TEXT, calibration_due TEXT,
     scoring_json TEXT NOT NULL, UNIQUE(tenant_id, year, kind));
   CREATE TABLE role_templates (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, role_family TEXT NOT NULL, version INTEGER NOT NULL,
     category_weights_json TEXT NOT NULL, starter_items_json TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','approved','retired')),
     source_note TEXT, UNIQUE(tenant_id, role_family, version));
   CREATE TABLE plans (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, cycle_id TEXT NOT NULL REFERENCES cycles(id),
     user_id TEXT NOT NULL REFERENCES users(id), reviewer_id TEXT REFERENCES users(id),
     partner_id TEXT REFERENCES users(id), template_id TEXT REFERENCES role_templates(id),
     role_title TEXT, state TEXT NOT NULL DEFAULT 'draft_plan',
     category_weights_json TEXT NOT NULL DEFAULT '{}',
     approved_revision INTEGER, rubric_version TEXT,
     basis_status TEXT NOT NULL DEFAULT 'unverified' CHECK (basis_status IN ('unverified','verified','gb_decision')),
     basis_note TEXT, source_ref TEXT,
     summary_json TEXT NOT NULL DEFAULT '{}',
     self_submitted_at TEXT, manager_submitted_at TEXT,
     final_score REAL, final_rating TEXT, score_math_json TEXT, calibration_note TEXT,
     released_at TEXT, acknowledged_at TEXT, ack_comment TEXT, closed_at TEXT,
     row_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
     UNIQUE(cycle_id, user_id));
   CREATE TABLE plan_items (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES plans(id),
     category TEXT NOT NULL CHECK (category IN ('objective','competency','initiative')),
     position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, description TEXT, kpi TEXT,
     target TEXT, weight REAL, expected_proficiency INTEGER, anchors_json TEXT,
     carried_from_item_id TEXT, evidence_required INTEGER NOT NULL DEFAULT 1,
     -- assessment fields kept separate by author
     actual TEXT, self_rating INTEGER, self_rationale TEXT, self_evidence_json TEXT,
     manager_rating INTEGER, manager_rationale TEXT,
     na INTEGER NOT NULL DEFAULT 0, na_reason TEXT, na_approved_by TEXT,
     calibrated_rating INTEGER, calibration_reason TEXT,
     source_rating_raw TEXT, source_ref TEXT);
   CREATE TABLE plan_revisions (
     id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), revision INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('approval','amendment','snapshot')),
     snapshot_json TEXT NOT NULL, approved_by TEXT, approved_at TEXT NOT NULL, note TEXT,
     UNIQUE(plan_id, revision));
   CREATE TABLE plan_transitions (
     id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL,
     actor_id TEXT NOT NULL, reason TEXT, at TEXT NOT NULL);
   CREATE TABLE project_feedback (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES plans(id),
     assignment_id TEXT NOT NULL REFERENCES project_assignments(id), author_id TEXT NOT NULL,
     body TEXT NOT NULL, evidence_url TEXT, created_at TEXT NOT NULL);
   CREATE TABLE feedback_invites (
     id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, assignment_id TEXT NOT NULL, invitee_id TEXT NOT NULL,
     invited_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(plan_id, assignment_id, invitee_id));
   CREATE TABLE development_actions (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES plans(id),
     user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('strength','improvement','development')),
     title TEXT NOT NULL, owner_id TEXT, due_date TEXT,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','dropped')),
     follow_up TEXT, carried_to_plan_id TEXT);
   CREATE TABLE check_ins (
     id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, kind TEXT NOT NULL, held_on TEXT NOT NULL,
     author_id TEXT NOT NULL, note TEXT);
   CREATE TABLE clarifications (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, plan_id TEXT NOT NULL, raised_by TEXT NOT NULL,
     route_to TEXT NOT NULL, question TEXT NOT NULL, answer TEXT, status TEXT NOT NULL DEFAULT 'open',
     created_at TEXT NOT NULL, answered_at TEXT);`,

  // ---- 004 time off / off-site ------------------------------------------
  `CREATE TABLE leave_types (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
     category TEXT NOT NULL CHECK (category IN ('leave','offsite','overtime')),
     unit TEXT NOT NULL DEFAULT 'day', tracks_balance INTEGER NOT NULL DEFAULT 1,
     allow_partial INTEGER NOT NULL DEFAULT 1, requires_cover INTEGER NOT NULL DEFAULT 0,
     reason_required INTEGER NOT NULL DEFAULT 0, vendor_label TEXT, active INTEGER NOT NULL DEFAULT 1,
     UNIQUE(tenant_id, code));
   CREATE TABLE policy_versions (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, version INTEGER NOT NULL,
     effective_from TEXT NOT NULL, effective_to TEXT,
     status TEXT NOT NULL CHECK (status IN ('draft','awaiting_confirmation','approved','superseded')),
     settings_json TEXT NOT NULL, approved_by TEXT, approved_at TEXT, note TEXT,
     UNIQUE(tenant_id, version));
   CREATE TABLE holidays (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, calendar TEXT NOT NULL, date TEXT NOT NULL, name TEXT NOT NULL,
     UNIQUE(tenant_id, calendar, date));
   CREATE TABLE leave_requests (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
     type_id TEXT NOT NULL REFERENCES leave_types(id), start_date TEXT NOT NULL, end_date TEXT NOT NULL,
     start_portion TEXT NOT NULL DEFAULT 'full', end_portion TEXT NOT NULL DEFAULT 'full',
     chargeable_x100 INTEGER NOT NULL, breakdown_json TEXT NOT NULL,
     reason TEXT, cover_user_id TEXT, handover TEXT,
     state TEXT NOT NULL CHECK (state IN ('submitted','approved','declined','withdrawn','cancelled')),
     approver_id TEXT, backup_approver_id TEXT, policy_version INTEGER,
     warnings_json TEXT NOT NULL DEFAULT '[]', exception_json TEXT,
     decided_by TEXT, decided_at TEXT, decision_note TEXT,
     source TEXT NOT NULL DEFAULT 'prism', source_ref TEXT,
     client_key TEXT, row_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
     UNIQUE(tenant_id, user_id, client_key), UNIQUE(tenant_id, source, source_ref));
   -- Append-only ledger. 'reservation' rows are pending holds (do not reduce
   -- the posted balance); 'usage' is a posted deduction. entry_key makes every
   -- posting idempotent (retries / re-imports cannot double count).
   CREATE TABLE leave_ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
     type_id TEXT NOT NULL, period_year INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('opening','grant','accrual','carryover','expiry',
       'reservation','reservation_release','usage','reversal','adjustment')),
     amount_x100 INTEGER NOT NULL, effective_date TEXT NOT NULL, request_id TEXT,
     note TEXT, actor_id TEXT, entry_key TEXT NOT NULL, batch_id TEXT, created_at TEXT NOT NULL,
     UNIQUE(tenant_id, entry_key));
   CREATE INDEX ledger_user ON leave_ledger(tenant_id, user_id, type_id, period_year);`,

  // ---- 005 imports, vendor snapshots ---------------------------------------
  `CREATE TABLE import_batches (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL,
     file_sha256 TEXT NOT NULL, vendor TEXT, generated_at TEXT, reporting_from TEXT, reporting_to TEXT,
     filters_note TEXT, status TEXT NOT NULL CHECK (status IN ('previewed','applied','rejected','reversed')),
     summary_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
     approved_by TEXT, applied_at TEXT, reversed_by TEXT, reversed_at TEXT, reversal_reason TEXT);
   CREATE TABLE import_rows (
     id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL REFERENCES import_batches(id),
     sheet TEXT, row_no INTEGER, source_key TEXT, raw_json TEXT NOT NULL,
     match_user_id TEXT, match_status TEXT NOT NULL, issues_json TEXT NOT NULL DEFAULT '[]',
     action TEXT NOT NULL CHECK (action IN ('insert','update','unchanged','skip','reject','review')));
   CREATE TABLE vendor_snapshot_values (
     id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, batch_id TEXT NOT NULL,
     report TEXT NOT NULL, vendor_name TEXT NOT NULL, user_id TEXT, period TEXT,
     category TEXT NOT NULL, metric TEXT NOT NULL, raw_value TEXT, value_x100 INTEGER,
     UNIQUE(batch_id, vendor_name, category, metric));
   CREATE TABLE attendance_days (
     id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, batch_id TEXT NOT NULL,
     vendor_name TEXT NOT NULL, user_id TEXT, date TEXT NOT NULL, raw_value TEXT,
     hours_x100 INTEGER, code TEXT, code_hours_x100 INTEGER, is_future INTEGER NOT NULL,
     UNIQUE(batch_id, vendor_name, date));`,

  // ---- 006 AI adoption (kept apart from performance scoring) --------------
  `CREATE TABLE ai_usage_exports (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, tool TEXT NOT NULL CHECK (tool IN ('gemini','claude')),
     report TEXT NOT NULL, window_from TEXT NOT NULL, window_to TEXT NOT NULL, exported_at TEXT NOT NULL,
     plan_note TEXT, spend_scope TEXT, imported_by TEXT NOT NULL, file_sha256 TEXT NOT NULL,
     UNIQUE(tenant_id, file_sha256));
   CREATE TABLE ai_usage_rows (
     id INTEGER PRIMARY KEY AUTOINCREMENT, export_id TEXT NOT NULL REFERENCES ai_usage_exports(id),
     account_email TEXT NOT NULL, user_id TEXT,
     access TEXT NOT NULL CHECK (access IN ('licensed','no_access','unknown')),
     metric TEXT NOT NULL, value REAL, availability TEXT NOT NULL
       CHECK (availability IN ('reported','not_reported','not_applicable')));
   CREATE TABLE ai_examples (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, project_id TEXT, deliverable_id TEXT,
     task TEXT NOT NULL, tool TEXT NOT NULL, why TEXT, contribution TEXT, verification TEXT NOT NULL,
     risk_handling TEXT, outcome TEXT, time_saved_estimate TEXT, estimate_basis TEXT,
     linked_plan_item_id TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL);`,

  // ---- 007 notifications ----------------------------------------------------
  `CREATE TABLE notification_outbox (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, dedupe_key TEXT NOT NULL,
     event TEXT NOT NULL, recipient_id TEXT NOT NULL, to_email TEXT NOT NULL,
     subject TEXT NOT NULL, body TEXT NOT NULL, link TEXT NOT NULL,
     task_ref TEXT NOT NULL, scheduled_for TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('test','live')),
     status TEXT NOT NULL CHECK (status IN ('preview','queued','sent','failed','suppressed')),
     attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, sent_at TEXT, created_at TEXT NOT NULL,
     UNIQUE(tenant_id, dedupe_key));
   CREATE TABLE settings (tenant_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
     PRIMARY KEY(tenant_id, key));`,

  // ---- 008 AI seat attribution (shared seats ≠ people) ----------------------
  `CREATE TABLE ai_seat_attributions (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, tool TEXT NOT NULL, seat_email TEXT NOT NULL,
     engagement TEXT, user_id TEXT REFERENCES users(id), candidate_name TEXT NOT NULL,
     evidence_type TEXT NOT NULL, evidence_detail TEXT, confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
     status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','confirmed','rejected')),
     confirmed_by TEXT, confirmed_at TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL);`,

  // ---- 009 split reviews: per-category reviewers and invited inputs --------
  `CREATE TABLE plan_category_reviewers (
     plan_id TEXT NOT NULL REFERENCES plans(id), category TEXT NOT NULL CHECK (category IN ('objective','competency','initiative')),
     user_id TEXT NOT NULL REFERENCES users(id), assigned_by TEXT NOT NULL, assigned_at TEXT NOT NULL, PRIMARY KEY (plan_id, category));
   CREATE TABLE plan_input_invites (
     id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), invitee_id TEXT NOT NULL REFERENCES users(id),
     label TEXT NOT NULL, invited_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(plan_id, invitee_id));
   CREATE TABLE plan_inputs (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES plans(id), author_id TEXT NOT NULL,
     label TEXT NOT NULL, body TEXT NOT NULL, evidence_url TEXT, created_at TEXT NOT NULL);`,

  // ---- 010 HR profiles (restricted: the person, People Ops/admin and partners) --
  `CREATE TABLE employee_profiles (
     user_id TEXT PRIMARY KEY REFERENCES users(id), tenant_id TEXT NOT NULL,
     level TEXT, date_of_birth TEXT, age_recorded INTEGER, age_recorded_on TEXT,
     probation_status TEXT, contract_status TEXT,
     social_security_status TEXT, medical_insurance_status TEXT, gym_stipend_status TEXT,
     projects_summary TEXT, proposals_summary TEXT, gaps TEXT,
     source TEXT, updated_by TEXT, updated_at TEXT NOT NULL);
   -- why these reviewers were chosen (from the reviewer matrix) and whether partners confirmed it
   CREATE TABLE plan_reviewer_notes (
     plan_id TEXT PRIMARY KEY REFERENCES plans(id), tenant_id TEXT NOT NULL,
     rationale TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','change_requested')),
     source TEXT, confirmed_by TEXT, confirmed_at TEXT, updated_at TEXT NOT NULL);`,
];

export function openDb(file = process.env.DB_FILE || 'data/prism-people.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  MIGRATIONS.forEach((sql, i) => {
    const v = i + 1;
    if (done.has(v)) return;
    tx(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(v, new Date().toISOString());
    });
  });
}

/** Run fn inside a transaction (IMMEDIATE so concurrent writers serialize). */
export function tx(db, fn) {
  if (db.__inTx) return fn();
  db.exec('BEGIN IMMEDIATE');
  db.__inTx = true;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.__inTx = false;
  }
}

export const uid = (p = '') => p + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
export const now = () => new Date().toISOString();
export const J = (v) => JSON.stringify(v ?? null);
export const P = (s, d = null) => (s == null ? d : JSON.parse(s));

export function audit(db, { tenantId, actorId, action, entity, entityId, reason, before, after }) {
  db.prepare(`INSERT INTO audit_events (tenant_id, actor_id, action, entity, entity_id, reason, before_json, after_json, at)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(tenantId, actorId ?? null, action, entity, entityId ?? null,
    reason ?? null, before === undefined ? null : J(before), after === undefined ? null : J(after), now());
}

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}
export const forbid = (m = 'Not permitted') => new AppError(403, 'forbidden', m);
export const notFound = (m = 'Not found') => new AppError(404, 'not_found', m);
export const bad = (m, details) => new AppError(400, 'invalid', m, details);
export const conflict = (m, details) => new AppError(409, 'conflict', m, details);
