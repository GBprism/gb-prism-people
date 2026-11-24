// Home: greeting, Your Tasks (every pending action, deep-linked), key numbers,
// Portfolio strip (partners/admins), Your Apps launcher. Read-only: uses
// /api/home, /api/inbox, /api/ai/seats/mine and /api/projects.
import { h, icon, button, badge, statStrip, emptyState, filterChips } from '/ui.js';
import { appsFor } from '/shell.js';

const APP = {
  reviews: { label: 'Reviews', icon: 'clipboard-check' },
  timeoff: { label: 'Time off', icon: 'calendar-days' },
  projects: { label: 'Projects', icon: 'folder-kanban' },
  ai: { label: 'AI examples', icon: 'sparkles' },
  questions: { label: 'Questions', icon: 'messages-square' },
};
const VERB = { 'Approve plan': ['Approve plan', 'reviews'], 'Manager review': ['Review', 'reviews'], Calibrate: ['Calibrate', 'reviews'], 'Hold 1:1 and agree actions': ['Hold 1:1', 'reviews'],
  'Close review': ['Close review', 'reviews'], 'Time-off request': ['Decide', 'timeoff'], 'Off-site request': ['Decide', 'timeoff'], 'Project feedback': ['Give feedback', 'reviews'],
  'Confirm contribution': ['Confirm', 'projects'], 'Confirm team': ['Confirm team', 'projects'], 'Approve projects': ['Approve', 'projects'], 'Confirm lead’s work': ['Confirm', 'projects'], Clarification: ['Answer', 'questions'] };
const todayAmman = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(new Date());
const hourAmman = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Amman', hour: 'numeric', hour12: false }).format(new Date()));
const fmtDue = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function buildTasks({ home, inbox, seats }) {
  const tasks = [];
  const n = home.next;
  if (n?.link) tasks.push({ title: n.label, app: 'reviews', due: n.due || null, link: n.link });
  for (const i of inbox) {
    const [verb, app] = VERB[i.kind] || [i.kind, 'reviews'];
    tasks.push({ title: `${verb}: ${i.title}`, app, due: i.due || null, link: i.link, note: i.warnings ? `${i.warnings} warning${i.warnings === 1 ? '' : 's'}` : null });
  }
  for (const a of home.development_actions || []) tasks.push({ title: `Development action: ${a.title}`, app: 'reviews', due: a.due_date || null, link: '#/history' });
  const pendingSeats = (seats || []).filter((s) => s.status === 'candidate').length;
  if (pendingSeats) tasks.push({ title: `Confirm: ${pendingSeats} AI seat usage record${pendingSeats === 1 ? '' : 's'}`, app: 'ai', due: null, link: '#/ai' });
  const t = todayAmman();
  for (const x of tasks) x.overdue = !!(x.due && x.due < t);
  return tasks.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.due || '9999').localeCompare(b.due || '9999'));
}

