// Commercial control (partners): fee and hour budgets, burn, margin, billing milestones and cash.
import { h, icon, button, badge, card, emptyState, field, input, select, textarea, toast, openDrawer, statStrip, confirmModal } from '/ui.js';

const M = (x, cur = 'JOD') => (x == null ? '—' : `${Math.round(x / 100).toLocaleString('en-GB')} ${cur}`);
const H = (x) => (x == null ? '—' : `${Math.round(x / 100).toLocaleString('en-GB')} h`);
const fmt = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const ALERT = { over: ['Over budget', 'danger'], critical: ['90%+ used', 'danger'], warning: ['75%+ used', 'warning'], ahead_of_time: ['Burning faster than time', 'warning'] };
const MS = { planned: ['Planned', 'neutral'], invoiced: ['Invoiced', 'info'], paid: ['Paid', 'success'], cancelled: ['Cancelled', 'neutral'] };

function burnBar(pct, timePct) {
  const el = h('div', { class: 'burn', role: 'img', 'aria-label': `${pct ?? 0}% of hours used${timePct != null ? `, ${timePct}% of time elapsed` : ''}` },
    h('span', { class: `burn-fill${pct >= 100 ? ' over' : pct >= 90 ? ' crit' : pct >= 75 ? ' warn' : ''}`, 'data-w': String(Math.min(100, pct || 0)) }),
    timePct != null ? h('span', { class: 'burn-time', 'data-x': String(timePct), title: `${timePct}% of the time elapsed` }) : null);
  setTimeout(() => { el.querySelectorAll('[data-w]').forEach((s) => { s.style.inlineSize = `${s.dataset.w}%`; }); el.querySelectorAll('[data-x]').forEach((s) => { s.style.insetInlineStart = `${s.dataset.x}%`; }); }, 0);
  return el;
}

