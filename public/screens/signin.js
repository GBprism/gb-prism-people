// Sign-in: GB brand panel on the left, compact form on the right.
import { h, icon, button, banner } from '/ui.js';

export async function signInScreen({ api }) {
  let cfg = {}; let users = [];
  try { cfg = await api('/api/auth/config'); } catch { /* offline */ }
  if (!cfg.google) { try { users = await api('/api/dev/users'); } catch { /* production */ } }
  const err = new URLSearchParams(location.search).get('error');
  const brand = h('section', { class: 'signin-brand' },
    h('img', { src: '/brand/gb-logo-white.png', alt: 'GB Advisory', class: 'signin-logo' }),
    h('div', { class: 'signin-pitch' },
      h('h1', {}, 'People & Performance'),
      h('p', {}, 'One place for the GB Advisory team to plan goals, complete reviews and request time off — so we keep preparing our clients today for the world of tomorrow.'),
      h('ul', { class: 'signin-points' },
        [['clipboard-check', 'Reviews from plan to development actions'], ['calendar-days', 'Time off and off-site days with live balances'], ['folder-kanban', 'Projects and who contributed what'], ['shield-check', 'Private by design: you only see what is yours to see']]
          .map(([ic, t]) => h('li', {}, icon(ic, { size: 'lg' }), t)))),
    h('p', { class: 'signin-foot' }, 'GB Advisory · Helping you go beyond your limits'));
  const form = h('section', { class: 'signin-form' }, h('div', { class: 'signin-card' },
    h('img', { src: '/brand/gb-mark.png', alt: '', class: 'signin-mark' }),
    h('h2', {}, 'Sign in'),
    err ? banner({ tone: 'danger', title: 'Sign-in did not work', text: err }) : null,
    cfg.google ? [h('p', { class: 'muted' }, `Use your @${cfg.domain} Google Workspace account.`),
      button('Sign in with Google', { variant: 'primary', iconName: 'arrow-right', href: '/auth/google' })]
      : users.length ? [h('p', { class: 'muted' }, 'Development mode — choose a synthetic account.'),
        h('div', { class: 'dev-users' }, users.map((u) => h('button', { class: 'dev-user', type: 'button', onclick: async () => { await api('/api/dev/login', { method: 'POST', body: { userId: u.id } }); location.reload(); } },
          h('span', { class: 'avatar' }, u.name.split(' ').map((x) => x[0]).slice(0, 2).join('')), h('span', {}, h('strong', {}, u.name), h('span', { class: 'muted' }, `${u.roles || 'employee'} · ${u.tenant}`)))))]
        : h('p', { class: 'muted' }, 'Sign-in is not configured. Contact People Ops.'),
    h('p', { class: 'signin-help muted' }, icon('circle-help'), ' Trouble signing in? Contact People Ops.')));
  document.title = 'Sign in · GB Prism';
  return h('div', { class: 'signin' }, brand, form);
}
