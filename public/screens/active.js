// Active projects: every running engagement with its dates, client, scope, lead, team, Drive and chat links.
import { h, icon, badge, card, emptyState, filterChips, avatar, input } from '/ui.js';

const fmt = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null);
const left = (end) => { if (!end) return null; const d = Math.ceil((Date.parse(`${end}T00:00:00`) - Date.now()) / 864e5); return d < 0 ? 'past end date' : d <= 30 ? `${d} days left` : null; };

export async function activeScreen({ api }) {
  const [list, team] = await Promise.all([api('/api/active-projects'), api('/api/team').catch(() => [])]);
  const person = (m) => team.find((t) => t.id === m.id) || m;
  let filter = 'all'; let q = '';
  const wrap = h('div', { class: 'active-grid' });
  const draw = () => {
    const rows = list.filter((p) => (filter === 'all' || p.mine) && (!q || `${p.name} ${p.client_name || ''} ${p.lead_name || ''} ${p.team.map((m) => m.name).join(' ')}`.toLowerCase().includes(q)));
    wrap.replaceChildren(...(rows.length ? rows.map((p) => card({ title: p.name, iconName: 'briefcase',
      actions: [p.mine ? badge('You are on it', 'info') : null, left(p.end_date) ? badge(left(p.end_date), 'warning') : null],
      body: h('div', { class: 'stack' },
        h('div', { class: 'eng-meta muted' }, p.client_name ? h('span', {}, icon('building-2'), ` ${p.client_name}`) : null, p.country ? h('span', {}, icon('map-pin'), ` ${p.country}`) : null,
          h('span', {}, icon('calendar-days'), ` ${fmt(p.start_date) || 'Start not set'} → ${fmt(p.end_date) || 'ongoing'}`), p.service_line ? h('span', {}, icon('target'), ` ${p.service_line}`) : null),
        p.scope_en || p.title_en ? h('p', { class: 'eng-scope' }, p.scope_en || p.title_en) : null,
        h('div', { class: 'active-people' }, h('span', { class: 'muted' }, 'Lead'), h('strong', {}, p.lead_name || 'to be set')),
        p.team.length ? h('ul', { class: 'avatar-row', 'aria-label': 'Team' }, p.team.map((m) => h('li', { title: `${m.name}${m.role ? ` — ${m.role}` : ''}` }, avatar(person(m), 'sm'), h('span', {}, m.name.split(' ')[0])))) : h('p', { class: 'muted' }, 'No team recorded yet'),
        h('div', { class: 'row' }, p.drive_url ? h('a', { class: 'btn btn-secondary btn-sm', href: p.drive_url, target: '_blank', rel: 'noopener' }, icon('folder-open'), h('span', {}, 'Drive')) : null,
          p.chat_url ? h('a', { class: 'btn btn-ghost btn-sm', href: p.chat_url, target: '_blank', rel: 'noopener' }, icon('messages-square'), h('span', {}, 'Chat')) : null,
          p.meet_url ? h('a', { class: 'btn btn-ghost btn-sm', href: p.meet_url, target: '_blank', rel: 'noopener' }, icon('video'), h('span', {}, 'Meet')) : null,
          h('a', { class: 'btn btn-ghost btn-sm', href: `#/projects?p=${p.id}` }, icon('list-checks'), h('span', {}, 'Deliverables')))) }))
      : [emptyState({ iconName: 'briefcase', title: 'No active projects match' })]));
  };
  const chips = filterChips([{ value: 'all', label: 'All active', count: list.length }, { value: 'mine', label: 'Mine', count: list.filter((p) => p.mine).length }], filter, (v) => { filter = v; draw(); });
  draw();
  const root = h('div', { class: 'stack' }, h('div', { class: 'toolbar' }, chips, input({ type: 'search', class: 'input input-sm library-search', placeholder: 'Search project, client or person', 'aria-label': 'Search active projects', oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } })), wrap);
  root.modern = true;
  return root;
}