export async function commercialScreen({ api, query = '' }) {
  const focus = new URLSearchParams(query).get('p');
  const root = h('div', { class: 'stack' });

  async function openProject(id) {
    const f = await api(`/api/commercial/projects/${id}`);
    const b = f.budget || {};
    const billing = select([['fixed', 'Fixed fee'], ['time_materials', 'Time and materials']], { id: 'cb-billing' }); billing.value = b.billing || 'fixed';
    const fee = input({ id: 'cb-fee', type: 'number', min: 0, step: 1, value: b.fee_x100 != null ? b.fee_x100 / 100 : '' });
    const rate = input({ id: 'cb-rate', type: 'number', min: 0, step: 1, value: b.rate_x100 != null ? b.rate_x100 / 100 : '' });
    const hours = input({ id: 'cb-hours', type: 'number', min: 0, step: 1, value: b.budget_hours_x100 ? b.budget_hours_x100 / 100 : '' });
    const cur = select(['JOD', 'USD', 'SAR', 'AED', 'EUR', 'IQD'].map((c) => [c, c]), { id: 'cb-cur' }); cur.value = b.currency || 'JOD';
    const notes = textarea({ id: 'cb-notes', rows: 2 }, b.notes || '');
    const feeWrap = field({ label: 'Fee (contract value)', id: 'cb-fee', control: fee }); const rateWrap = field({ label: 'Billing rate per hour', id: 'cb-rate', control: rate });
    const sync = () => { feeWrap.hidden = billing.value !== 'fixed'; rateWrap.hidden = billing.value === 'fixed'; }; billing.onchange = sync; sync();
    let close;
    const msRow = (m) => h('li', { class: 'kpi-row' }, h('div', {}, h('strong', {}, m.title), h('div', { class: 'muted' }, `${M(m.amount_x100, f.budget?.currency)} · due ${fmt(m.due_on)}${m.invoice_no ? ` · invoice ${m.invoice_no}` : ''}`)),
      h('div', { class: 'eng-side' }, m.overdue ? badge('Overdue', 'danger') : null, (() => { const s = select(Object.entries(MS).map(([k, v]) => [k, v[0]]), { 'aria-label': `Status of ${m.title}`, class: 'select select-sm', onchange: async (e) => {
        try { await api(`/api/commercial/projects/${id}/milestones/${m.id}`, { method: 'PATCH', body: { ...m, amount: m.amount_x100 / 100, status: e.target.value, invoiced_on: e.target.value === 'planned' ? null : m.invoiced_on, paid_on: e.target.value === 'paid' ? m.paid_on : null } }); toast('Milestone updated'); close(); openProject(id); draw(); } catch (err) { toast(err.message, 'danger'); } } }); s.value = m.status; return s; })(),
        button('', { size: 'sm', variant: 'ghost', iconName: 'trash-2', ariaLabel: `Delete ${m.title}`, onClick: async () => { if (await confirmModal({ title: `Delete “${m.title}”?`, confirmLabel: 'Delete', tone: 'danger' })) { await api(`/api/commercial/projects/${id}/milestones/${m.id}/delete`, { method: 'POST' }); close(); openProject(id); draw(); } } })));
    const mt = input({ id: 'cm-title', placeholder: 'e.g. Inception report – 30%' }); const ma = input({ id: 'cm-amt', type: 'number', min: 0 }); const md = input({ id: 'cm-due', type: 'date' });
    close = openDrawer({ title: f.project.name, iconName: 'calculator', body: h('div', { class: 'stack' },
      statStrip([{ iconName: 'timer', value: f.burn_pct == null ? '—' : `${f.burn_pct}%`, label: `hours used (${H(f.actual_hours_x100)} of ${H(f.budget_hours_x100)})` },
        { iconName: 'percent', value: f.margin_pct == null ? '—' : `${f.margin_pct}%`, label: 'margin to date' }, { iconName: 'trending-up', value: f.forecast_margin_pct == null ? '—' : `${f.forecast_margin_pct}%`, label: 'forecast margin at completion' }]),
      burnBar(f.burn_pct, f.time_elapsed_pct),
      f.missing_rates.length ? h('p', { class: 'callout' }, `Set a standard hourly cost for: ${f.missing_rates.join(', ')} (Cost rates) — until then their hours count as zero cost.`) : null,
      h('dl', { class: 'kv' }, h('dt', {}, 'Fee'), h('dd', {}, M(f.fee_x100, b.currency)), h('dt', {}, 'Cost to date'), h('dd', {}, M(f.cost_x100, b.currency)), h('dt', {}, 'Forecast hours'), h('dd', {}, H(f.forecast_hours_x100)),
        h('dt', {}, 'Invoiced / paid'), h('dd', {}, `${M(f.invoiced_x100, b.currency)} / ${M(f.paid_x100, b.currency)}`), h('dt', {}, 'Not yet billed'), h('dd', {}, M(f.unbilled_x100, b.currency))),
      h('h3', { class: 'kv-head' }, 'Budget'), h('div', { class: 'form-grid' }, field({ label: 'Billing', id: 'cb-billing', control: billing }), feeWrap, rateWrap, field({ label: 'Currency', id: 'cb-cur', control: cur }), field({ label: 'Budget hours', id: 'cb-hours', control: hours })),
      field({ label: 'Notes', id: 'cb-notes', control: notes }),
      button('Save budget', { variant: 'primary', iconName: 'check', onClick: async () => { try { await api(`/api/commercial/projects/${id}/budget`, { method: 'POST', body: { billing: billing.value, fee: fee.value || 0, rate: rate.value || 0, budget_hours: hours.value || 0, currency: cur.value, notes: notes.value } }); toast('Budget saved'); close(); openProject(id); draw(); } catch (e) { toast(e.message, 'danger'); } } }),
      h('h3', { class: 'kv-head' }, 'Billing milestones'), f.milestones.length ? h('ul', { class: 'eng-list' }, f.milestones.map(msRow)) : h('p', { class: 'muted' }, 'No milestones yet.'),
      h('div', { class: 'form-grid' }, field({ label: 'Milestone', id: 'cm-title', control: mt }), field({ label: 'Amount', id: 'cm-amt', control: ma }), field({ label: 'Due', id: 'cm-due', control: md })),
      button('Add milestone', { iconName: 'plus', onClick: async () => { try { await api(`/api/commercial/projects/${id}/milestones`, { method: 'POST', body: { title: mt.value, amount: ma.value, due_on: md.value || null } }); toast('Milestone added'); close(); openProject(id); draw(); } catch (e) { toast(e.message, 'danger'); } } }),
      h('h3', { class: 'kv-head' }, 'Hours by person'), f.people.length ? h('ul', { class: 'bullets' }, f.people.map((p) => h('li', {}, `${p.name} (${p.level || 'no level'}) — ${H(p.hours_x100)}${p.approved_x100 < p.hours_x100 ? ` (${H(p.approved_x100)} approved)` : ''}`))) : h('p', { class: 'muted' }, 'No hours logged yet.')) });
  }

  async function rates() {
    const list = await api('/api/commercial/rates');
    const inputs = list.map((r) => ({ level: r.level, cost: input({ type: 'number', min: 0, step: 1, value: r.hourly_x100 != null ? r.hourly_x100 / 100 : '', 'aria-label': `Hourly cost for ${r.level}`, class: 'input input-sm' }),
      target: input({ type: 'number', min: 0, max: 100, value: r.target_pct ?? '', 'aria-label': `Utilisation target for ${r.level}`, class: 'input input-sm' }) }));
    openDrawer({ title: 'Cost rates and utilisation targets', iconName: 'calculator', body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'A standard hourly cost per level (salary plus overheads, divided by working hours) — never one person’s salary. Used for project cost and margin. The target is the share of time expected on client projects.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data compact' }, h('thead', {}, h('tr', {}, h('th', {}, 'Level'), h('th', {}, 'Cost per hour (JOD)'), h('th', {}, 'Utilisation target %'))),
        h('tbody', {}, inputs.map((r) => h('tr', {}, h('td', {}, r.level), h('td', {}, r.cost), h('td', {}, r.target))))))),
    footer: (close) => button('Save', { variant: 'primary', iconName: 'check', onClick: async () => { try { await api('/api/commercial/rates', { method: 'POST', body: { rates: inputs.map((r) => ({ level: r.level, hourly: r.cost.value, target_pct: r.target.value })) } }); toast('Saved'); close(); draw(); } catch (e) { toast(e.message, 'danger'); } } }) });
  }

  async function draw() {
    const v = await api('/api/commercial'); const t = v.totals;
    root.replaceChildren(
      h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, icon('lock'), ' Partners only. Leads see their projects’ hours, never fees or margins.'), button('Cost rates and targets', { iconName: 'calculator', onClick: rates })),
      statStrip([{ iconName: 'briefcase', value: M(t.fee_x100), label: 'fees in the portfolio' }, { iconName: 'percent', value: t.fee_x100 ? `${Math.round((t.margin_x100 / t.fee_x100) * 100)}%` : '—', label: 'margin to date' },
        { iconName: 'receipt', value: M(t.outstanding_x100), label: `invoiced, not yet paid${t.overdue_x100 ? ` (${M(t.overdue_x100)} overdue)` : ''}` }, { iconName: 'trending-up', value: M(t.paid_this_year_x100), label: `cash received in ${v.year}` }]),
      v.rates_missing.length || v.missing_budgets.length ? h('p', { class: 'callout' }, [v.missing_budgets.length ? `${v.missing_budgets.length} active project(s) have no budget yet.` : null, v.rates_missing.length ? ` Cost rates missing for: ${v.rates_missing.join(', ')}.` : null].filter(Boolean).join(' ')) : null,
      card({ title: 'Projects', iconName: 'briefcase', body: v.projects.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Project', 'Hours used', '', 'Fee', 'Margin', 'Forecast', 'Outstanding', ''].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', {}, v.projects.map((p) => h('tr', {}, h('td', {}, h('button', { type: 'button', class: 'link-btn', onclick: () => openProject(p.project.id) }, h('strong', {}, p.project.name)), h('div', { class: 'muted' }, p.client?.name_en || '')),
          h('td', { class: 'burn-cell' }, p.budget_hours_x100 ? [burnBar(p.burn_pct, p.time_elapsed_pct), h('span', { class: 'muted' }, `${H(p.actual_hours_x100)} of ${H(p.budget_hours_x100)}`)] : h('span', { class: 'muted' }, `${H(p.actual_hours_x100)} logged`)),
          h('td', {}, p.alert ? badge(...ALERT[p.alert]) : null), h('td', { class: 'num' }, p.budget ? M(p.fee_x100, p.budget.currency) : h('span', { class: 'muted' }, 'No budget')),
          h('td', { class: 'num' }, p.margin_pct == null ? '—' : `${p.margin_pct}%`), h('td', { class: 'num' }, p.forecast_margin_pct == null ? '—' : badge(`${p.forecast_margin_pct}%`, p.forecast_margin_pct < 0 ? 'danger' : p.forecast_margin_pct < 20 ? 'warning' : 'success')),
          h('td', { class: 'num' }, p.outstanding_x100 ? [M(p.outstanding_x100, p.budget?.currency), p.overdue_x100 ? [' ', badge('Overdue', 'danger')] : null] : '—'),
          h('td', {}, button(p.budget ? 'Open' : 'Set budget', { size: 'sm', variant: p.budget ? 'ghost' : 'secondary', onClick: () => openProject(p.project.id) }))))))) : emptyState({ iconName: 'briefcase', title: 'No active projects' }) }),
      h('div', { class: 'report-grid' },
        card({ title: 'Expected cash in, next 90 days', iconName: 'calendar-days', body: v.cash_in_90.length ? h('ul', { class: 'bullets' }, v.cash_in_90.map((m) => h('li', {}, `${fmt(m.due_on)} — ${m.project}: ${m.title}, ${M(m.amount_x100)} (${MS[m.status][0].toLowerCase()})`))) : h('p', { class: 'muted' }, 'No milestones due.') }),
        card({ title: 'Fees by client', iconName: 'building-2', body: v.by_client.length ? h('ul', { class: 'bullets' }, v.by_client.slice(0, 12).map((c) => h('li', {}, `${c.client} — ${M(c.fee_x100)} (${c.projects} project${c.projects === 1 ? '' : 's'}; invoiced ${M(c.invoiced_x100)})`))) : h('p', { class: 'muted' }, 'Nothing yet.') }),
        card({ title: 'Needs attention', iconName: 'triangle-alert', body: v.at_risk.length ? h('ul', { class: 'bullets' }, v.at_risk.map((n) => h('li', {}, n))) : h('p', { class: 'muted' }, 'No project over 90% of hours, at negative forecast margin or with overdue invoices.') })));
    if (focus) { openProject(focus); history.replaceState(null, '', '#/commercial'); }
  }
  await draw(); root.modern = true;
  return root;
}
