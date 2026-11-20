# Verification map

Run `npm run check` to execute the full suite (44 tests). Every check below uses synthetic accounts unless noted otherwise.

| Acceptance item | Where it is demonstrated |
|---|---|
| Valid import, formula-error row, safe re-import | `imports.test.js` › PMS plan import; `gbform.test.js` |
| Payroll and personal fields excluded | `imports.test.js` (Salary/Bonus columns); `gbform.test.js` (Age/Salary/Hobby); history import refuses the *Salaries* sheet |
| Imports that would overwrite released or closed reviews are blocked | `imports.test.js` (released plan → rows rejected); `gbform.js` refuses non-draft plans |
| Reversal with audit | `imports.test.js` › reversal |
| Score math for 75/25, 40/40/20 and 50/30/20; missing and N/A | `scoring.test.js` |
| 2025 team-summary math reproduced (1 dp) | `scoring.test.js`, `imports.test.js` › history |
| 2026 review from self-assessment to closed; 2027 plan with carry-forward | `performance.test.js` |
| Returns, reopen, concurrency, N/A approval | `performance.test.js` |
| Time-off request, holiday, weekend, cross-year, half day, overlap | `leave.test.js` |
| Approval idempotent, no self-approval, cancellation and reversal | `leave.test.js` |
| Notice and retroactive exceptions | `leave.test.js` |
| Off-site request with a separate monthly quota and the probation rule | `leave.test.js` |
| Carryover cap and expiry | `leave.test.js` |
| LeaveBoard snapshot covering a carryover, a partial day, a future approval already counted and a pending request; reconcile; repeat without duplicates | `imports.test.js` › cutover |
| General Situation: 13 rows, totals reconciled, footer skipped, decimals kept, **zero ledger entries** | `imports.test.js` (synthetic); the **real file** is checked when `LEAVEBOARD_DIR` is set |
| Shared deliverable with two contributions validated by the lead | `extensions.test.js` |
| A provisional assignment stays out of the confirmed record | `extensions.test.js` |
| Missing or unlicensed AI usage is distinct from zero; changing usage leaves the score unchanged | `extensions.test.js` |
| Reminder sent to the test inbox, retried, suppressed after completion, deduplicated | `extensions.test.js` |
| Peer, unrelated manager, admin without a grant and another workspace are all denied (pages, API, export, inbox, balances, leave reasons, AI examples) | `performance.test.js`, `leave.test.js`, `extensions.test.js`, `http.test.js` |
| UI walkthrough: autosave, submit, mobile width, CSP-clean console | Playwright script used during build (screens: home, review, manager review, time off, admin) |

## What could not be exercised here, and why

| Item | Blocker | Remaining verification |
|---|---|---|
| Prism SSO, navigation and design tokens | Prism repository not available to this session | Wire `AUTH_MODE=trusted-header` or Prism auth; re-run `http.test.js` against the gateway |
| Real email delivery | No mail integration configured (file and test transports only) | Connect the Prism mailer, then send one test-inbox reminder, retry it and confirm suppression |
| Dated LeaveBoard Leaves import | No real *Reports → Leaves* export yet | Confirm the column layout, run preview and reconcile against Annual Situation |
| Gemini and Claude admin exports | Exports not supplied (the Claude data ends 15 June) | Re-export, import, compare windows |
| Year-end and time-off pilots with real people | Needs the decisions listed in `DECISIONS.md` | Pilot with a small cross-role group |
