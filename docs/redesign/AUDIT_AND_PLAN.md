# Prism redesign: audit, brand and plan (phase 0)

## 1. Audit of the current app

**Stack.** A no-build single-page app: `public/index.html`, `public/app.js` (513 lines, ES modules, DOM built with a tiny `h()` helper), `public/app.css` (59 lines). Server: Node `http` with a strict CSP (`default-src 'self'`, so there are no external fonts, scripts or inline styles). There is no Tailwind, no UI kit, no icon set, no web font (`system-ui`), and no Arabic/RTL support today. TypeScript and lint don't exist; the quality gate is `npm run check` (syntax, migrations, private-file guard, 48 node:test tests).

**Where styling lives.** The tokens in `:root` of `public/app.css` cover 13 colours, radius and gap, with a dark-mode override. Components are styled by a handful of global classes (`.card`, `.btn`, `.pill`, `.item`, `.side`, `.tabs`, `.alert`, `.math`, `.chips`). There are no inline styles (CSP-clean).

**Routes (hash router in `app.js`).**

| Route | Screen | Who |
|---|---|---|
| `#/` | Home (next action, performance, time off, request) or Sign-in if signed out | everyone |
| `#/inbox` | Team inbox (reviews, calibrations, requests, feedback, contributions, clarifications) and team progress | reviewers, partners, approvers, leads |
| `#/review/:id` | Review: self-assessment, manager review, calibration, released result, development actions, draft plan editor; also the project-lead and invited-input views | role-dependent |
| `#/timeoff` | New request form with live preview, my requests, team availability | everyone |
| `#/request/:id` | Leave request decision | approvers |
| `#/history` | My reviews and "start next year's plan" | everyone |
| `#/projects` | Project register, deliverables, contribution claims and confirmation | project members and leads |
| `#/ai` | Seat attribution confirmations and AI examples | everyone |
| `#/admin/dashboard` | Completion | People Ops/admin |
| `#/admin/roster` | Roster | People Ops/admin |
| `#/admin/imports` | Import center (upload → preview → apply → reverse, opening balances, reconcile) | People Ops/admin |
| `#/admin/policy` | Policy versions and GB approval | People Ops/admin |
| `#/admin/reminders` | Reminder preview/queue/deliver and outbox | People Ops/admin |
| `#/admin/ai` | AI adoption | People Ops/admin |
| `#/admin/audit` | Audit log | People Ops/admin |

**Shell.** A top bar with text links, a centred max-1100px column, no sidebar, no breadcrumbs, no search, and no icons.

**What the "before" screenshots show** (`docs/redesign/before/`, 17 screens × 1440px and 390px):
- Content is a centred narrow column, so 30–50% of a 1440px screen is empty canvas (Home, Imports, Admin).
- Home cards are equal-height boxes with large empty areas. There are no key numbers and no "what needs attention" list.
- Import center:
  - one generic form whose fields depend on the source;
  - a native file input;
  - the **target cycle defaults to "2027 plan"** instead of the open 2026 cycle;
  - results appear below as a raw table;
  - no steps.
- The review page is one very long scroll (about 7,000px at 1440) with no section navigation.
- Statuses are text pills only. There are no icons anywhere.
- Mobile works without horizontal scroll, but the nav wraps and actions sit at the bottom of long pages.

## 2. Brand (taken from gb-advisory.com, not guessed)

| Use | Hex | Source |
|---|---|---|
| Sky/cyan accent (logo underline, site accent) | **#4AB6DB** | site HTML (used 6×), white logo bar `#4AB6DA` |
| Light cyan (header-logo bar) | #67B3D2 | header logo pixels |
| Mid blue (chevron) | **#2E80B2** | white logo chevron (`#4680AA` in the header logo) |
| Navy (darkest chevron facet) | **#1E4278** | header logo pixels |
| Site ink / dark | **#1C2833** | WordPress theme colour `theme-black` |
| Site font | **Poppins** | site CSS |
| Not used | #E36D60 (coral) | a WordPress theme preset, not visible in the brand |

Logos:
- Both logo files on the website have **white lettering** (dark backgrounds only).
- The dark-lettering logo you sent in chat must be supplied as a file (SVG or large transparent PNG). It is needed for a white sidebar, the sign-in page and favicons.

Contrast (WCAG):

| Pair | Ratio | Result |
|---|---|---|
| White on navy #1E4278 | 9.97 | ✅ |
| White on #1C2833 | 15.0 | ✅ |
| White on mid blue #2E80B2 | 4.33 | ❌ below AA for body text (OK only for ≥18.7px bold) |
| White on cyan #4AB6DB | 2.33 | ❌ |
| Cyan #4AB6DB on white | 2.33 | ❌ not even for focus rings |
| Cyan #4AB6DB on #1C2833 | 6.43 | ✅ fine as an accent on a dark sidebar |

