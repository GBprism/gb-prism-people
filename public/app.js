// GB Prism People & Performance — client. Plain ES modules, no build step.
// All DOM is created with h() (textContent), never innerHTML with data.
import { mountShell, pageFor } from '/shell.js';
import { pageHeader, emptyState, skeletonLines, button as uiButton } from '/ui.js';
import { importsScreen } from '/screens/imports.js';
import { homeScreen } from '/screens/home.js';
import { signInScreen } from '/screens/signin.js';
import { myProfileScreen, peopleScreen } from '/screens/people.js';
import { timeoffScreen, requestScreen } from '/screens/timeoff.js';
import { approvalsScreen, teamReviewsScreen } from '/screens/manager.js';
import { projectScreen } from '/screens/project.js';
import { requestsScreen } from '/screens/requests.js';
import { projectsScreen } from '/screens/projects.js';
import { historyScreen } from '/screens/history.js';
import { reviewScreen } from '/screens/review.js';
import { teamScreen } from '/screens/team.js';
import { libraryScreen } from '/screens/library.js';
import { timesheetScreen } from '/screens/timesheet.js';
import { expensesScreen } from '/screens/expenses.js';
import { lettersScreen } from '/screens/letters.js';
import { companyScreen } from '/screens/company.js';
import { policiesScreen } from '/screens/policies.js';
import { onboardingScreen } from '/screens/onboarding.js';
import { checklistsScreen } from '/screens/checklists.js';
import { officeScreen, documentsScreen } from '/screens/office.js';
import { messagesScreen } from '/screens/messages.js';
import { activeScreen } from '/screens/active.js';
import { claudeScreen } from '/screens/claude.js';
import { reportsScreen } from '/screens/reports.js';
import { commercialScreen } from '/screens/commercial.js';
import { staffingScreen } from '/screens/staffing.js';
import { pipelineScreen } from '/screens/pipeline.js';
import { surveysScreen } from '/screens/surveys.js';
import { offboardingScreen, trainingScreen } from '/screens/lifecycle.js';
import { aiExamplesScreen, adminDashboardScreen, adminRosterScreen, adminPolicyScreen, adminRemindersScreen, adminAiScreen, adminAuditScreen } from '/screens/admin.js';

// ------------------------------------------------------------- helpers --
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(path, { method, headers: { 'X-Requested-With': 'prism', ...(raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined), credentials: 'same-origin' });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  // signed out (session ended after 12 hours, or signed out in another tab): back to the sign-in page
  if (res.status === 401 && ME && !path.startsWith('/api/me')) { ME = null; location.hash = '#/'; location.reload(); return new Promise(() => {}); }
  if (!res.ok) { const e = new Error(data.message || res.statusText); e.status = res.status; e.details = data.details; throw e; }
  return data;
}
const toBase64 = (file) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = fail; r.readAsDataURL(file); });
function errorBox(e) {
  return h('div', { class: 'alert error', role: 'alert' }, h('strong', {}, e.message), e.details?.length ? h('ul', {}, e.details.map((d) => h('li', {}, typeof d === 'string' ? d : d.message || JSON.stringify(d)))) : null);
}

