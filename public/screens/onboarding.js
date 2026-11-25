// Onboarding: the documents a new joiner receives, reads and signs, in order. The joiner ticks
// their own steps; People Ops and partners track everyone and tick HR steps.
import { h, icon, button, badge, card, emptyState, select, toast } from '/ui.js';

const STAGE = { before_day1: 'Before day 1', day1: 'Day 1', week1: 'First week', month1: 'First month' };
const OWNER = { new_joiner: 'You', hr: 'People Ops', manager: 'Your manager' };
const ACTION = { read: 'Read', sign: 'Sign', fill: 'Fill in', setup: 'Set up' };

export async function onboardingScreen({ api }) {
  const root = h('div', { class: 'stack' });
  let who = 'me';
  async function draw() {
    const v = await api(`/api/onboarding/${who}`);
    const done = v.items.filter((i) => i.done_at).length;
    const picker = v.people ? select([['me', 'Me'], ...v.people.map((p) => [p.id, `${p.name}${p.hire_date ? ` · joined ${p.hire_date}` : ''} (${p.done}/${v.total})`])], { 'aria-label': 'Whose onboarding', class: 'select select-sm', onchange: (e) => { who = e.target.value; draw(); } }) : null;
    if (picker) picker.value = who;
    const stages = Object.keys(STAGE).filter((s) => v.items.some((i) => i.stage === s));
    root.replaceChildren(
      h('div', { class: 'toolbar' }, h('div', { class: 'stack' }, h('strong', {}, `${done} of ${v.total} steps done`), h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': done, 'aria-valuemin': 0, 'aria-valuemax': v.total }, h('span', { style: null, 'data-w': '' }))), picker),
      ...(v.items.length ? stages.map((s) => card({ title: STAGE[s], iconName: 'list-checks', body: h('ul', { class: 'eng-list' }, v.items.filter((i) => i.stage === s).map((i) => {
        const canTick = v.canManage || i.owner === 'new_joiner';
        return h('li', { class: 'eng-item' }, h('div', { class: 'eng-main' }, h('strong', {}, i.title),
          h('div', { class: 'eng-meta muted' }, h('span', {}, `${ACTION[i.action] || i.action} · ${OWNER[i.owner] || i.owner}`)), i.purpose ? h('p', { class: 'eng-scope' }, i.purpose) : null),
        h('div', { class: 'eng-side' }, i.source_url ? h('a', { class: 'btn btn-secondary btn-sm', href: i.source_url, target: '_blank', rel: 'noopener' }, icon('external-link'), h('span', {}, 'Template')) : null,
          i.done_at ? badge('Done', 'success') : null,
          canTick ? button(i.done_at ? 'Undo' : 'Mark done', { size: 'sm', variant: i.done_at ? 'ghost' : 'primary', iconName: i.done_at ? 'rotate-ccw' : 'check', onClick: async () => { await api(`/api/onboarding/${who}/${i.id}`, { method: 'POST', body: { done: !i.done_at } }); toast(i.done_at ? 'Reopened' : 'Done'); draw(); } }) : null));
      })) })) : [emptyState({ iconName: 'user-plus', title: 'No onboarding steps loaded yet' })]));
    const bar = root.querySelector('.progress > span'); if (bar) bar.style.inlineSize = `${v.total ? Math.round((done / v.total) * 100) : 0}%`;
  }
  await draw(); root.modern = true;
  return root;
}
