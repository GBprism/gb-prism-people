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
  // ---- 011 removed project assignments: kept whole so a mistaken removal can be restored --
  `CREATE TABLE assignment_removals (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, assignment_json TEXT NOT NULL,
     reason TEXT NOT NULL, removed_by TEXT NOT NULL, removed_at TEXT NOT NULL,
     restored_by TEXT, restored_at TEXT);
   CREATE INDEX assignment_removals_project ON assignment_removals(project_id);`,
  // ---- 012 more HR profile facts from the GB team sheets --
  `ALTER TABLE employee_profiles ADD COLUMN leave_history TEXT;
   ALTER TABLE employee_profiles ADD COLUMN equipment TEXT;
   ALTER TABLE employee_profiles ADD COLUMN learning_notes TEXT;`,
  // ---- 013 'client' leave-type category (GB: "At client" days are their own category, outside the off-site quota).
  // SQLite cannot alter a CHECK constraint, so the table is rebuilt with the same ids, following SQLite's
  // documented procedure: foreign keys off around the transaction, then foreign_key_check before commit.
  { fkOff: true, sql: `CREATE TABLE leave_types_v13 (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
     category TEXT NOT NULL CHECK (category IN ('leave','offsite','overtime','client')),
     unit TEXT NOT NULL DEFAULT 'day', tracks_balance INTEGER NOT NULL DEFAULT 1,
     allow_partial INTEGER NOT NULL DEFAULT 1, requires_cover INTEGER NOT NULL DEFAULT 0,
     reason_required INTEGER NOT NULL DEFAULT 0, vendor_label TEXT, active INTEGER NOT NULL DEFAULT 1,
     UNIQUE(tenant_id, code));
   INSERT INTO leave_types_v13 SELECT id, tenant_id, code, name, category, unit, tracks_balance, allow_partial, requires_cover, reason_required, vendor_label, active FROM leave_types;
   DROP TABLE leave_types;
   ALTER TABLE leave_types_v13 RENAME TO leave_types;
   INSERT OR IGNORE INTO leave_types (id, tenant_id, code, name, category, tracks_balance, requires_cover)
     SELECT 'lt_' || id || '_AC', id, 'AC', 'At client', 'client', 0, 0 FROM tenants WHERE id = 'gb-advisory';` },
  // ---- 014 company-profile facts (shown to colleagues), photos, and GB service lines on projects --
  `ALTER TABLE employee_profiles ADD COLUMN public_title TEXT;
   ALTER TABLE employee_profiles ADD COLUMN years_experience TEXT;
   ALTER TABLE employee_profiles ADD COLUMN expertise TEXT;
   ALTER TABLE employee_profiles ADD COLUMN education TEXT;
   ALTER TABLE employee_profiles ADD COLUMN certifications TEXT;
   ALTER TABLE employee_profiles ADD COLUMN bio TEXT;
   ALTER TABLE employee_profiles ADD COLUMN industries TEXT;
   ALTER TABLE employee_profiles ADD COLUMN functions TEXT;
   ALTER TABLE employee_profiles ADD COLUMN cv_projects TEXT;
   CREATE TABLE user_photos (
     user_id TEXT PRIMARY KEY REFERENCES users(id), tenant_id TEXT NOT NULL, mime TEXT NOT NULL,
     data BLOB NOT NULL, sha256 TEXT NOT NULL, source TEXT, updated_by TEXT, updated_at TEXT NOT NULL);
   ALTER TABLE projects ADD COLUMN service_line TEXT;`,
  // ---- 015 knowledge library (clients, engagements, proposals) and GB strategy KPIs ---------------
  // Visible to every active colleague. No fees, values or contract terms are stored here.
  `CREATE TABLE clients (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, key TEXT NOT NULL, name_en TEXT NOT NULL, name_ar TEXT,
     short TEXT, sector TEXT, country TEXT, drive_url TEXT, notes TEXT, updated_at TEXT,
     UNIQUE(tenant_id, key));
   CREATE TABLE engagements (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, client_id TEXT NOT NULL REFERENCES clients(id), key TEXT NOT NULL,
     title_en TEXT NOT NULL, title_ar TEXT, domain TEXT, service_line TEXT, scope_en TEXT, scope_ar TEXT,
     year_from INTEGER, year_to INTEGER,
     status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('running','completed','on_hold')),
     lead_name TEXT, team_names TEXT, subcontractor TEXT, drive_url TEXT,
     project_id TEXT REFERENCES projects(id), source TEXT, updated_by TEXT, updated_at TEXT,
     UNIQUE(tenant_id, key));
   CREATE TABLE proposals (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, client_id TEXT NOT NULL REFERENCES clients(id), key TEXT NOT NULL,
     title_en TEXT NOT NULL, title_ar TEXT, domain TEXT, submitted_on TEXT,
     outcome TEXT NOT NULL DEFAULT 'submitted' CHECK (outcome IN ('drafting','submitted','won','lost','withdrawn','no_go')),
     decided_on TEXT, outcome_note TEXT, owner_name TEXT, drive_url TEXT,
     engagement_id TEXT REFERENCES engagements(id), source TEXT, updated_by TEXT, updated_at TEXT,
     UNIQUE(tenant_id, key));
   CREATE TABLE strategy_objectives (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, code TEXT NOT NULL, theme TEXT NOT NULL,
     title_en TEXT NOT NULL, title_ar TEXT, position INTEGER NOT NULL DEFAULT 0, UNIQUE(tenant_id, code));
   CREATE TABLE strategy_kpis (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, code TEXT NOT NULL, name_en TEXT NOT NULL, name_ar TEXT,
     objective_codes TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, UNIQUE(tenant_id, code));
   CREATE TABLE plan_item_kpi_links (
     plan_item_id TEXT NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE, kpi_id TEXT NOT NULL REFERENCES strategy_kpis(id),
     tenant_id TEXT NOT NULL, linked_by TEXT, linked_at TEXT NOT NULL, PRIMARY KEY (plan_item_id, kpi_id));
   CREATE INDEX engagements_client ON engagements(client_id);
   CREATE INDEX proposals_client ON proposals(client_id);`,
  // ---- 016 workplace: expenses, timesheets, letters, checklists, policies, onboarding, brand, CV updates
  `CREATE TABLE files (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT REFERENCES users(id), purpose TEXT NOT NULL,
     filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE expense_claims (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
     period_from TEXT, period_to TEXT, currency TEXT NOT NULL DEFAULT 'JOD',
     status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','paid')),
     total_x100 INTEGER NOT NULL DEFAULT 0, submitted_at TEXT, approver_id TEXT REFERENCES users(id),
     decided_by TEXT, decided_at TEXT, decision_note TEXT, paid_by TEXT, paid_at TEXT, created_at TEXT NOT NULL);
   CREATE TABLE expense_lines (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, claim_id TEXT NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
     spent_on TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL, project_id TEXT REFERENCES projects(id),
     project_text TEXT, chargeable INTEGER NOT NULL DEFAULT 0, receipt_amount_x100 INTEGER NOT NULL CHECK (receipt_amount_x100 > 0),
     receipt_currency TEXT NOT NULL, fx_rate TEXT NOT NULL DEFAULT '1', amount_x100 INTEGER NOT NULL CHECK (amount_x100 > 0),
     receipt_file_id TEXT REFERENCES files(id), position INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE timesheet_entries (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), month TEXT NOT NULL,
     work_date TEXT NOT NULL, code TEXT NOT NULL, project_id TEXT REFERENCES projects(id), hours_x100 INTEGER NOT NULL CHECK (hours_x100 >= 0),
     source TEXT NOT NULL DEFAULT 'manual', UNIQUE(user_id, work_date, code));
   CREATE TABLE timesheet_months (
     user_id TEXT NOT NULL REFERENCES users(id), month TEXT NOT NULL, tenant_id TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','approved','returned')),
     submitted_at TEXT, decided_by TEXT, decided_at TEXT, note TEXT, PRIMARY KEY (user_id, month));
   CREATE TABLE letter_templates (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, title_ar TEXT, language TEXT,
     fields_json TEXT NOT NULL DEFAULT '[]', body TEXT NOT NULL, signatory TEXT, has_compensation INTEGER NOT NULL DEFAULT 0,
     source_url TEXT, active INTEGER NOT NULL DEFAULT 1, UNIQUE(tenant_id, key));
   CREATE TABLE letter_requests (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), template_key TEXT,
     kind TEXT NOT NULL, addressee TEXT, purpose TEXT, language TEXT NOT NULL DEFAULT 'en', needed_by TEXT,
     status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','issued','rejected','cancelled')),
     decided_by TEXT, decided_at TEXT, note TEXT, issued_fields_json TEXT, created_at TEXT NOT NULL);
   CREATE TABLE checklists (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('general','specific')),
     deliverable_type TEXT, title TEXT NOT NULL, title_ar TEXT, items_json TEXT NOT NULL, source_name TEXT, source_url TEXT,
     position INTEGER NOT NULL DEFAULT 0, UNIQUE(tenant_id, key));
   CREATE TABLE deliverable_checks (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
     user_id TEXT NOT NULL REFERENCES users(id), checklist_keys TEXT NOT NULL, items_checked INTEGER NOT NULL,
     note TEXT, drive_url TEXT, confirmed_at TEXT NOT NULL);
   ALTER TABLE deliverables ADD COLUMN deliverable_type TEXT;
   ALTER TABLE deliverables ADD COLUMN submitted_by TEXT;
   ALTER TABLE deliverables ADD COLUMN submitted_at TEXT;
   CREATE TABLE policies (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, key TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, title_ar TEXT,
     version TEXT, effective TEXT, summary TEXT, rules_json TEXT NOT NULL DEFAULT '[]', applies_to TEXT, source_url TEXT,
     requires_ack INTEGER NOT NULL DEFAULT 1, UNIQUE(tenant_id, key));
   CREATE TABLE policy_acks (
     policy_id TEXT NOT NULL REFERENCES policies(id), user_id TEXT NOT NULL REFERENCES users(id), version TEXT,
     acked_at TEXT NOT NULL, PRIMARY KEY (policy_id, user_id));
   CREATE TABLE onboarding_items (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, title_ar TEXT, purpose TEXT,
     stage TEXT NOT NULL, owner TEXT NOT NULL, action TEXT NOT NULL, source_url TEXT, position INTEGER NOT NULL DEFAULT 0,
     UNIQUE(tenant_id, key));
   CREATE TABLE onboarding_progress (
     user_id TEXT NOT NULL REFERENCES users(id), item_id TEXT NOT NULL REFERENCES onboarding_items(id), tenant_id TEXT NOT NULL,
     done_by TEXT, done_at TEXT NOT NULL, PRIMARY KEY (user_id, item_id));
   CREATE TABLE brand_files (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, file_id TEXT NOT NULL REFERENCES files(id), label TEXT NOT NULL,
     variant TEXT, orientation TEXT, position INTEGER NOT NULL DEFAULT 0, UNIQUE(tenant_id, label));
   CREATE TABLE cv_updates (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), fields_json TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected')),
     decided_by TEXT, decided_at TEXT, note TEXT, created_at TEXT NOT NULL);
   ALTER TABLE employee_profiles ADD COLUMN languages TEXT;
   ALTER TABLE employee_profiles ADD COLUMN linkedin TEXT;
   ALTER TABLE projects ADD COLUMN chat_url TEXT;
   ALTER TABLE projects ADD COLUMN meet_url TEXT;
   CREATE INDEX timesheet_user_month ON timesheet_entries(user_id, month);
   CREATE INDEX expense_lines_claim ON expense_lines(claim_id);`,
  // ---- 017 office running costs and company documents (licences and other government papers) ------
  `CREATE TABLE office_expenses (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, spent_on TEXT NOT NULL, month TEXT NOT NULL, category TEXT NOT NULL,
     vendor TEXT, description TEXT, amount_x100 INTEGER NOT NULL CHECK (amount_x100 > 0), currency TEXT NOT NULL DEFAULT 'JOD',
     paid_by TEXT NOT NULL DEFAULT 'company', receipt_file_id TEXT REFERENCES files(id), entered_by TEXT NOT NULL REFERENCES users(id),
     created_at TEXT NOT NULL, updated_at TEXT);
   CREATE INDEX office_expenses_month ON office_expenses(tenant_id, month);
   CREATE TABLE company_documents (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, number TEXT, issuer TEXT,
     issued_on TEXT, expires_on TEXT, renewal_owner_id TEXT REFERENCES users(id), notes TEXT, file_id TEXT REFERENCES files(id),
     drive_url TEXT, archived INTEGER NOT NULL DEFAULT 0, updated_by TEXT, updated_at TEXT NOT NULL);`,
  // ---- 018 two-step leave approval (project manager, then GB's approver), messages, gym allowance, user prefs --
  `ALTER TABLE leave_requests ADD COLUMN stage TEXT NOT NULL DEFAULT 'final';
   ALTER TABLE leave_requests ADD COLUMN pm_id TEXT REFERENCES users(id);
   ALTER TABLE leave_requests ADD COLUMN pm_project_id TEXT REFERENCES projects(id);
   ALTER TABLE leave_requests ADD COLUMN pm_decided_by TEXT;
   ALTER TABLE leave_requests ADD COLUMN pm_decided_at TEXT;
   ALTER TABLE leave_requests ADD COLUMN pm_note TEXT;
   CREATE TABLE conversations (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT, kind TEXT NOT NULL CHECK (kind IN ('direct','group')),
     direct_key TEXT, project_id TEXT REFERENCES projects(id), created_by TEXT NOT NULL, created_at TEXT NOT NULL, last_at TEXT NOT NULL,
     UNIQUE(tenant_id, direct_key));
   CREATE TABLE conversation_members (
     conversation_id TEXT NOT NULL REFERENCES conversations(id), user_id TEXT NOT NULL REFERENCES users(id),
     last_read_at TEXT, joined_at TEXT NOT NULL, PRIMARY KEY (conversation_id, user_id));
   CREATE TABLE messages (
     id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), sender_id TEXT NOT NULL REFERENCES users(id),
     body TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE INDEX messages_conv ON messages(conversation_id, created_at);
   CREATE TABLE gym_claims (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), gym_name TEXT NOT NULL,
     valid_from TEXT NOT NULL, valid_to TEXT NOT NULL, file_id TEXT NOT NULL REFERENCES files(id),
     status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
     decided_by TEXT, decided_at TEXT, note TEXT, created_at TEXT NOT NULL);
   CREATE TABLE user_prefs (user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY (user_id, key));`,
  // ---- 019 Claude accounts: which seats are active and who works on each, on what ----------------------
  `CREATE TABLE claude_accounts (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, seat_email TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'Team',
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')), monthly_limit TEXT, notes TEXT,
     updated_by TEXT, updated_at TEXT NOT NULL, UNIQUE(tenant_id, seat_email));
   CREATE TABLE claude_account_users (
     account_id TEXT NOT NULL REFERENCES claude_accounts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id),
     project_id TEXT REFERENCES projects(id), working_on TEXT, since TEXT, PRIMARY KEY (account_id, user_id));`,
  // ---- 020 commercial control, staffing, pipeline, surveys, offboarding, training, close-outs ---------
  `CREATE TABLE project_budgets (
     project_id TEXT PRIMARY KEY REFERENCES projects(id), tenant_id TEXT NOT NULL,
     billing TEXT NOT NULL DEFAULT 'fixed' CHECK (billing IN ('fixed','time_materials')), currency TEXT NOT NULL DEFAULT 'JOD',
     fee_x100 INTEGER NOT NULL DEFAULT 0, budget_hours_x100 INTEGER NOT NULL DEFAULT 0, rate_x100 INTEGER,
     notes TEXT, last_alert INTEGER NOT NULL DEFAULT 0, updated_by TEXT, updated_at TEXT NOT NULL);
   CREATE TABLE project_milestones (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
     due_on TEXT, amount_x100 INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','invoiced','paid','cancelled')),
     invoice_no TEXT, invoiced_on TEXT, paid_on TEXT, position INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
   CREATE TABLE cost_rates (
     tenant_id TEXT NOT NULL, level TEXT NOT NULL, hourly_x100 INTEGER NOT NULL, target_pct INTEGER, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, level));
   ALTER TABLE project_assignments ADD COLUMN allocation_pct INTEGER;
   CREATE TABLE resource_bookings (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT REFERENCES projects(id),
     proposal_id TEXT REFERENCES proposals(id), label TEXT, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
     pct INTEGER NOT NULL CHECK (pct BETWEEN 5 AND 100), status TEXT NOT NULL DEFAULT 'tentative' CHECK (status IN ('tentative','confirmed')),
     created_by TEXT, created_at TEXT NOT NULL);
   ALTER TABLE proposals ADD COLUMN stage TEXT;
   ALTER TABLE proposals ADD COLUMN value_x100 INTEGER;
   ALTER TABLE proposals ADD COLUMN currency TEXT;
   ALTER TABLE proposals ADD COLUMN probability INTEGER;
   ALTER TABLE proposals ADD COLUMN owner_user_id TEXT REFERENCES users(id);
   ALTER TABLE proposals ADD COLUMN next_step TEXT;
   ALTER TABLE proposals ADD COLUMN next_step_on TEXT;
   ALTER TABLE proposals ADD COLUMN expected_close TEXT;
   ALTER TABLE proposals ADD COLUMN expected_start TEXT;
   ALTER TABLE proposals ADD COLUMN contact_id TEXT;
   ALTER TABLE proposals ADD COLUMN lost_reason TEXT;
   CREATE TABLE client_contacts (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, client_id TEXT NOT NULL REFERENCES clients(id), name TEXT NOT NULL, role TEXT,
     email TEXT, phone TEXT, notes TEXT, last_contact_on TEXT, updated_at TEXT NOT NULL);
   CREATE TABLE surveys (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('client','pulse')), title TEXT NOT NULL,
     project_id TEXT REFERENCES projects(id), engagement_id TEXT REFERENCES engagements(id), contact_name TEXT, contact_email TEXT,
     token_hash TEXT, opens_on TEXT NOT NULL, closes_on TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
     created_by TEXT, created_at TEXT NOT NULL);
   CREATE TABLE survey_responses (
     id TEXT PRIMARY KEY, survey_id TEXT NOT NULL REFERENCES surveys(id), answers_json TEXT NOT NULL, comment TEXT, created_at TEXT NOT NULL);
   CREATE TABLE survey_participation (
     survey_id TEXT NOT NULL REFERENCES surveys(id), user_id TEXT NOT NULL REFERENCES users(id), answered_at TEXT NOT NULL, PRIMARY KEY (survey_id, user_id));
   CREATE TABLE offboardings (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), last_day TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'resignation', status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
     started_by TEXT, started_at TEXT NOT NULL, completed_at TEXT);
   CREATE TABLE offboarding_steps (
     id TEXT PRIMARY KEY, offboarding_id TEXT NOT NULL REFERENCES offboardings(id), key TEXT NOT NULL, title TEXT NOT NULL, owner TEXT NOT NULL,
     position INTEGER NOT NULL, done_by TEXT, done_at TEXT, note TEXT);
   CREATE TABLE trainings (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, provider TEXT,
     kind TEXT NOT NULL CHECK (kind IN ('course','certification','workshop','conference','self_study')), start_on TEXT, end_on TEXT,
     hours_x100 INTEGER NOT NULL DEFAULT 0, expires_on TEXT, file_id TEXT REFERENCES files(id), verified_by TEXT, verified_at TEXT, created_at TEXT NOT NULL);
   CREATE TABLE closeouts (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, engagement_id TEXT REFERENCES engagements(id), project_id TEXT REFERENCES projects(id),
     went_well TEXT, to_improve TEXT, client_feedback TEXT, tags TEXT, submitted_by TEXT NOT NULL, submitted_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE reusable_assets (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, closeout_id TEXT REFERENCES closeouts(id), title TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('template','tool','framework','model','training','other')), service_line TEXT, drive_url TEXT NOT NULL,
     description TEXT, added_by TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE INDEX bookings_user ON resource_bookings(user_id, start_date);
   CREATE INDEX trainings_user ON trainings(user_id);`,

  // ---- 021 employees propose changes to their own projects; the lead (or a partner) approves --------
  `CREATE TABLE assignment_requests (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT NOT NULL REFERENCES projects(id),
     assignment_id TEXT REFERENCES project_assignments(id), kind TEXT NOT NULL CHECK (kind IN ('join','leave','role')),
     role TEXT, start_date TEXT, end_date TEXT, note TEXT,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','withdrawn')),
     decided_by TEXT, decided_at TEXT, decision_note TEXT, created_at TEXT NOT NULL);
   CREATE INDEX assignment_requests_open ON assignment_requests(tenant_id, status);`,
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
  MIGRATIONS.forEach((m, i) => {
    const v = i + 1;
    if (done.has(v)) return;
    const { sql, fkOff } = typeof m === 'string' ? { sql: m, fkOff: false } : m;
    if (fkOff) db.exec('PRAGMA foreign_keys = OFF'); // must be set outside a transaction
    try {
      tx(db, () => {
        db.exec(sql);
        if (fkOff) { const bad = db.prepare('PRAGMA foreign_key_check').all(); if (bad.length) throw new Error(`migration ${v}: ${bad.length} foreign key problem(s)`); }
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(v, new Date().toISOString());
      });
    } finally { if (fkOff) db.exec('PRAGMA foreign_keys = ON'); }
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
