// Company profile: the latest deck, live numbers from the library and team, everyone's CV as a
// GB-format slide (PowerPoint, opens in Google Slides), CV updates from employees, and the brand kit.
import { h, icon, button, badge, card, emptyState, field, input, textarea, toast, openDrawer, statStrip, avatar } from '/ui.js';

const DECK = 'https://docs.google.com/presentation/d/1h1tBF3qG3U1YmJwnRGyF53EficVfdNkmK5E31s4xz-0/edit';
const CV_FIELDS = [['public_title', 'Title on the CV'], ['years_experience', 'Years of experience'], ['bio', 'Profile summary'], ['languages', 'Languages'], ['education', 'Education (one per line)'],
  ['certifications', 'Certifications (one per line)'], ['industries', 'Industries (separate with ;)'], ['functions', 'Functional experience (separate with ;)'], ['cv_projects', 'Previous projects — one per line: Client, Country – what you did'], ['linkedin', 'LinkedIn link']];
const LONG = new Set(['bio', 'education', 'certifications', 'cv_projects']);
const complete = (p) => ['bio', 'cv_projects', 'industries', 'functions', 'education'].filter((k) => p[k]).length + (p.photo ? 1 : 0);

export async function companyScreen({ api, me }) {
  const editor = me.roles.includes('partner') || me.roles.includes('people_ops') || me.roles.includes('admin');
  const [team, lib, brand, updates] = await Promise.all([api('/api/team'), api('/api/library').catch(() => null), api('/api/brand').catch(() => []), api('/api/cv-updates').catch(() => [])]);
  const body = h('div', { class: 'stack' });
  const mine = team.find((p) => p.id === me.id) || {};

  function updateMyCv() {
    const ctl = Object.fromEntries(CV_FIELDS.map(([k]) => [k, LONG.has(k) ? textarea({ id: `cv-${k}`, rows: k === 'cv_projects' ? 8 : 3 }, mine[k] || '') : input({ id: `cv-${k}`, value: mine[k] || '' })]));
    openDrawer({ title: 'Update my CV', iconName: 'pencil', body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'People Ops checks the changes before they appear on your CV and in the company profile.'),
      ...CV_FIELDS.map(([k, l]) => field({ label: l, id: `cv-${k}`, control: ctl[k] }))),
    footer: (close) => button('Send for review', { variant: 'primary', iconName: 'send', onClick: async () => {
      const fields = Object.fromEntries(Object.entries(ctl).filter(([k, c]) => (c.value || '') !== (mine[k] || '')).map(([k, c]) => [k, c.value]));
      try { await api('/api/cv-updates', { method: 'POST', body: { fields } }); toast('Sent — People Ops will review'); close(); } catch (e) { toast(e.message, 'danger'); }
    } }) });
  }

  const s = lib?.stats; const years = team.reduce((a, p) => a + (Number.parseFloat(p.years_experience) || 0), 0);
  const pending = updates.filter((u) => u.status === 'pending');
  body.append(
    card({ title: 'Latest company profile', iconName: 'presentation', actions: [h('a', { class: 'btn btn-secondary', href: DECK, target: '_blank', rel: 'noopener' }, icon('external-link'), h('span', {}, 'Open the deck'))],
      body: h('div', { class: 'stack' }, statStrip([{ iconName: 'building-2', value: String(s?.clients_served ?? '—'), label: 'clients served' }, { iconName: 'briefcase', value: String(s?.engagements ?? '—'), label: 'engagements' },
        { iconName: 'users', value: String(team.length), label: 'people' }, { iconName: 'award', value: years ? `${Math.round(years)}+` : '—', label: 'combined years of experience' }]),
      h('p', { class: 'muted' }, 'Numbers update live from the Library and the team. Use them when you refresh the deck; CVs below are generated in the deck’s CV format.')) }),
    card({ title: 'CVs in GB format', iconName: 'id-card', actions: [button('Update my CV', { iconName: 'pencil', onClick: updateMyCv }), me.google_slides ? h('a', { class: 'btn btn-primary', href: '/auth/google/slides?cv=all', target: '_blank', rel: 'noopener' }, icon('presentation'), h('span', {}, 'All CVs in Google Slides')) : null,
      h('a', { class: 'btn btn-ghost', href: '/api/cv/all', title: 'Download as PowerPoint' }, icon('download'), h('span', {}, '.pptx'))],
      body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Open in Google Slides creates the CV as a Google Slides file in your own Drive and opens it (the first time, Google asks you to allow this). The download button gives a PowerPoint file instead.'),
        h('ul', { class: 'eng-list' }, team.map((p) => h('li', { class: 'eng-item' },
          h('div', { class: 'team-head' }, avatar(p, 'sm'), h('div', {}, h('strong', {}, p.name), h('div', { class: 'muted' }, p.public_title || p.title || ''))),
          h('div', { class: 'eng-side' }, badge(`${complete(p)}/6 CV parts`, complete(p) >= 5 ? 'success' : 'warning'), me.google_slides ? h('a', { class: 'btn btn-secondary btn-sm', href: `/auth/google/slides?cv=${p.id}`, target: '_blank', rel: 'noopener' }, icon('presentation'), h('span', {}, 'Open in Google Slides')) : null,
            h('a', { class: 'btn btn-ghost btn-sm', href: `/api/cv/${p.id}`, title: `Download ${p.name}’s CV as PowerPoint`, 'aria-label': `Download ${p.name}’s CV as PowerPoint` }, icon('download'))))))) }),
    editor ? card({ title: 'CV updates to review', iconName: 'user-check', actions: badge(`${pending.length} waiting`, pending.length ? 'info' : 'neutral'),
      body: pending.length ? h('ul', { class: 'eng-list' }, pending.map((u) => h('li', { class: 'eng-item' }, h('div', { class: 'eng-main' }, h('strong', {}, u.name),
        h('dl', { class: 'kv' }, Object.entries(u.fields).map(([k, v]) => [h('dt', {}, CV_FIELDS.find(([f]) => f === k)?.[1] || k), h('dd', { class: 'eng-scope' }, v || '—')]))),
      h('div', { class: 'eng-side' }, button('Apply', { size: 'sm', variant: 'primary', iconName: 'check', onClick: async () => { await api(`/api/cv-updates/${u.id}/decide`, { method: 'POST', body: { decision: 'apply' } }); toast('Applied'); location.reload(); } }),
        button('Reject', { size: 'sm', variant: 'ghost', onClick: async () => { await api(`/api/cv-updates/${u.id}/decide`, { method: 'POST', body: { decision: 'reject' } }); toast('Rejected'); location.reload(); } }))))) : emptyState({ iconName: 'check', title: 'Nothing waiting' }) }) : null,
    card({ title: 'Brand kit', iconName: 'palette', body: brand.length ? h('div', { class: 'brand-grid' }, brand.map((b) => h('div', { class: 'brand-tile' },
      h('img', { src: `/api/brand/${b.id}`, alt: `${b.label}: ${b.variant || ''}`, loading: 'lazy' }), h('strong', {}, b.label), h('span', { class: 'muted' }, [b.variant, b.orientation].filter(Boolean).join(' · ')),
      h('a', { class: 'btn btn-secondary btn-sm', href: `/api/brand/${b.id}?download=1` }, icon('download'), h('span', {}, `Download ${b.mime.split('/')[1].toUpperCase()}`))))) : emptyState({ iconName: 'palette', title: 'Logos appear here once loaded' }) }));
  const root = h('div', { class: 'stack' }, ...[...body.children]); root.modern = true;
  return root;
}
