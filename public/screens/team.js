// Team: who is who at GB Advisory, for everyone in the workspace. Photos and facts from the
// company profile only (title, experience, education, CV summary, past projects) — never HR data.
import { h, icon, avatar, card, emptyState, filterChips, openDrawer, button } from '/ui.js';

// GB Advisory Company Profile (Jan 2026)
const ABOUT = {
  vision: 'Bringing world class, authentic and integrated advisory services that combine business with psychology and organizational behaviour.',
  mission: 'To prepare our clients today for the world of tomorrow.',
  values: ['We put ethics first, always', 'We give quality and authentic advice', 'We treat the client’s business as our own'],
  services: ['Strategic Planning and Growth', 'Business Process Re-engineering', 'HR Transformation', 'Operating Model and Governance', 'AI Readiness and Strategy'],
};
const LEVEL = (t = '') => (/partner|director/i.test(t) ? 'Leadership' : /assistant manager/i.test(t) ? 'Assistant Managers' : /senior/i.test(t) ? 'Senior Consultants' : 'Consultants');
const list = (s) => String(s || '').split(/;\s*/).map((x) => x.trim()).filter(Boolean);

export async function teamScreen({ api, me }) {
  const people = await api('/api/team');
  const canHr = me.nav?.people;
  let filter = 'all';
  const grid = h('div', { class: 'team-grid' });
  const groups = ['Leadership', 'Assistant Managers', 'Senior Consultants', 'Consultants'];
  const order = (p) => groups.indexOf(LEVEL(p.public_title || p.title));
  const draw = () => grid.replaceChildren(...people.filter((p) => filter === 'all' || LEVEL(p.public_title || p.title) === filter).sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    .map((p) => h('button', { class: 'team-card', type: 'button', onclick: () => open(p), 'aria-label': `${p.name}, ${p.public_title || p.title || ''}` },
      avatar(p, 'lg'), h('strong', {}, p.name), h('span', { class: 'muted' }, p.public_title || p.title || ''),
      p.years_at_gb ? h('span', { class: 'team-years' }, icon('award'), ` ${p.years_at_gb} ${p.years_at_gb === 1 ? 'year' : 'years'} at GB`) : null)));
  const open = (p) => openDrawer({ title: p.name, iconName: 'user', body: h('div', { class: 'stack' },
    h('div', { class: 'team-head' }, avatar(p, 'xl'), h('div', { class: 'stack' }, h('strong', {}, p.public_title || p.title || ''), h('a', { href: `mailto:${p.email}` }, icon('mail'), ` ${p.email}`),
      p.years_at_gb ? h('span', { class: 'muted' }, `${p.years_at_gb} ${p.years_at_gb === 1 ? 'year' : 'years'} at GB Advisory (since ${new Date(`${p.hire_date}T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })})`) : null,
      p.years_experience ? h('span', { class: 'muted' }, `${p.years_experience} years of experience in total`) : null)),
    p.bio ? h('p', {}, p.bio) : null,
    h('dl', { class: 'kv' }, p.expertise ? [h('dt', {}, 'Experience'), h('dd', {}, p.expertise)] : null, p.education ? [h('dt', {}, 'Education'), h('dd', {}, p.education)] : null,
      p.certifications ? [h('dt', {}, 'Certifications'), h('dd', {}, p.certifications)] : null),
    list(p.industries).length ? h('div', {}, h('h3', { class: 'kv-head' }, 'Industries'), h('ul', { class: 'chip-list' }, list(p.industries).map((x) => h('li', { class: 'tag' }, x)))) : null,
    list(p.functions).length ? h('div', {}, h('h3', { class: 'kv-head' }, 'Functional experience'), h('ul', { class: 'chip-list' }, list(p.functions).map((x) => h('li', { class: 'tag tag-info' }, x)))) : null,
    p.cv_projects ? h('div', {}, h('h3', { class: 'kv-head' }, 'Previous projects'), h('ul', { class: 'bullets' }, p.cv_projects.split('\n').filter(Boolean).map((x) => h('li', {}, x)))) : null,
    !p.bio && !p.cv_projects ? h('p', { class: 'muted' }, 'A fuller CV appears here once it is added to the company profile.') : null),
  footer: () => [p.id !== me.id ? button('Message', { iconName: 'messages-square', onClick: async () => { const { id } = await api('/api/messages/direct', { method: 'POST', body: { userId: p.id } }); location.hash = `#/messages?c=${id}`; } }) : button('Edit my profile', { iconName: 'pencil', href: '#/profile' }),
    canHr ? button('Open HR profile', { iconName: 'id-card', href: '#/people' }) : null].filter(Boolean) });
  draw();
  const counts = Object.fromEntries(groups.map((g) => [g, people.filter((p) => LEVEL(p.public_title || p.title) === g).length]));
  const chips = filterChips([{ value: 'all', label: 'Everyone', count: people.length }, ...groups.filter((g) => counts[g]).map((g) => ({ value: g, label: g, count: counts[g] }))], 'all', (v) => { filter = v; draw(); });
  const root = h('div', { class: 'stack' },
    card({ title: 'About GB Advisory', iconName: 'building-2', body: h('div', { class: 'about-gb' },
      h('div', {}, h('h3', {}, 'Mission'), h('p', {}, ABOUT.mission)), h('div', {}, h('h3', {}, 'Vision'), h('p', {}, ABOUT.vision)),
      h('div', {}, h('h3', {}, 'Values'), h('ul', {}, ABOUT.values.map((v) => h('li', {}, v)))), h('div', {}, h('h3', {}, 'Service lines'), h('ul', {}, ABOUT.services.map((v) => h('li', {}, v))))) }),
    card({ title: `Our team (${people.length})`, iconName: 'users', actions: chips, body: people.length ? grid : emptyState({ iconName: 'users', title: 'No one here yet' }) }));
  root.modern = true;
  return root;
}
