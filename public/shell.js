// App shell. Three workspaces, each with its own sidebar:
//   My workspace — four destinations for everyone: Home, My Work, My Growth, Company
//   Manager      — approvals, team reviews, resource calendar, pipeline, commercial (when authorised)
//   Admin        — people, imports, policy settings, office, audit … (when authorised)
// Pages inside a destination are reached from the section tabs at the top of the page.
// The header holds one search (pages, people, tasks) and the account menu.
import { h, icon, avatar, button, openDrawer } from '/ui.js';

/** Destinations of "My workspace". */
export const AREAS = {
  home: { title: 'Home', icon: 'house', href: '#/' },
  work: { title: 'My Work', icon: 'briefcase', href: '#/active' },
  growth: { title: 'My Growth', icon: 'trending-up', href: '#/performance' },
  company: { title: 'Company', icon: 'building-2', href: '#/team' },
};
const isMgr = (me) => !!me.nav.manager;

/** Every route: workspace area, tab placement, icon and one-line description. */
export const PAGES = [
  { key: 'home', re: /^#\/?$/, href: '#/', title: 'Home', icon: 'house', area: 'home', desc: null },
  // ---- My Work
  { key: 'active', re: /^#\/active$/, href: '#/active', title: 'Projects', icon: 'briefcase', area: 'work', tab: 'Projects', desc: 'The engagements you work on and everything running at GB' },
  { key: 'project', re: /^#\/project\//, title: 'Project', icon: 'briefcase', area: 'work', tabOf: 'active', desc: null },
  { key: 'card', re: /^#\/card\//, title: 'Task', icon: 'list-checks', area: 'work', tabOf: 'active', desc: null },
  { key: 'projects', re: /^#\/projects(\?.*)?$/, href: '#/projects', title: 'Contributions & register', icon: 'folder-kanban', area: 'work', tabOf: 'active', desc: 'Deliverables, who contributed what, and the project register' },
  { key: 'timesheet', re: /^#\/timesheet(\?.*)?$/, href: '#/timesheet', title: 'Timesheet', icon: 'timer', area: 'work', tab: 'Timesheet', desc: 'Your monthly hours by project — drafted for you from your assignments and leave' },
  { key: 'requests', re: /^#\/requests$/, href: '#/requests', title: 'Requests', icon: 'send', area: 'work', tab: 'Requests', desc: 'Leave, expenses, the gym allowance and HR letters' },
  { key: 'timeoff', re: /^#\/timeoff$/, href: '#/timeoff', title: 'Time off', icon: 'calendar-days', area: 'work', tabOf: 'requests', desc: 'Request leave or off-site work and see who is away' },
  { key: 'expenses', re: /^#\/expenses(\?.*)?$/, href: '#/expenses', title: 'Expenses', icon: 'receipt', area: 'work', tabOf: 'requests', desc: 'Claim expenses with receipts; approvals and payment' },
  { key: 'letters', re: /^#\/letters$/, href: '#/letters', title: 'Letters', icon: 'mail-check', area: 'work', tabOf: 'requests', desc: 'Ask for an experience letter, an internship letter or another HR letter' },
  { key: 'messages', re: /^#\/messages(\?.*)?$/, href: '#/messages', title: 'Messages', icon: 'messages-square', area: 'work', tab: 'Messages', desc: 'Private messages with colleagues — one to one or in groups' },
  // ---- My Growth
  { key: 'performance', re: /^#\/performance$/, href: '#/performance', title: 'My performance', icon: 'trending-up', area: 'growth', tab: 'My performance', desc: 'Your priorities, assignment evidence, feedback, coaching and released results' },
  { key: 'perf-review', re: /^#\/performance\/review\//, title: 'Performance review', icon: 'clipboard-list', area: 'growth', tabOf: 'performance', desc: null },
  { key: 'history', re: /^#\/history$/, href: '#/history', title: 'Earlier reviews', icon: 'clipboard-check', area: 'growth', tab: 'Earlier reviews', desc: 'Your goals and reviews across cycles, and next year’s plan' },
  { key: 'review', re: /^#\/review\//, title: 'Review', icon: 'clipboard-list', area: 'growth', tabOf: 'history', desc: null },
  { key: 'training', re: /^#\/training$/, href: '#/training', title: 'Training', icon: 'award', area: 'growth', tab: 'Training', desc: 'Your courses, hours and certificates' },
  { key: 'profile', re: /^#\/profile(\?.*)?$/, href: '#/profile', title: 'My profile', icon: 'id-card', area: 'growth', tab: 'Profile & CV', desc: 'Your employment details, benefits and CV — visible to you, People Ops and partners only' },
  { key: 'my-record', re: /^#\/my-record$/, href: '#/my-record', title: 'My employee record', icon: 'lock', area: 'growth', tab: 'Employee record', desc: 'Your personal, ID, education, contact and bank details — seen only by the GB admin' },
  { key: 'ai', re: /^#\/ai$/, href: '#/ai', title: 'AI examples', icon: 'sparkles', area: 'growth', tab: 'AI examples', desc: 'Examples of AI-assisted work and seat confirmations' },
  // ---- Company
  { key: 'team', re: /^#\/team$/, href: '#/team', title: 'Team', icon: 'users', area: 'company', tab: 'Team', desc: 'Who is who at GB Advisory: roles, experience and past projects' },
  { key: 'library', re: /^#\/library(\?.*)?$/, href: '#/library', title: 'Library', icon: 'library-big', area: 'company', tab: 'Library', desc: 'Every client and project GB has worked on, Drive links, proposals, toolkit and strategy KPIs' },
  { key: 'policies', re: /^#\/policies$/, href: '#/policies', title: 'Policies', icon: 'book-open-check', area: 'company', tab: 'Policies', desc: 'GB policies, including the AI and Claude usage rules — read and acknowledge' },
  { key: 'checklists', re: /^#\/checklists$/, href: '#/checklists', title: 'Checklists', icon: 'list-todo', area: 'company', tab: 'Checklists', desc: 'Quality checklists every deliverable passes before it is submitted' },
  { key: 'company', re: /^#\/company$/, href: '#/company', title: 'Company profile', icon: 'presentation', area: 'company', tab: 'Profile & brand', desc: 'The latest company profile, everyone’s CV in GB format, and the brand kit' },
  { key: 'onboarding', re: /^#\/onboarding$/, href: '#/onboarding', title: 'Onboarding', icon: 'user-plus', area: 'company', tab: 'Onboarding', desc: 'What a new joiner receives, reads and signs, step by step' },
  { key: 'claude', re: /^#\/claude$/, href: '#/claude', title: 'Claude accounts', icon: 'bot', area: 'company', tab: 'Claude accounts', desc: 'Which Claude seats are active, who uses each and what they are working on' },
  // ---- Manager workspace
  { key: 'approvals', re: /^#\/(manager|inbox)$/, href: '#/manager', title: 'Approvals', icon: 'inbox', ws: 'manager', desc: 'Everything waiting for your decision, oldest first', show: isMgr },
  { key: 'request', re: /^#\/request\//, title: 'Request', icon: 'calendar-check', ws: 'manager', parent: 'approvals', desc: 'Check the dates and balance, then decide' },
  { key: 'team-reviews', re: /^#\/manager\/reviews$/, href: '#/manager/reviews', title: 'Team reviews', icon: 'clipboard-check', ws: 'manager', desc: 'Where each review stands, and calibration', show: isMgr },
  { key: 'team-performance', re: /^#\/manager\/performance(\?.*)?$/, href: '#/manager/performance', title: 'Team performance', icon: 'trending-up', ws: 'manager', desc: 'Feedback to write, coaching, annual reviews and evidence coverage for your people', show: isMgr },
  { key: 'promotions', re: /^#\/admin\/promotions$/, href: '#/admin/promotions', title: 'Promotions', icon: 'award', ws: 'manager', desc: 'Promotion cases: eligibility, readiness and the founders’ decision', show: (me) => me.nav.founder || me.nav.manager },
  { key: 'staffing', re: /^#\/staffing(\?.*)?$/, href: '#/staffing', title: 'Resource calendar', icon: 'calendar-check', ws: 'manager', desc: 'Who is on which project, who is away and who has room', show: isMgr },
  { key: 'pipeline', re: /^#\/pipeline$/, href: '#/pipeline', title: 'Pipeline', icon: 'trending-up', ws: 'manager', desc: 'Opportunities by stage, value, probability, owner and next step', show: (me) => me.nav.pipeline },
  { key: 'commercial', re: /^#\/commercial(\?.*)?$/, href: '#/commercial', title: 'Commercial', icon: 'calculator', ws: 'manager', desc: 'Project budgets, burn, margin, billing milestones and cash — partners only', show: (me) => me.nav.commercial },
  { key: 'surveys', re: /^#\/surveys$/, href: '#/surveys', title: 'Surveys', icon: 'heart', ws: (me) => (me.nav.people ? 'manager' : 'mine'), area: 'company', desc: 'Anonymous team pulse and client feedback', show: (me) => me.nav.people },
  // ---- Admin workspace
  { key: 'perf-setup', re: /^#\/admin\/performance$/, href: '#/admin/performance', title: 'Performance setup', icon: 'scale', ws: 'admin', desc: 'Policy, cycles and progress — the founders approve the policy', show: (me) => me.nav.perf_admin },
  { key: 'calibration', re: /^#\/admin\/calibration$/, href: '#/admin/calibration', title: 'Calibration', icon: 'gauge', ws: 'admin', desc: 'Everyone side by side; both founders confirm each result before it is released', show: (me) => me.nav.perf_admin },
  { key: 'compensation', re: /^#\/admin\/compensation$/, href: '#/admin/compensation', title: 'Compensation', icon: 'calculator', ws: 'admin', desc: 'Restricted: founders and named compensation administrators', show: (me) => me.nav.comp },
  { key: 'pms-history', re: /^#\/admin\/pms-history$/, href: '#/admin/pms-history', title: 'PMS history import', icon: 'cloud-upload', ws: 'admin', desc: '2025 communicated outcomes and worksheets — dry run first', show: (me) => me.nav.hr && me.nav.comp },
  { key: 'admin-records', re: /^#\/admin\/records(\?.*)?$/, href: '#/admin/records', title: 'Employee records', icon: 'lock', ws: 'admin', desc: 'Codes, titles in English and Arabic, grade, pay, ID, education, contacts and bank — admin only, encrypted', show: (me) => me.nav.hr },
  { key: 'people', re: /^#\/people$/, href: '#/people', title: 'People', icon: 'contact', ws: 'admin', desc: 'Employee profiles, benefits status and what still needs confirming', show: (me) => me.nav.people },
  { key: 'reports', re: /^#\/reports$/, href: '#/reports', title: 'Reports', icon: 'gauge', ws: 'admin', desc: 'People, time, money, projects and reviews at a glance', show: (me) => me.nav.people },
  { key: 'admin-dashboard', re: /^#\/admin(\/dashboard)?$/, href: '#/admin/dashboard', title: 'Review completion', icon: 'layout-dashboard', ws: 'admin', desc: 'Review progress across the cycle', show: (me) => me.nav.admin },
  { key: 'admin-roster', re: /^#\/admin\/roster$/, href: '#/admin/roster', title: 'Roster', icon: 'users', ws: 'admin', desc: 'People, roles, managers and probation dates', show: (me) => me.nav.admin },
  { key: 'offboarding', re: /^#\/offboarding$/, href: '#/offboarding', title: 'Offboarding', icon: 'log-out', ws: (me) => (me.nav.admin || me.nav.people ? 'admin' : 'mine'), area: 'company', desc: 'Leaver checklist: handover, equipment, access, settlement', show: (me) => me.nav.admin || me.nav.people },
  { key: 'office', re: /^#\/office(\?.*)?$/, href: '#/office', title: 'Office expenses', icon: 'building-2', ws: 'admin', desc: 'Rent, utilities, kitchen, supplies and fines — kept by the office administrator', show: (me) => me.nav.office },
  { key: 'documents', re: /^#\/documents$/, href: '#/documents', title: 'Company documents', icon: 'file-check-2', ws: 'admin', desc: 'Licences, registrations and other government papers, with expiry reminders', show: (me) => me.nav.office },
  { key: 'admin-imports', re: /^#\/admin\/imports$/, href: '#/admin/imports', title: 'Imports', icon: 'cloud-upload', ws: 'admin', desc: 'Bring in PMS forms and LeaveBoard exports safely', show: (me) => me.nav.admin },
  { key: 'admin-policy', re: /^#\/admin\/policy$/, href: '#/admin/policy', title: 'Policy settings', icon: 'scale', ws: 'admin', desc: 'Leave rules and GB approvals', show: (me) => me.nav.admin },
  { key: 'admin-reminders', re: /^#\/admin\/reminders$/, href: '#/admin/reminders', title: 'Reminders', icon: 'bell-ring', ws: 'admin', desc: 'Preview, queue and send review reminders', show: (me) => me.nav.admin },
  { key: 'admin-ai', re: /^#\/admin\/ai$/, href: '#/admin/ai', title: 'AI adoption', icon: 'bot', ws: 'admin', desc: 'Gemini and Claude usage, kept apart from ratings', show: (me) => me.nav.admin },
  { key: 'admin-audit', re: /^#\/admin\/audit$/, href: '#/admin/audit', title: 'Audit log', icon: 'scroll-text', ws: 'admin', desc: 'Who did what, and when', show: (me) => me.nav.admin },
];
export const pageFor = (hash) => PAGES.find((p) => p.re.test(hash)) || PAGES[0];
const wsOf = (p, me) => (typeof p.ws === 'function' ? p.ws(me) : p.ws) || 'mine';
const allowed = (p, me) => !p.show || p.show(me);
const WORKSPACES = [
  { key: 'mine', title: 'My workspace', icon: 'user' },
  { key: 'manager', title: 'Manager', icon: 'users' },
  { key: 'admin', title: 'Admin', icon: 'settings' },
];

const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

export function mountShell({ me, api, onSignOut }) {
  document.body.className = 'ui';
  delete document.body.dataset.sidebar;
  const collapsed = store.get('prism.sidebar') === 'collapsed';
  const wsPages = (ws) => PAGES.filter((p) => p.href && wsOf(p, me) === ws && allowed(p, me));
  const spaces = WORKSPACES.filter((w) => w.key === 'mine' || wsPages(w.key).length);
  const navLinks = new Map(); // key -> <a>
  const counts = new Map();
  let currentWs = 'mine';

  const navItem = (key, title, iconName, href) => {
    const count = h('span', { class: 'nav-count', hidden: true });
    counts.set(key, count);
    const a = h('a', { class: 'nav-item', href, title, onclick: () => shell.classList.remove('nav-open') }, icon(iconName, { size: 'lg' }), h('span', { class: 'nav-label' }, title), count);
    navLinks.set(key, a);
    return a;
  };
  const navBox = h('div', { class: 'nav-group' });
  const switchLinks = new Map();
  const switcher = spaces.length > 1 ? h('nav', { class: 'ws-switch', 'aria-label': 'Workspace' }, spaces.map((w) => {
    const first = w.key === 'mine' ? '#/' : wsPages(w.key)[0].href;
    const c = h('span', { class: 'nav-count', hidden: true }); counts.set(`ws:${w.key}`, c);
    const a = h('a', { class: 'ws-link', href: first, title: w.title }, icon(w.icon), h('span', { class: 'nav-label' }, w.title), c);
    switchLinks.set(w.key, a); return a;
  })) : null;
  function drawNav(ws) {
    currentWs = ws; navLinks.clear();
    const items = ws === 'mine' ? Object.entries(AREAS).map(([k, a]) => navItem(`area:${k}`, a.title, a.icon, a.href)) : wsPages(ws).map((p) => navItem(p.key, p.title, p.icon, p.href));
    navBox.replaceChildren(...(ws === 'mine' ? [] : [h('div', { class: 'nav-group-label' }, WORKSPACES.find((w) => w.key === ws).title)]), ...items);
    for (const [k, a] of switchLinks) a.toggleAttribute('aria-current', k === ws);
    paintCounts();
  }
  const collapseBtn = h('button', { class: 'nav-item', type: 'button', 'aria-label': 'Collapse sidebar', onclick: () => toggleCollapse() }, icon(collapsed ? 'chevrons-right' : 'chevrons-left', { size: 'lg', flip: true }), h('span', { class: 'nav-label' }, 'Collapse'));
  const sidebar = h('nav', { class: 'sidebar', 'aria-label': 'Main' },
    h('a', { class: 'sidebar-logo', href: '#/', 'aria-label': 'GB Advisory — home' }, h('img', { class: 'full', src: '/brand/gb-logo-white.png', alt: 'GB Advisory' }), h('img', { class: 'mark', src: '/brand/gb-mark.png', alt: 'GB Advisory' })),
    switcher, navBox,
    h('div', { class: 'sidebar-footer' }, h('a', { class: 'sidebar-me', href: '#/profile', title: 'My profile' }, avatar(me), h('span', { class: 'nav-label' }, h('strong', {}, me.name), me.title ? h('span', {}, me.title) : null)), collapseBtn));

  const userMenu = h('div', { class: 'menu', role: 'menu', hidden: true },
    h('div', { class: 'menu-head' }, h('strong', {}, me.name), me.title ? h('span', { class: 'muted' }, me.title) : null),
    h('a', { class: 'menu-item', role: 'menuitem', href: '#/profile' }, icon('id-card'), 'My profile'),
    h('a', { class: 'menu-item', role: 'menuitem', href: 'https://meet.google.com/new', target: '_blank', rel: 'noopener' }, icon('video'), 'Start a Google Meet'),
    h('button', { class: 'menu-item', role: 'menuitem', type: 'button', onclick: () => { toggleMenu(false); openHelp(); } }, icon('circle-help'), 'Help'),
    me.can_view_as ? h('button', { class: 'menu-item', role: 'menuitem', type: 'button', onclick: () => viewAs(me.view_as ? null : 'employee') }, icon(me.view_as ? 'rotate-ccw' : 'eye'), me.view_as ? 'Back to my own access' : 'See the portal as an employee') : null,
    h('button', { class: 'menu-item', role: 'menuitem', type: 'button', onclick: onSignOut }, icon('log-out', { flip: true }), 'Sign out'));
  async function viewAs(mode) { await api('/api/view-as', { method: 'POST', body: { mode } }); location.hash = '#/'; location.reload(); }
  const avatarBtn = h('button', { class: 'avatar-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `Account: ${me.name}`, onclick: (e) => { e.stopPropagation(); toggleMenu(); } }, avatar(me));
  const toggleMenu = (force) => { const open = force ?? userMenu.hidden; userMenu.hidden = !open; avatarBtn.setAttribute('aria-expanded', String(open)); if (open) userMenu.querySelector('a,button')?.focus(); };
  document.addEventListener('click', (e) => { if (!userMenu.hidden && !userMenu.contains(e.target)) toggleMenu(false); });
  userMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { toggleMenu(false); avatarBtn.focus(); } });

  const topbar = h('header', { class: 'topbar' },
    button('', { variant: 'ghost', iconName: 'menu', ariaLabel: 'Open menu', onClick: () => shell.classList.add('nav-open') }),
    h('button', { class: 'search-trigger', type: 'button', onclick: () => openPalette() }, icon('search'), h('span', { class: 'label' }, 'Search people, projects, policies and tasks'), h('kbd', {}, navigator.platform?.includes('Mac') ? '⌘K' : 'Ctrl K')),
    h('div', { class: 'topbar-actions' }, h('div', { class: 'menu-anchor' }, avatarBtn, userMenu)));
  topbar.firstChild.classList.add('mobile-only');

  const banner = h('div', { id: 'banner', role: 'status', 'aria-live': 'polite' });
  const main = h('main', { id: 'main', tabindex: '-1' });
  const scrim = h('div', { class: 'nav-scrim', onclick: () => shell.classList.remove('nav-open') });
  const shell = h('div', { class: `app-shell${collapsed ? ' collapsed' : ''}` }, sidebar, h('div', { class: 'shell-main' }, topbar,
    me.view_as ? h('div', { class: 'view-as-bar', role: 'status' }, icon('eye'), h('span', {}, 'You are seeing the portal as an employee. Partner and admin pages are hidden. Things assigned to you by name (your reviews, leave approvals) still show.'),
      button('Back to my own access', { size: 'sm', iconName: 'rotate-ccw', onClick: () => viewAs(null) })) : null, main), scrim);
  document.body.replaceChildren(h('a', { class: 'skip', href: '#main' }, 'Skip to content'), shell);

  function toggleCollapse() {
    const c = shell.classList.toggle('collapsed');
    store.set('prism.sidebar', c ? 'collapsed' : 'open');
    collapseBtn.replaceChildren(icon(c ? 'chevrons-right' : 'chevrons-left', { size: 'lg', flip: true }), h('span', { class: 'nav-label' }, c ? 'Expand' : 'Collapse'));
    collapseBtn.setAttribute('aria-label', c ? 'Expand sidebar' : 'Collapse sidebar');
  }

  // ------------------------------------------------- counts (team approvals) --
  let inboxItems = []; let unread = 0;
  function paintCounts() {
    const team = inboxItems.filter((i) => i.scope === 'team').length;
    const set = (k, n) => { const c = counts.get(k); if (c) { c.hidden = !n; c.textContent = String(n); } };
    set('approvals', team); set('ws:manager', currentWs === 'manager' ? 0 : team); set('area:work', unread);
  }
  async function refreshInbox() {
    try { inboxItems = (await api('/api/inbox')).items || []; } catch { inboxItems = []; }
    try { unread = (await api('/api/messages/unread')).unread || 0; } catch { /* offline */ }
    paintCounts();
  }

  // ------------------------------------------------------- page template --
  /** Highlight the page's place in the sidebar; switch sidebar when the workspace changes. */
  function setPage(hash, titleText, areaOverride) {
    const p = pageFor(hash);
    const ws = areaOverride ? (areaOverride === 'manager' ? 'manager' : 'mine') : wsOf(p, me);
    const target = spaces.some((s) => s.key === ws) ? ws : 'mine';
    if (target !== currentWs) drawNav(target);
    const area = areaOverride && areaOverride !== 'manager' ? areaOverride : p.area;
    const activeKey = target === 'mine' ? `area:${area || 'home'}` : ({ review: 'team-reviews' }[p.key] || p.parent || p.key);
    for (const [k, a] of navLinks) { if (k === activeKey) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    document.title = `${titleText || p.title} · GB People`;
    return p;
  }
  /** Tabs across the top of a My-workspace destination (My Work, My Growth, Company). */
  function sectionNav(hash, areaOverride) {
    const p = pageFor(hash);
    const area = areaOverride && areaOverride !== 'manager' ? areaOverride : wsOf(p, me) === 'mine' ? p.area : null;
    if (!area || area === 'home') return null;
    const tabs = PAGES.filter((x) => x.area === area && x.tab && allowed(x, me));
    const current = p.tabOf || p.key;
    return h('nav', { class: 'section-nav', 'aria-label': AREAS[area].title },
      h('span', { class: 'section-eyebrow' }, AREAS[area].title),
      h('div', { class: 'section-tabs' }, tabs.map((t) => h('a', { class: 'section-tab', href: t.href, 'aria-current': t.key === current ? 'page' : null }, t.tab))));
  }

  // ------------------------------------------------------- search (⌘K) --
  let palette = null;
  async function openPalette() {
    if (palette) return;
    let people = [];
    try { people = await api('/api/people'); } catch { /* optional */ }
    let projects = [];
    try { projects = await api('/api/active-projects'); } catch { /* optional */ }
    const pages = PAGES.filter((p) => p.href && allowed(p, me));
    let remote = []; let seq = 0;
    const base = [
      ...inboxItems.map((i) => ({ group: i.scope === 'team' ? 'Waiting for your decision' : 'Your tasks', label: i.title, sub: i.kind, iconName: 'inbox', href: i.link })),
      ...pages.map((p) => ({ group: 'Pages', label: p.title, sub: p.desc, iconName: p.icon, href: p.href })),
      ...projects.map((p) => ({ group: 'Projects', label: p.name, sub: [p.client_name, p.lead_name ? `Lead ${p.lead_name}` : null].filter(Boolean).join(' · '), iconName: 'briefcase', href: `#/project/${p.id}` })),
      ...people.map((u) => ({ group: 'People', label: u.name, sub: 'Team directory', iconName: 'user', href: '#/team' })),
      { group: 'Actions', label: 'Request time off', iconName: 'plus', href: '#/timeoff' },
      { group: 'Actions', label: 'Submit an expense', iconName: 'plus', href: '#/expenses' },
      { group: 'Actions', label: 'Edit my profile & CV', iconName: 'pencil', href: '#/profile?edit=1' },
      { group: 'Actions', label: 'Update my projects', iconName: 'briefcase', href: '#/active' },
      { group: 'Actions', label: 'Sign out', iconName: 'log-out', run: onSignOut },
    ];
    const entriesNow = () => [...remote, ...base];
    // tasks and project discussion: asked from the server, which returns only what this person may open
    const searchRemote = async (q) => {
      const n = ++seq;
      if (q.length < 2) { remote = []; return; }
      try {
        const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
        if (n !== seq) return;
        remote = [...r.cards.map((c) => ({ group: 'Tasks', label: c.title, sub: `${c.project} · ${c.status}`, iconName: 'list-checks', href: c.link, remote: true })),
          ...r.messages.map((m) => ({ group: 'Messages', label: m.snippet, sub: `${m.sender} · ${m.where}`, iconName: 'messages-square', href: m.link, remote: true }))];
        draw();
      } catch { /* offline */ }
    };
    const inputEl = h('input', { type: 'text', placeholder: 'Search people, projects, policies and tasks…', 'aria-label': 'Search', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', autocomplete: 'off' });
    const list = h('ul', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
    let active = 0; let shown = [];
    const draw = () => {
      const q = inputEl.value.trim().toLowerCase();
      const score = (e) => { const l = e.label.toLowerCase(); return l.startsWith(q) ? 0 : l.includes(q) ? 1 : `${e.sub || ''} ${e.group}`.toLowerCase().includes(q) ? 2 : 9; };
      const entries = entriesNow();
      shown = !q ? entries.filter((e) => !e.remote && e.group !== 'People' && e.group !== 'Projects').slice(0, 40) : entries.map((e, i) => [e.remote ? Math.min(score(e), 1) : score(e), i, e]).filter(([sc]) => sc < 9).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , e]) => e).slice(0, 40);
      active = Math.min(active, Math.max(0, shown.length - 1));
      let g = null; const kids = [];
      shown.forEach((e, i) => {
        if (e.group !== g) { g = e.group; kids.push(h('li', { class: 'palette-group', role: 'presentation' }, g)); }
        kids.push(h('li', { class: 'palette-item', role: 'option', id: `pal-${i}`, 'aria-selected': String(i === active), onmousemove: () => { if (active !== i) { active = i; draw(); } }, onclick: () => choose(e) }, icon(e.iconName || 'arrow-right', { size: 'lg' }), h('span', {}, e.label), e.sub ? h('span', { class: 'hint' }, e.sub) : null));
      });
      if (!shown.length) kids.push(h('li', { class: 'palette-group', role: 'presentation' }, 'No matches'));
      list.replaceChildren(...kids);
      inputEl.setAttribute('aria-activedescendant', shown.length ? `pal-${active}` : '');
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    };
    const close = () => { palette?.remove(); scrimP.remove(); palette = null; };
    const choose = (e) => { close(); if (e.run) e.run(); else location.hash = e.href; };
    let deb;
    inputEl.addEventListener('input', () => { active = 0; draw(); clearTimeout(deb); deb = setTimeout(() => searchRemote(inputEl.value.trim()), 200); });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, shown.length - 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); draw(); }
      else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); choose(shown[active]); }
      else if (e.key === 'Escape') close();
    });
    const scrimP = h('div', { class: 'overlay', onclick: close });
    palette = h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' }, h('div', { class: 'palette-input' }, icon('search', { size: 'lg' }), inputEl, h('kbd', { class: 'muted' }, 'Esc')), list);
    document.body.append(scrimP, palette);
    draw(); inputEl.focus();
  }
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    if (e.key === 'Escape') shell.classList.remove('nav-open');
  });

  // ------------------------------------------------------------------ help --
  function openHelp() {
    const p = pageFor(location.hash || '#/');
    openDrawer({ title: 'Help', iconName: 'circle-help', body: [
      h('p', {}, h('strong', {}, p.title), p.desc ? ` — ${p.desc}.` : ''),
      h('ul', {}, h('li', {}, 'Press ', h('kbd', {}, '⌘K'), ' or ', h('kbd', {}, 'Ctrl K'), ' to find any page, project, person or task.'),
        h('li', {}, 'Home shows what needs you now; My Work holds projects, timesheet and requests; My Growth holds your reviews, training and CV.'),
        h('li', {}, 'Changes in reviews save automatically; you will see "Saved" next to the status.'),
        h('li', {}, 'Your ratings, comments and leave reasons are only visible to the people involved.')),
      h('p', { class: 'muted' }, 'Something wrong with your plan, a project or a balance? Contact People Ops.'),
      button('Take the tour again', { iconName: 'party-popper', onClick: async () => { document.querySelector('.drawer header .btn')?.click(); (await import('/tour.js')).startTour({ api }); } }),
    ] });
  }

  drawNav('mine');
  refreshInbox();
  setInterval(() => { if (!document.hidden) refreshInbox(); }, 60_000);
  return { main, banner, setPage, sectionNav, refreshInbox };
}
