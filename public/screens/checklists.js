// Checklists: the general checklists every deliverable passes, and the checklist for each type of
// document. Deliverables are submitted from the Projects page after ticking the relevant ones.
import { h, icon, badge, card, emptyState, filterChips } from '/ui.js';

export async function checklistsScreen({ api }) {
  const lists = await api('/api/checklists');
  let filter = 'all';
  const types = [...new Set(lists.filter((c) => c.kind === 'specific').map((c) => c.deliverable_type))];
  const wrap = h('div', { class: 'stack' });
  const one = (c) => card({ title: c.title, iconName: c.kind === 'general' ? 'list-checks' : 'list-todo',
    actions: [badge(c.kind === 'general' ? 'Every deliverable' : c.deliverable_type, c.kind === 'general' ? 'info' : 'neutral'),
      c.source_url ? h('a', { class: 'btn btn-ghost btn-sm', href: c.source_url, target: '_blank', rel: 'noopener' }, icon('external-link'), h('span', {}, 'Source')) : null],
    body: h('ol', { class: 'policy-rules' }, c.items.map((i) => h('li', {}, i))) });
  const draw = () => wrap.replaceChildren(...(lists.filter((c) => filter === 'all' || (filter === 'general' ? c.kind === 'general' : c.deliverable_type === filter)).map(one)));
  const chips = filterChips([{ value: 'all', label: 'All', count: lists.length }, { value: 'general', label: 'General', count: lists.filter((c) => c.kind === 'general').length },
    ...types.map((t) => ({ value: t, label: t, count: lists.filter((c) => c.deliverable_type === t).length }))], filter, (v) => { filter = v; draw(); });
  draw();
  const root = h('div', { class: 'stack' },
    h('p', { class: 'callout' }, icon('info'), ' Before you submit a deliverable (Projects → the deliverable → Submit for review) you confirm every item of the general checklists and of the checklist for that type of document.'),
    lists.length ? h('div', { class: 'toolbar' }, chips) : null, lists.length ? wrap : emptyState({ iconName: 'list-todo', title: 'No checklists loaded yet' }));
  root.modern = true;
  return root;
}
