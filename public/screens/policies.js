// Policies: GB policies (starting with the AI / Claude usage rules), each with a summary, the key
// rules and the source document. Everyone acknowledges; partners and People Ops see who has.
import { h, icon, button, badge, card, emptyState, toast, openDrawer } from '/ui.js';

export async function policiesScreen({ api, me }) {
  const editor = me.roles.includes('partner') || me.roles.includes('people_ops') || me.roles.includes('admin');
  const root = h('div', { class: 'stack' });
  async function draw() {
    const list = await api('/api/policies');
    const todo = list.filter((p) => p.requires_ack && !p.acked).length;
    const cats = [...new Set(list.map((p) => p.category))];
    root.replaceChildren(
      todo ? h('p', { class: 'callout' }, icon('info'), ` ${todo} polic${todo === 1 ? 'y needs' : 'ies need'} your acknowledgement.`) : null,
      ...(list.length ? cats.map((c) => h('section', { class: 'stack' }, h('h2', { class: 'kv-head' }, c === 'AI' ? 'AI and Claude usage' : c),
        ...list.filter((p) => p.category === c).map((p) => card({ title: p.title, iconName: 'book-open-check',
          actions: [p.acked ? badge('Acknowledged', 'success') : p.requires_ack ? badge('To acknowledge', 'warning') : null,
            editor ? button(`Who (${p.ack_count})`, { size: 'sm', variant: 'ghost', iconName: 'users', onClick: async () => {
              const rows = await api(`/api/policies/${p.key}/acks`);
              openDrawer({ title: p.title, iconName: 'users', body: h('ul', { class: 'check-list' }, rows.map((r) => h('li', {}, icon(r.acked_at ? 'circle-check' : 'circle'), ` ${r.name}`, r.acked_at ? h('span', { class: 'muted' }, ` · ${new Date(r.acked_at).toLocaleDateString('en-GB')}`) : null))) });
            } }) : null],
          body: h('div', { class: 'stack' }, h('div', { class: 'eng-meta muted' }, p.version ? h('span', {}, `Version ${p.version}`) : null, p.applies_to ? h('span', {}, `Applies to: ${p.applies_to}`) : null),
            p.summary ? h('p', {}, p.summary) : null, p.rules.length ? h('ol', { class: 'policy-rules' }, p.rules.map((r) => h('li', {}, r))) : null,
            h('div', { class: 'row' }, p.source_url ? h('a', { class: 'btn btn-secondary btn-sm', href: p.source_url, target: '_blank', rel: 'noopener' }, icon('external-link'), h('span', {}, 'Full document')) : null,
              !p.acked && p.requires_ack ? button('I have read this and will follow it', { variant: 'primary', size: 'sm', iconName: 'check', onClick: async () => { await api(`/api/policies/${p.key}/ack`, { method: 'POST' }); toast('Acknowledged'); draw(); } }) : null)) }))))
        : [emptyState({ iconName: 'book-open-check', title: 'No policies loaded yet' })]));
  }
  await draw(); root.modern = true;
  return root;
}
