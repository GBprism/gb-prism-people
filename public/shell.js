// App shell: grouped sidebar (collapsible to an icon rail), top bar with
// breadcrumbs, ⌘K command palette, inbox bell, help and the user menu.
// Pure presentation — it only calls existing read endpoints (/api/inbox, /api/people).
import { h, icon, avatar, button, openDrawer } from '/ui.js';

/** Route metadata: nav placement, page icon, breadcrumb and one-line description. */
export const PAGES = [
  { key: 'home', re: /^#\/?$/, href: '#/', title: 'Home', icon: 'house', group: 'Workspace', desc: 'Your tasks, reviews and time off in one place' },
  { key: 'inbox', re: /^#\/inbox$/, href: '#/inbox', title: 'Team inbox', icon: 'inbox', group: 'Workspace', desc: 'Reviews, requests and feedback waiting for you', show: (me) => me.nav.inbox },
  { key: 'timeoff', re: /^#\/timeoff$/, href: '#/timeoff', title: 'Time off', icon: 'calendar-days', group: 'Workspace', desc: 'Request leave or off-site work and see who is away' },
  { key: 'request', re: /^#\/request\//, title: 'Request', icon: 'calendar-check', parent: 'inbox', desc: 'Check the dates and balance, then decide' },
  { key: 'history', re: /^#\/history$/, href: '#/history', title: 'My reviews', icon: 'clipboard-check', group: 'Performance', desc: 'Your reviews across cycles and next year’s plan' },
  { key: 'review', re: /^#\/review\//, title: 'Review', icon: 'clipboard-list', parent: 'history', desc: null },
  { key: 'projects', re: /^#\/projects(\?.*)?$/, href: '#/projects', title: 'Projects', icon: 'folder-kanban', group: 'Performance', desc: 'Engagements, deliverables and who contributed what' },
  { key: 'ai', re: /^#\/ai$/, href: '#/ai', title: 'AI examples', icon: 'sparkles', group: 'Performance', desc: 'Examples of AI-assisted work and seat confirmations' },
  { key: 'timesheet', re: /^#\/timesheet(\?.*)?$/, href: '#/timesheet', title: 'Timesheet', icon: 'timer', group: 'Workspace', desc: 'Your monthly hours by project — drafted for you from your assignments and leave' },
  { key: 'expenses', re: /^#\/expenses(\?.*)?$/, href: '#/expenses', title: 'Expenses', icon: 'receipt', group: 'Workspace', desc: 'Claim expenses with receipts; approvals and payment' },
  { key: 'letters', re: /^#\/letters$/, href: '#/letters', title: 'Letters & requests', icon: 'mail-check', group: 'Workspace', desc: 'Ask for an experience letter, an internship letter or another HR letter' },
  { key: 'checklists', re: /^#\/checklists$/, href: '#/checklists', title: 'Checklists', icon: 'list-todo', group: 'Company', desc: 'Quality checklists every deliverable passes before it is submitted' },
  { key: 'company', re: /^#\/company$/, href: '#/company', title: 'Company profile', icon: 'presentation', group: 'Company', desc: 'The latest company profile, everyone’s CV in GB format, and the brand kit' },
  { key: 'policies', re: /^#\/policies$/, href: '#/policies', title: 'Policies', icon: 'book-open-check', group: 'Company', desc: 'GB policies, including the AI and Claude usage rules — read and acknowledge' },
  { key: 'onboarding', re: /^#\/onboarding$/, href: '#/onboarding', title: 'Onboarding', icon: 'user-plus', group: 'Company', desc: 'What a new joiner receives, reads and signs, step by step' },
  { key: 'office', re: /^#\/office(\?.*)?$/, href: '#/office', title: 'Office expenses', icon: 'building-2', group: 'Company', desc: 'Rent, utilities, kitchen, supplies and fines — kept by the office administrator', show: (me) => me.nav.office },
  { key: 'documents', re: /^#\/documents$/, href: '#/documents', title: 'Company documents', icon: 'file-check-2', group: 'Company', desc: 'Licences, registrations and other government papers, with expiry reminders', show: (me) => me.nav.office },
  { key: 'library', re: /^#\/library(\?.*)?$/, href: '#/library', title: 'Library', icon: 'library-big', group: 'Company', desc: 'Every client and project GB has worked on, who did it, Drive links, proposals and strategy KPIs' },
  { key: 'team', re: /^#\/team$/, href: '#/team', title: 'Team', icon: 'users', group: 'Workspace', desc: 'Who is who at GB Advisory: roles, experience and past projects' },
  { key: 'profile', re: /^#\/profile$/, href: '#/profile', title: 'My profile', icon: 'id-card', group: 'Workspace', desc: 'Your employment details, benefits and 2026 work — visible to you, People Ops and partners only' },
  { key: 'people', re: /^#\/people$/, href: '#/people', title: 'People', icon: 'contact', group: 'Admin', desc: 'Employee profiles, benefits status and what still needs confirming', show: (me) => me.nav.people },
  { key: 'admin-dashboard', re: /^#\/admin(\/dashboard)?$/, href: '#/admin/dashboard', title: 'Completion', icon: 'layout-dashboard', group: 'Admin', desc: 'Review progress across the cycle', show: (me) => me.nav.admin },
  { key: 'admin-roster', re: /^#\/admin\/roster$/, href: '#/admin/roster', title: 'Roster', icon: 'users', group: 'Admin', desc: 'People, roles, managers and probation dates', show: (me) => me.nav.admin },
  { key: 'admin-imports', re: /^#\/admin\/imports$/, href: '#/admin/imports', title: 'Imports', icon: 'cloud-upload', group: 'Admin', desc: 'Bring in PMS forms and LeaveBoard exports safely', show: (me) => me.nav.admin },
  { key: 'admin-policy', re: /^#\/admin\/policy$/, href: '#/admin/policy', title: 'Policy settings', icon: 'scale', group: 'Admin', desc: 'Leave rules and GB approvals', show: (me) => me.nav.admin },
  { key: 'admin-reminders', re: /^#\/admin\/reminders$/, href: '#/admin/reminders', title: 'Reminders', icon: 'bell-ring', group: 'Admin', desc: 'Preview, queue and send review reminders', show: (me) => me.nav.admin },
  { key: 'admin-ai', re: /^#\/admin\/ai$/, href: '#/admin/ai', title: 'AI adoption', icon: 'bot', group: 'Admin', desc: 'Gemini and Claude usage, kept apart from ratings', show: (me) => me.nav.admin },
  { key: 'admin-audit', re: /^#\/admin\/audit$/, href: '#/admin/audit', title: 'Audit log', icon: 'scroll-text', group: 'Admin', desc: 'Who did what, and when', show: (me) => me.nav.admin },
];
const GROUPS = ['Workspace', 'Performance', 'Company', 'Admin'];
export const pageFor = (hash) => PAGES.find((p) => p.re.test(hash)) || PAGES[0];
const visible = (me) => PAGES.filter((p) => p.group && (!p.show || p.show(me)));
/** Apps the person may open, grouped as in the sidebar (used by the Home launcher). */
export const appsFor = (me) => GROUPS.map((group) => ({ group, items: visible(me).filter((p) => p.group === group) })).filter((g) => g.items.length);

const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

export function mountShell({ me, api, onSignOut }) {
  document.body.className = 'ui';
  document.body.dataset.sidebar = 'light';
  const collapsed = store.get('prism.sidebar') === 'collapsed';
  const navLinks = new Map();
  const counts = new Map();

  const navItem = (p) => {
    const count = h('span', { class: 'nav-count', hidden: true });
    counts.set(p.key, count);
    const a = h('a', { class: 'nav-item', href: p.href, title: p.title, onclick: () => shell.classList.remove('nav-open') }, icon(p.icon, { size: 'lg' }), h('span', { class: 'nav-label' }, p.title), count);
    navLinks.set(p.key, a);
    return a;
  };
  const collapseBtn = h('button', { class: 'nav-item', type: 'button', 'aria-label': 'Collapse sidebar', onclick: () => toggleCollapse() }, icon(collapsed ? 'chevrons-right' : 'chevrons-left', { size: 'lg', flip: true }), h('span', { class: 'nav-label' }, 'Collapse'));
  const sidebar = h('nav', { class: 'sidebar', 'aria-label': 'Main' },
    h('a', { class: 'sidebar-logo', href: '#/', 'aria-label': 'GB Advisory — home' }, h('img', { class: 'full', src: '/brand/gb-logo.png', alt: 'GB Advisory' }), h('img', { class: 'mark', src: '/brand/gb-mark.png', alt: 'GB Advisory' })),
    GROUPS.map((g) => { const items = visible(me).filter((p) => p.group === g); return items.length ? h('div', { class: 'nav-group' }, h('div', { class: 'nav-group-label' }, g), items.map(navItem)) : null; }),
    h('div', { class: 'sidebar-footer' }, collapseBtn));

  const crumbs = h('nav', { class: 'breadcrumbs', 'aria-label': 'Breadcrumb' });
  const bell = button('', { variant: 'ghost', iconName: 'bell', ariaLabel: 'Waiting for you', title: 'Waiting for you', href: '#/inbox' });
  const userMenu = h('div', { class: 'menu', role: 'menu', hidden: true },
    h('div', { class: 'menu-head' }, h('strong', {}, me.name), me.title ? h('span', { class: 'muted' }, me.title) : null),
    h('a', { class: 'menu-item', role: 'menuitem', href: '#/profile' }, icon('id-card'), 'My profile'),
    h('a', { class: 'menu-item', role: 'menuitem', href: '#/history' }, icon('clipboard-check'), 'My reviews'),
    h('a', { class: 'menu-item', role: 'menuitem', href: '#/timeoff' }, icon('calendar-days'), 'My time off'),
    h('button', { class: 'menu-item', role: 'menuitem', type: 'button', onclick: onSignOut }, icon('log-out', { flip: true }), 'Sign out'));
  const avatarBtn = h('button', { class: 'avatar-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `Account: ${me.name}`, onclick: (e) => { e.stopPropagation(); toggleMenu(); } }, avatar(me));
  const toggleMenu = (force) => { const open = force ?? userMenu.hidden; userMenu.hidden = !open; avatarBtn.setAttribute('aria-expanded', String(open)); if (open) userMenu.querySelector('a,button')?.focus(); };
  document.addEventListener('click', (e) => { if (!userMenu.hidden && !userMenu.contains(e.target)) toggleMenu(false); });
  userMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { toggleMenu(false); avatarBtn.focus(); } });

  const topbar = h('header', { class: 'topbar' },
    button('', { variant: 'ghost', iconName: 'menu', ariaLabel: 'Open menu', onClick: () => shell.classList.add('nav-open') }), crumbs,
    h('div', { class: 'topbar-actions' },
      h('button', { class: 'search-trigger', type: 'button', onclick: () => openPalette() }, icon('search'), h('span', { class: 'label' }, 'Search or jump to…'), h('kbd', {}, navigator.platform?.includes('Mac') ? '⌘K' : 'Ctrl K')),
      h('a', { class: 'btn btn-ghost btn-icon', href: 'https://meet.google.com/new', target: '_blank', rel: 'noopener', 'aria-label': 'Start a Google Meet', title: 'Start a Google Meet' }, icon('video')),
      bell, button('', { variant: 'ghost', iconName: 'circle-help', ariaLabel: 'Help', title: 'Help', onClick: () => openHelp() }),
      h('div', { class: 'menu-anchor' }, avatarBtn, userMenu)));
  topbar.firstChild.classList.add('mobile-only');

  const banner = h('div', { id: 'banner', role: 'status', 'aria-live': 'polite' });
  const main = h('main', { id: 'main', tabindex: '-1' });
  const scrim = h('div', { class: 'nav-scrim', onclick: () => shell.classList.remove('nav-open') });
  const shell = h('div', { class: `app-shell${collapsed ? ' collapsed' : ''}` }, sidebar, h('div', { class: 'shell-main' }, topbar, main), scrim);
  document.body.replaceChildren(h('a', { class: 'skip', href: '#main' }, 'Skip to content'), shell);

  function toggleCollapse() {
    const c = shell.classList.toggle('collapsed');
    store.set('prism.sidebar', c ? 'collapsed' : 'open');
    collapseBtn.replaceChildren(icon(c ? 'chevrons-right' : 'chevrons-left', { size: 'lg', flip: true }), h('span', { class: 'nav-label' }, c ? 'Expand' : 'Collapse'));
    collapseBtn.setAttribute('aria-label', c ? 'Expand sidebar' : 'Collapse sidebar');
  }

  // ---------------------------------------------------- inbox count / bell --
  let inboxItems = [];
  async function refreshInbox() {
    try { inboxItems = (await api('/api/inbox')).items || []; } catch { inboxItems = []; }
    const n = inboxItems.length; const c = counts.get('inbox');
    if (c) { c.hidden = !n; c.textContent = String(n); }
    bell.classList.toggle('icon-dot', n > 0);
    bell.setAttribute('aria-label', n ? `${n} item${n === 1 ? '' : 's'} waiting for you` : 'Nothing waiting for you');
  }

  // ------------------------------------------------------- page template --
  function setPage(hash, titleText) {
    const p = pageFor(hash);
    for (const [k, a] of navLinks) a.toggleAttribute('aria-current', k === p.key || k === p.parent);
    navLinks.forEach((a) => { if (a.hasAttribute('aria-current')) a.setAttribute('aria-current', 'page'); });
    const parent = p.parent ? PAGES.find((x) => x.key === p.parent) : null;
    const group = (parent || p).group;
    const trail = [group ? h('span', {}, group) : null, parent ? h('a', { href: parent.href }, parent.title) : null, h('span', { 'aria-current': 'page' }, titleText || p.title)].filter(Boolean);
    crumbs.replaceChildren(...trail.flatMap((t, i) => (i ? [icon('chevron-right', { flip: true }), t] : [t])));
    document.title = `${titleText || p.title} · GB Prism`;
    return p;
  }

  // ------------------------------------------------------- command palette --
  let palette = null;
  async function openPalette() {
    if (palette) return;
    let people = [];
    if (me.nav.admin) { try { people = await api('/api/people'); } catch { /* optional */ } }
    const entries = [
      ...visible(me).map((p) => ({ group: 'Go to', label: p.title, sub: p.desc, iconName: p.icon, href: p.href })),
      ...inboxItems.map((i) => ({ group: 'Waiting for you', label: i.title, sub: i.kind, iconName: 'inbox', href: i.link })),
      ...people.map((u) => ({ group: 'People', label: u.name, sub: 'Open roster', iconName: 'user', href: '#/admin/roster' })),
      { group: 'Actions', label: 'Request time off', iconName: 'plus', href: '#/timeoff' },
      { group: 'Actions', label: 'Sign out', iconName: 'log-out', run: onSignOut },
    ];
    const inputEl = h('input', { type: 'text', placeholder: 'Search pages, people and tasks…', 'aria-label': 'Search', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', autocomplete: 'off' });
    const list = h('ul', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
    let active = 0; let shown = [];
    const draw = () => {
      const q = inputEl.value.trim().toLowerCase();
      // rank: name starts with query > name contains > description/group contains (stable within groups)
      const score = (e) => { const l = e.label.toLowerCase(); return l.startsWith(q) ? 0 : l.includes(q) ? 1 : `${e.sub || ''} ${e.group}`.toLowerCase().includes(q) ? 2 : 9; };
      shown = !q ? entries.slice(0, 40) : entries.map((e, i) => [score(e), i, e]).filter(([sc]) => sc < 9).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , e]) => e).slice(0, 40);
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
    inputEl.addEventListener('input', () => { active = 0; draw(); });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, shown.length - 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); draw(); }
      else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); choose(shown[active]); }
      else if (e.key === 'Escape') close();
    });
    const scrimP = h('div', { class: 'overlay', onclick: close });
    palette = h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' }, h('div', { class: 'palette-input' }, icon('search', { size: 'lg' }), inputEl, h('kbd', { class: 'muted' }, 'Esc')), list);
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
      h('ul', {}, h('li', {}, 'Press ', h('kbd', {}, '⌘K'), ' or ', h('kbd', {}, 'Ctrl K'), ' to jump to any page or task.'),
        h('li', {}, 'Changes in reviews save automatically; you will see "Saved" next to the status.'),
        h('li', {}, 'Your ratings, comments and leave reasons are only visible to the people involved.')),
      h('p', { class: 'muted' }, 'Something wrong with your plan, a project or a balance? Contact People Ops.'),
    ] });
  }

  refreshInbox();
  return { main, banner, setPage, refreshInbox };
}