// --------------------------------------------------------------- shell --
let ME = null;
const routes = [
  [/^#\/?$/, home], [/^#\/(?:inbox|manager)$/, () => approvalsScreen({ api, me: ME })], [/^#\/manager\/reviews$/, () => teamReviewsScreen({ api, me: ME })],
  [/^#\/project\/([\w-]+)$/, (id) => projectScreen({ api, me: ME, id })], [/^#\/requests$/, () => requestsScreen({ api, me: ME })], [/^#\/review\/(.+)$/, (id) => reviewScreen({ api, id })], [/^#\/timeoff$/, () => timeoffScreen({ api })], [/^#\/request\/(.+)$/, (id) => requestScreen({ api, id })],
  [/^#\/history$/, () => historyScreen({ api })], [/^#\/projects(?:\?(.*))?$/, (query) => projectsScreen({ api, me: ME, query })], [/^#\/admin(?:\/(\w+))?$/, admin], [/^#\/ai$/, () => aiExamplesScreen({ api })],
  [/^#\/profile$/, () => myProfileScreen({ api })], [/^#\/team$/, () => teamScreen({ api, me: ME })], [/^#\/library(?:\?(.*))?$/, (query) => libraryScreen({ api, query })],
  [/^#\/timesheet(?:\?(.*))?$/, (query) => timesheetScreen({ api, me: ME, query })], [/^#\/expenses(?:\?(.*))?$/, (query) => expensesScreen({ api, me: ME, query })],
  [/^#\/letters$/, () => lettersScreen({ api })], [/^#\/company$/, () => companyScreen({ api, me: ME })], [/^#\/policies$/, () => policiesScreen({ api, me: ME })],
  [/^#\/onboarding$/, () => onboardingScreen({ api })], [/^#\/checklists$/, () => checklistsScreen({ api })],
  [/^#\/office(?:\?(.*))?$/, (query) => officeScreen({ api, query })], [/^#\/documents$/, () => documentsScreen({ api })], [/^#\/active$/, () => activeScreen({ api })], [/^#\/claude$/, () => claudeScreen({ api, me: ME })], [/^#\/reports$/, () => reportsScreen({ api })],
  [/^#\/commercial(?:\?(.*))?$/, (query) => commercialScreen({ api, query })], [/^#\/staffing(?:\?(.*))?$/, (query) => staffingScreen({ api, me: ME, query })], [/^#\/pipeline$/, () => pipelineScreen({ api, me: ME })],
  [/^#\/surveys$/, () => surveysScreen({ api })], [/^#\/offboarding$/, () => offboardingScreen({ api, me: ME })], [/^#\/training$/, () => trainingScreen({ api, me: ME })], [/^#\/messages(?:\?(.*))?$/, (query) => messagesScreen({ api, me: ME, query })], [/^#\/people$/, () => peopleScreen({ api })],
];
let SHELL = null;
async function boot() {
  try { ME = await api('/api/me'); } catch (e) { if (e.status === 401) return login(); throw e; }
  SHELL = mountShell({ me: ME, api, onSignOut: async () => { await api('/api/logout', { method: 'POST' }); location.hash = '#/'; location.reload(); } });
  window.addEventListener('hashchange', render);
  await render();
  // first visit: a short walkthrough (remembered per person; restart from Help)
  const prefs = await api('/api/me/prefs').catch(() => ({ tour_done: true }));
  if (!prefs.tour_done && !navigator.webdriver) (await import('/tour.js')).startTour({ api });
}
async function render() {
  // a drawer belongs to the page it was opened on: close it when the page changes
  document.querySelectorAll('body > .drawer, body > .overlay').forEach((el) => el.remove());
  const hash = location.hash || '#/';
  const page = pageFor(hash);
  SHELL.setPage(hash);
  const banner = SHELL.banner; banner.replaceChildren();
  const main = SHELL.main;
  const container = h('div', { class: 'page' }, banner, skeletonLines(5));
  main.replaceChildren(container);
  for (const [re, fn] of routes) {
    const m = re.exec(hash);
    if (!m) continue;
    let node;
    try { node = await fn(...m.slice(1)); } catch (e) { node = errorBox(e); }
    // standard page template: icon + title + one-line description; the screen's own h1 supplies the title text
    const h1 = node.querySelector?.('h1');
    const titleText = h1?.textContent?.trim();
    const header = pageHeader({ iconName: page.icon, title: titleText || page.title, description: page.desc, actions: node.pageActions || [] });
    if (!node.modern) { if (h1) h1.replaceWith(header); else node.prepend?.(header); }
    // a screen may say where it belongs (e.g. a review is "My Growth" for its subject, "Manager" for the reviewer)
    if (node.area || ((page.parent || page.tabOf) && titleText)) SHELL.setPage(hash, titleText, node.area);
    const tabs = SHELL.sectionNav(hash, node.area);
    const top = [tabs, ...(node.modern && !node.noHeader ? [header] : [])].filter(Boolean);
    if (node.modern) container.replaceChildren(...top, banner, node); else container.replaceChildren(...top, banner, node);
    container.classList.toggle('page-home', page.key === 'home');
    main.focus({ preventScroll: true });
    SHELL.refreshInbox();
    return;
  }
  container.replaceChildren(banner, emptyState({ iconName: 'circle-help', title: 'Page not found', text: 'The link may be out of date.', action: uiButton('Go to Home', { variant: 'primary', iconName: 'house', href: '#/' }) }));
}
async function login() { document.body.replaceChildren(await signInScreen({ api })); }

// ---------------------------------------------------------------- home --
function home() { return homeScreen({ api, me: ME }); }

// ------------------------------------------------------------ time off --
// ------------------------------------------------------------------ AI --
// --------------------------------------------------------------- admin --
function admin(tab = 'dashboard') {
  const screens = { dashboard: adminDashboardScreen, roster: adminRosterScreen, policy: adminPolicyScreen, reminders: adminRemindersScreen, ai: adminAiScreen, audit: adminAuditScreen };
  if (tab === 'imports') return importsScreen({ api, toBase64, render });
  return (screens[tab] || adminDashboardScreen)({ api });
}

boot();
