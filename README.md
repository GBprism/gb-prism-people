# GB Prism — People & Performance

A private workspace where GB Advisory runs the 2026 year-end review and requests time off and off-site work.
GB Advisory is the first client; the code is built to be folded into GB Prism once the Prism repository is available.

> **Private data:** real rosters, decisions, exports and audits live only in git-ignored folders (`config/private/`, `private-extracts/`, `data/`). Never commit them.

> **Status:** feature-complete for development and pilot on **synthetic data**.
> Live use is gated on the GB decisions in [`docs/DECISIONS.md`](docs/DECISIONS.md) and on wiring Prism sign-in.

## What it does

| Area | Highlights |
|---|---|
| Home | My next action · My performance · My time off (balances, off-site quota) · Request time off |
| Performance | Draft plan → Approved plan → Self-assessment → Manager review → Partner calibration → Released → Acknowledged → Closed. Returns with reasons, audited reopen, plan revisions and amendments, check-ins, clarifications, project-lead feedback scoped to one assignment, development actions, 2027 plans with deliberate carry-forward |
| Scoring | Category = Σ rating × normalised item weight; overall = Σ category × category weight. Validates weights, leaves missing items unscored, approved N/A with visible redistribution, GB bands (4.5 / 4.0 / 3.0 / 2.0) applied once, "show the math" |
| Time off & off-site | Working-day breakdown (Sun–Thu week, holiday calendars, half days, cross-year), notice / retroactive exceptions, overlap and project-coverage checks, approver + backup, no self-approval, append-only ledger with reservations vs postings, idempotent approval/cancel, carryover cap + expiry, separate monthly off-site quota, availability-only team calendar |
| Imports | GB 2026 evaluation forms (formula audit, placeholder + template-sample detection), PMS plans (one row per item), 2025 team summary, LeaveBoard General Situation / Annual Situation / Attendance / Leaves. Preview → apply → reverse; fingerprints; payroll and personal columns excluded |
| Projects | Register for engagements, proposals, initiatives, methods; deliverables; several contributions per deliverable; one-click lead confirm/correct; provisional allocations kept out of the confirmed record |
| AI | Adoption view (Gemini / Claude exports, zero vs not-reported vs no-access, denominators, windows) kept separate from performance; shared-seat attribution as candidates the person confirms; private AI examples linked only to the employee's own objectives |
| Reminders | Launch, 3 business days before due, 1 after; Amman time; test-inbox mode; permission-checked links; no ratings; dedupe, retry, suppression after completion |
| Admin | Roster (effective-dated), aliases, policy versions + GB approval, import center, completion dashboard (no ratings), reminders and outbox, AI adoption, audit log |

## Run it

Requires Node ≥ 22.13 (uses built-in `node:sqlite`).

```bash
npm install
```

```bash
npm run dev          # http://localhost:3000 — synthetic accounts, pick one to sign in
```

```bash
npm run check        # syntax, migrations, no private files tracked, full test suite
```

```bash
npm run demo         # prints a synthetic end-to-end walkthrough
```

Optional acceptance run against the real LeaveBoard export (never committed):

```bash
LEAVEBOARD_DIR=/path/to/exports npm test
```

### Environment

| Variable | Purpose |
|---|---|
| `DB_FILE` | SQLite path (default `data/prism-people.db`). Migrations run automatically at start. |
| `PORT` | HTTP port (default 3000) |
| `DEV_LOGIN=1` | Synthetic account picker. Refused when `NODE_ENV=production`. |
| `AUTH_MODE=google` + `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAIN=gb-advisory.com`, `GOOGLE_TENANT=gb-advisory` | Google Workspace sign-in (chosen by GB). Redirect URI: `${BASE_URL}/auth/google/callback` |
| `AUTH_MODE=trusted-header` | Behind the Prism gateway: identity from `X-Prism-User-Email` + `X-Prism-Tenant`, accepted only with `X-Prism-Gateway-Secret` = `PRISM_GATEWAY_SECRET` |
| `SESSION_SECRET` | Required in production |
| `BASE_URL` | Used in reminder links |
| `OUTBOX_DIR` | Dev mail transport writes `.eml` files here |

### Google Workspace sign-in (one-time, by a Google Workspace admin)

1. Google Cloud console → APIs & Services → **OAuth consent screen**: User type **Internal** (only gb-advisory.com accounts).
2. **Credentials → Create OAuth client ID** → Web application. Authorised redirect URI: `https://<your-prism-host>/auth/google/callback`.
3. Put the client ID/secret in the server environment (never in git) with `AUTH_MODE=google`, `GOOGLE_ALLOWED_DOMAIN=gb-advisory.com`, `BASE_URL=https://<your-prism-host>`, `SESSION_SECRET=<random>`.

### First GB setup (after sign-off)

```bash
node scripts/setup-gb.js --roster roster.csv --decisions config/private/gb-decisions.json
```

Then, in **Admin → Import center**: upload the 2026 forms, the LeaveBoard exports and (optionally) the 2025 team summary; review each preview; apply; post opening balances at the agreed cutover; reconcile.

## Architecture

```
src/
  db.js                  schema + migrations (tenant_id on every table), tx(), audit()
  domain/authz.js        record-level access: self / reviewer / partner / granted / project lead
  domain/scoring.js      weighted scoring, N/A, precision, bands, math
  domain/performance.js  state machine with server-side guards and optimistic locking
  domain/leave.js        working days, ledger, requests, approvals, carryover, calendar
  domain/projects.js     register, assignments, deliverables, contributions
  domain/ai.js           adoption exports, seat attribution, AI examples
  domain/notifications.js reminders, outbox, delivery
  imports/               xlsx reader, batches, LeaveBoard, PMS, GB forms
  http/                  router, sessions, API
public/                  no-build client (ES modules, CSP-safe)
config/                  GB role templates derived from the 2026 forms (role content only)
test/                    node:test suites
```

Security model in brief: every query is scoped by `tenant_id`; record access is decided server-side in `authz.js`; People Ops/admin rights cover roster, balances and imports but **not** review content unless a partner grants it; leave reasons, AI examples, draft reviews and calibration notes are private to the people listed in `authz.js`; every approval, edit, release, import, reversal and balance adjustment writes an audit event. CSP forbids inline script and style; CSV exports are guarded against formula injection.

## Integrating with GB Prism

The Prism repository was not available to this build. To merge:

1. Replace `src/http/router.js` sessions with Prism auth, or run behind the Prism gateway in `trusted-header` mode.
2. Map `tenants` to the Prism workspace model; keep `tenant_id` filters.
3. Swap the CSS tokens at the top of `public/app.css` for Prism tokens, and mount the screens under Prism navigation.
4. Point `notifications.deliver()` at the Prism mailer (the transport is a single function).
5. Move migrations into Prism's migration tool (they are plain SQL in `src/db.js`).

See [`docs/VERIFICATION.md`](docs/VERIFICATION.md) for how each acceptance check is demonstrated, and [`docs/IMPORT_FORMATS.md`](docs/IMPORT_FORMATS.md) for the import formats.