export async function homeScreen({ api, me }) {
  const [home, inboxRes, seats] = await Promise.all([api('/api/home'), api('/api/inbox').catch(() => ({ items: [] })), api('/api/ai/seats/mine').catch(() => [])]);
  const isPartner = me.roles.includes('partner') || me.roles.includes('admin');
  const projects = isPartner ? await api('/api/projects').catch(() => []) : [];
  const tasks = buildTasks({ home, inbox: inboxRes.items || [], seats });
  const first = me.name.split(' ')[0];
  const hr = hourAmman();
  const greeting = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  let filter = 'all'; let q = '';

  // ---- greeting row with search
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search tasks and apps', 'aria-label': 'Search tasks and apps', oninput: (e) => { q = e.target.value.trim().toLowerCase(); drawTasks(); drawApps(); } });
  const head = h('header', { class: 'home-head' },
    h('div', {}, h('h1', {}, `${greeting}, ${first}`), h('p', { class: 'page-desc' }, [me.title, new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Amman' })].filter(Boolean).join(' · '))),
    h('div', { class: 'home-search' }, icon('search'), search));

  // ---- key numbers
  const av = home.balances.find((b) => b.type === 'AV');
  const plan = home.plans.find((p) => !['closed'].includes(p.state)) || home.plans.at(-1);
  const stats = statStrip([
    { iconName: 'list-checks', value: String(tasks.length), label: tasks.length === 1 ? 'task waiting for you' : 'tasks waiting for you', trend: tasks.some((t) => t.overdue) ? { dir: 'down', text: `${tasks.filter((t) => t.overdue).length} overdue` } : null },
    { iconName: 'calendar-days', value: av ? av.posted : '—', label: 'annual leave days left' },
    { iconName: 'house', value: `${home.offsite.used}/${home.offsite.quota}`, label: 'off-site days this month' },
    { iconName: 'clipboard-check', value: plan ? plan.stateLabel : 'No plan', label: plan ? plan.cycle : 'Performance' },
  ]);
  stats.classList.add('home-stats');

  // ---- your tasks
  const taskList = h('ul', { class: 'task-list', 'aria-label': 'Your tasks' });
  const apps = [...new Set(tasks.map((t) => t.app))];
  const chips = apps.length > 1 ? filterChips([{ value: 'all', label: 'All', count: tasks.length }, ...apps.map((a) => ({ value: a, label: APP[a]?.label || a, iconName: APP[a]?.icon, count: tasks.filter((t) => t.app === a).length }))], 'all', (v) => { filter = v; drawTasks(); }) : null;
  function drawTasks() {
    const shown = tasks.filter((t) => (filter === 'all' || t.app === filter) && (!q || t.title.toLowerCase().includes(q)));
    if (!tasks.length) return taskList.replaceChildren(h('li', {}, emptyState({ iconName: 'party-popper', title: 'You’re all caught up', text: 'New reviews, approvals and requests will appear here.' })));
    if (!shown.length) return taskList.replaceChildren(h('li', { class: 'task-none muted' }, 'No tasks match your search.'));
    taskList.replaceChildren(...shown.map((t) => h('li', {}, h('a', { class: `task${t.overdue ? ' is-overdue' : ''}`, href: t.link },
      h('span', { class: 'task-app', title: APP[t.app]?.label }, icon(APP[t.app]?.icon || 'circle-dot', { size: 'lg' })),
      h('span', { class: 'task-title' }, t.title, t.note ? h('span', { class: 'muted' }, ` · ${t.note}`) : null),
      t.overdue ? badge('Overdue', 'danger', 'clock') : null,
      h('span', { class: 'task-due' }, t.due ? [icon('calendar-days'), fmtDue(t.due)] : h('span', { class: 'muted' }, 'No due date')),
      icon('chevron-right', { flip: true })))));
  }
  drawTasks();
  const tasksCard = h('section', { class: 'card' }, h('header', { class: 'card-header' }, h('h2', {}, icon('list-checks', { size: 'lg' }), 'Your tasks'), chips ? h('div', { class: 'card-actions' }, chips) : null), h('div', { class: 'card-body flush' }, taskList));

  // ---- portfolio (partners and admins)
  let portfolio = null;
  if (isPartner) {
    const active = projects.filter((p) => p.register_status === 'approved' && p.status === 'active');
    const awaiting = projects.reduce((a, p) => a + p.team_unconfirmed.length, 0);
    portfolio = h('section', { class: 'card' }, h('header', { class: 'card-header' }, h('h2', {}, icon('briefcase', { size: 'lg' }), 'Portfolio'),
      h('div', { class: 'card-actions' }, awaiting ? badge(`${awaiting} to confirm`, 'warning', 'user') : null, button('All projects', { variant: 'ghost', size: 'sm', iconName: 'arrow-right', href: '#/projects' }))),
      h('div', { class: 'card-body' }, active.length ? h('div', { class: 'portfolio' }, active.slice(0, 8).map((p) => {
        const dl = p.deliverables; const accepted = dl.filter((d) => ['accepted', 'approved'].includes(d.status)).length;
        return h('a', { class: 'portfolio-item', href: '#/projects' }, h('strong', {}, p.name), h('span', { class: 'muted' }, `${p.kind === 'proposal' ? 'Proposal' : 'Engagement'} · Lead ${p.lead_name || '—'}`),
          h('span', { class: 'portfolio-meta' }, icon('users'), `${p.team_confirmed.length} confirmed`, icon('file-check-2'), `${accepted}/${dl.length} deliverables accepted`),
          p.end_date ? h('span', { class: 'portfolio-meta' }, icon('calendar-days'), `Ends ${fmtDue(p.end_date)}`) : null);
      })) : emptyState({ iconName: 'briefcase', title: 'No active projects', text: 'Approved engagements and proposals appear here.', action: button('Open projects', { variant: 'primary', iconName: 'folder-kanban', href: '#/projects' }) })));
  }

  // ---- your apps
  const appsWrap = h('div', { class: 'app-groups' });
  const badgeFor = { inbox: (inboxRes.items || []).length, history: tasks.filter((t) => t.app === 'reviews' && t.link.startsWith('#/review')).length, ai: tasks.filter((t) => t.app === 'ai').length };
  function drawApps() {
    const groups = appsFor(me).filter((g) => g.items.some((p) => p.key !== 'home'));
    appsWrap.replaceChildren(...groups.map((g) => {
      const items = g.items.filter((p) => p.key !== 'home' && (!q || `${p.title} ${p.desc || ''}`.toLowerCase().includes(q)));
      return items.length ? h('div', { class: 'app-group' }, h('h3', { class: 'app-group-label' }, g.group), h('div', { class: 'app-grid' }, items.map((p) => h('a', { class: 'app-tile', href: p.href, title: p.desc || p.title },
        h('span', { class: 'app-icon' }, icon(p.icon, { size: 'lg' }), badgeFor[p.key] ? h('span', { class: 'app-badge', 'aria-label': `${badgeFor[p.key]} open` }, String(badgeFor[p.key])) : null),
        h('span', { class: 'app-label' }, p.title))))) : null;
    }).filter(Boolean));
    if (!appsWrap.children.length) appsWrap.append(h('p', { class: 'muted' }, 'No apps match your search.'));
  }
  drawApps();
  const appsCard = h('section', { class: 'card' }, h('header', { class: 'card-header' }, h('h2', {}, icon('layout-dashboard', { size: 'lg' }), 'Your apps')), h('div', { class: 'card-body' }, appsWrap));

  const root = h('div', { class: 'home' }, head, stats, h('div', { class: 'home-main' }, tasksCard, portfolio), appsCard);
  root.modern = true; root.noHeader = true;
  return root;
}