**Proposed roles**
- **Primary** (buttons, links, focus ring): navy **#1E4278**.
- **Accent**: cyan **#4AB6DB**, as decoration only (active-nav indicator bar, the logo bar, charts), never as text or a text background on white.
- **Mid blue #2E80B2**: icons and secondary emphasis.
- **Sidebar**, two options to show you in phase 1:
  - (A) dark #1C2833 with the white logo;
  - (B) white with the dark logo (needs your file).

**Fonts.** Your brief says Inter, but the site uses Poppins. My proposal: **Inter** for UI text and tables (denser, tabular numerals) and **Poppins 600** for page titles and the sign-in panel, to tie the app to the site. Both are self-hosted, because the CSP blocks Google Fonts.

## 3. Things in the brief that don't apply as written

| Brief item | Situation here | Plan |
|---|---|---|
| Tailwind / CSS modules | Neither is used. One token file is simpler | CSS custom properties in `public/tokens.css`; components use only tokens |
| Typecheck / lint | No TypeScript or linter | Keep `npm run check`; add Playwright smoke tests for the shell and the import flow |
| Arabic/RTL | No Arabic today | Use logical CSS properties throughout so RTL is cheap later. Should Arabic be in scope? |
| Lucide icons | No icon set | Vendor the Lucide SVGs we use (ISC licence) into an inline sprite; no CDN |
| Imports "Map columns" | Prism's sources are fixed formats (GB forms, LeaveBoard, PMS) matched by known headers | The step shows the auto-detected format and matches people; it only asks when something is ambiguous (for example the cycle or a reporting range) |

## 4. Proposed, not built (each needs a logic or API change, so I'm asking first)

1. **Editing rejected import rows inline.** Today the source is fixed and re-uploaded, which keeps the audit trail clean. Inline edits would change imported data, so they need an "edited in Prism" provenance flag.
2. **"Import valid rows only".** This is already how apply works: rejected rows are skipped. Only the label changes, so no logic change is needed.
3. **A real-time import progress bar.** Apply runs in one transaction and takes under a second. I'll show a short progress state and the result card. A true progress bar would need a background job.
4. **Notifications bell with unread state.** Needs a per-user notification feed endpoint. Interim: the bell shows the Team-inbox count from the existing `/api/inbox`.
5. **⌘K search across records.** The palette can cover pages, people and inbox items using existing endpoints. Searching plans or requests by text needs a search endpoint.
6. **Bulk actions** (for example "approve selected plans"). Needs bulk endpoints. Tables get selection UI only where an existing action can loop safely, and I'll list those for approval.

## 5. Plan: one PR per phase, each waiting for your approval before merge

| Phase | Scope | Screens touched |
|---|---|---|
| 1 | `tokens.css` (colour, type, spacing, radius, shadow); Inter and Poppins self-hosted; Lucide sprite; base components (button, input, select, badge with icon, card, stat tile, table, toast, banner, skeleton, empty state, drawer, modal, stepper); a `/styleguide` dev page showing both sidebar options | Style guide only |
| 2 | App shell: grouped left sidebar (Workspace / People / Admin) collapsing to an icon rail; 56px top bar with breadcrumbs, ⌘K palette (pages, people, inbox items), inbox bell, help, avatar menu; mobile drawer; standard page template | All screens get the new frame |
| 3 | Admin → Imports: 4-step stepper. **Upload** has a drop zone, accepted formats, template download and recent imports. **Check format** auto-detects the source and asks only for missing choices; the cycle defaults to the open cycle. **Review & fix** has a summary bar, problem rows first and a download error report. **Import** shows the result card with counts, then the reconcile and opening-balance actions | Imports |
| 4 | Sign-in as a split brand panel; Home with "What needs your attention", stat tiles and recent activity | Sign-in, Home |
| 5 | Remaining screens on the template: Team inbox (table with filters), Review (sticky section nav, side-by-side self vs manager, sticky save bar), Time off (stepper-light form and calendar), Request decision (drawer), My reviews, Projects, AI examples, all Admin tabs | 13 screens |
| 6 | Polish: empty states, skeletons, mobile thumb actions, keyboard and ARIA pass, logical properties for RTL readiness, before/after set and Playwright smoke tests | All |

Every PR includes:
- before/after screenshots at 1440px and 390px for each screen it touches;
- the list of components changed;
- confirmation that routes, API calls, permissions and business logic are unchanged;
- `npm run check` passing.

## 6. What I need from you before phase 1

1. The **dark-lettering logo file** (SVG, or a PNG at least 1,000px wide with a transparent background).
2. OK on the colour roles: navy #1E4278 primary, cyan #4AB6DB accent only.
3. Fonts: Inter for UI with Poppins for headings, or Inter only?
4. Is Arabic/RTL in scope now, or only "ready for later"?
5. OK on the plan and on the "Proposed, not built" list (which of items 1, 4, 5 and 6 you want).
