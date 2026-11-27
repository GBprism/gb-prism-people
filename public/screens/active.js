// My Work → Projects: the engagements you are on, then everything running at GB.
// Each project opens its detail page (#/project/:id), the one place for a project's information.
import { h, icon, badge, emptyState, filterChips, input, avatar } from '/ui.js';

const d0 = (s) => new Date(`${s}T00:00:00`);
const fmt = (s) => (s ? d0(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null);
const fmtShort = (s) => d0(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const cap = (s) => (s ? s.replace(/^\w/, (c) => c.toUpperCase()) : s);

export async function activeScreen({ api }) {
  const [list, week, team] = await Promise.all([api('/api/active-projects'), api('/api/my-week').catch(() => ({ projects: [] })), api('/api/team').catch(() => [])]);
  const photo = (m) => team.find((t) => t.id === m.id) || m;
  const mineIds = new Set(week.projects.map((p) => p.id));

  const mine = week.projects.length ? h('section', { 'aria-labelledby': 'mine-h', class: 'stack-sm' }, h('h2', { id: 'mine-h', class: 'section-title' }, 'Your engagements'),
    h('div', { class: 'eng-cards' }, week.projects.map((p) => h('a', { class: 'eng-card', href: `#/project/${p.id}` },
      h('span', { class: 'eng-card-client' }, p.client || 'Client not recorded'),
      h('strong', { class: 'eng-card-name' }, p.name),
      h('span', { class: 'muted' }, [p.role ? cap(p.role) : null, p.lead_name && !p.is_lead ? `Lead ${p.lead_name}` : null].filter(Boolean).join(' · ')),
      h('span', { class: 'eng-card-next' }, p.next ? [h('span', { class: 'muted' }, 'Next'), h('span', {}, p.next.title), h('span', { class: 'proj-date' }, fmtShort(p.next.date))] : h('span', { class: 'muted' }, 'No dated milestone')))))) : null;

  let filter = 'all'; let q = '';
  const ul = h('ul', { class: 'proj-list' });
  const draw = () => {
    const rows = list.filter((p) => (filter === 'all' || (filter === 'mine' ? mineIds.has(p.id) || p.mine : !mineIds.has(p.id) && !p.mine)) && (!q || `${p.name} ${p.client_name || ''} ${p.lead_name || ''} ${p.team.map((m) => m.name).join(' ')}`.toLowerCase().includes(q)));
    ul.replaceChildren(...(rows.length ? rows.map((p) => h('li', {}, h('a', { class: 'proj-row', href: `#/project/${p.id}` },
      h('span', { class: 'proj-name' }, h('strong', {}, p.name), h('span', { class: 'muted' }, [p.client_name, p.lead_name ? `Lead ${p.lead_name}` : 'Lead to be set'].filter(Boolean).join(' · '))),
      h('span', { class: 'proj-faces' }, h('span', { class: 'face-stack' }, p.team.slice(0, 4).map((m) => avatar(photo(m), 'sm'))), p.team.length > 4 ? h('span', { class: 'muted' }, `+${p.team.length - 4}`) : null),
      h('span', { class: 'proj-next' }, p.end_date ? [h('span', { class: 'muted' }, 'Ends'), h('span', {}, fmt(p.end_date))] : h('span', { class: 'muted' }, 'Ongoing')),
      p.mine ? badge('You', 'info') : h('span'), icon('chevron-right', { flip: true }))))
      : [h('li', {}, emptyState({ iconName: 'briefcase', title: 'No running projects match' }))]));
  };
  draw();
  const all = h('section', { class: 'card', 'aria-labelledby': 'all-h' },
    h('header', { class: 'card-header' }, h('h2', { id: 'all-h' }, 'Running at GB'), h('div', { class: 'card-actions' },
      filterChips([{ value: 'all', label: 'All', count: list.length }, { value: 'mine', label: 'Mine', count: list.filter((p) => p.mine).length }, { value: 'others', label: 'Others' }], filter, (x) => { filter = x; draw(); }),
      input({ type: 'search', class: 'input input-sm library-search', placeholder: 'Project, client or person', 'aria-label': 'Search running projects', oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } }))),
    h('div', { class: 'card-body flush' }, ul));
  const root = h('div', { class: 'stack' }, mine, all,
    h('p', { class: 'muted' }, icon('info'), ' Deliverables, contributions and the full project register are under ', h('a', { href: '#/projects' }, 'Deliverables & contributions'), '.'));
  root.modern = true;
  return root;
}
