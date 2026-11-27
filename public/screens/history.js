// My reviews: every cycle with its stage and outcome, and starting next year's plan.
import { h, icon, button, badge, card, emptyState, dataTable, field, select, toast } from '/ui.js';

const TONE = { closed: 'success', acknowledged: 'success', released: 'info', partner_calibration: 'info', manager_review: 'warning', self_assessment: 'warning', approved_plan: 'info', draft_plan: 'warning' };

export async function historyScreen({ api }) {
  const [plans, cycles, templates] = await Promise.all([api('/api/my/plans'), api('/api/cycles'), api('/api/templates')]);
  const root = h('div', { class: 'stack' });
  root.modern = true;
  root.append(h('a', { class: 'growth-cv', href: '#/profile?edit=1' }, h('span', { class: 'attn-icon', 'aria-hidden': 'true' }, icon('id-card')),
    h('span', { class: 'attn-text' }, h('strong', {}, 'Keep your profile and CV current'), h('span', { class: 'muted' }, 'Add new projects, certifications and skills — People Ops approves, then your GB CV slide updates')),
    h('span', { class: 'text-link' }, 'Edit my profile & CV', icon('arrow-right'))));
  root.append(card({ title: 'Your reviews', iconName: 'clipboard-check', flush: !!plans.length, body: plans.length ? dataTable({ rows: plans, columns: [
    { key: 'cycle', label: 'Cycle', render: (p) => h('a', { href: `#/review/${p.id}` }, p.cycle), sortValue: (p) => p.year },
    { key: 'stateLabel', label: 'Stage', render: (p) => badge(p.stateLabel, TONE[p.state] || 'neutral') },
    { key: 'open', label: '', sortable: false, render: (p) => button('Open', { size: 'sm', variant: 'ghost', iconName: 'arrow-right', href: `#/review/${p.id}` }) },
  ] }) : emptyState({ iconName: 'clipboard-check', title: 'No reviews yet', text: 'Your plan and reviews appear here once your reviewer sets them up.' }) }));

  const planning = cycles.filter((c) => c.status === 'planning' && !plans.find((p) => p.year === c.year));
  const prior = plans.find((p) => ['closed', 'acknowledged'].includes(p.state) && p.cycle_status !== 'historical');
  let carry = [];
  let carryItems = [];
  if (prior && planning.length) carryItems = (await api(`/api/plans/${prior.id}`)).items;
  for (const c of planning) {
    const tpl = select(templates.map((t) => [t.id, `${t.role_family.replace(/_/g, ' ')} v${t.version}${t.status !== 'approved' ? ' (draft)' : ''}`]), { id: `tpl_${c.id}` });
    root.append(card({ title: `Start your ${c.name}`, iconName: 'target', body: h('div', { class: 'stack' },
      field({ label: 'Role template', id: `tpl_${c.id}`, control: tpl }),
      carryItems.length ? h('fieldset', { class: 'carry' }, h('legend', {}, `Carry forward from ${prior.cycle}`), h('p', { class: 'muted' }, 'Targets and weights are set afresh.'),
        carryItems.map((i) => h('label', { class: 'check-row' }, h('input', { type: 'checkbox', onchange: (e) => { carry = e.target.checked ? [...carry, i.id] : carry.filter((x) => x !== i.id); } }), i.title))) : null,
      h('div', { class: 'form-actions' }, button('Create draft plan', { variant: 'primary', iconName: 'plus', onClick: async () => {
        try { const p = await api('/api/plans', { method: 'POST', body: { cycleId: c.id, templateId: tpl.value, carryItemIds: carry } }); location.hash = `#/review/${p.id}`; } catch (e) { toast(e.message, 'danger'); }
      } }))) }));
  }
  return root;
}
