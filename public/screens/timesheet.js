// Timesheet: one month, one row per day, one column per project / time code. The month drafts
// itself from assignments, holidays and approved leave; the person corrects and submits.
// Partners / People Ops see man-hours per project and approve submitted months.
import { h, icon, button, badge, card, banner, emptyState, filterChips, toast, promptModal, statStrip } from '/ui.js';

const H = (x100) => (x100 ? (x100 / 100).toFixed(x100 % 100 ? 2 : 0).replace(/0$/, '') : '');
const thisMonth = () => new Date().toISOString().slice(0, 7);
const shift = (m, d) => { const [y, mo] = m.split('-').map(Number); const t = new Date(Date.UTC(y, mo - 1 + d, 1)); return t.toISOString().slice(0, 7); };
const mLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUS = { open: ['Draft', 'neutral'], submitted: ['Submitted', 'info'], approved: ['Approved', 'success'], returned: ['Returned for changes', 'warning'] };

export async function timesheetScreen({ api, me, query = '' }) {
  const params = new URLSearchParams(query);
  let month = /^\d{4}-\d{2}$/.test(params.get('m') || '') ? params.get('m') : thisMonth();
  const approver = me.roles.includes('partner') || me.roles.includes('people_ops') || me.roles.includes('admin');
  let tab = params.get('tab') === 'report' && approver ? 'report' : 'mine';
  const root = h('div', { class: 'stack' }); const body = h('div', { class: 'stack' });
  const go = (m) => { month = m; draw(); };
  const nav = () => h('div', { class: 'row' }, button('', { iconName: 'chevron-left', ariaLabel: 'Previous month', onClick: () => go(shift(month, -1)) }), h('strong', { class: 'month-label' }, mLabel(month)),
    button('', { iconName: 'chevron-right', ariaLabel: 'Next month', onClick: () => go(shift(month, 1)) }));

  async function mine() {
    const v = await api(`/api/timesheets/me/${month}`);
    let pending = new Map(); let timer = null;
    const state = h('span', { class: 'save-state', 'aria-live': 'polite' });
    const flush = async () => {
      clearTimeout(timer); if (!pending.size) return;
      const cells = [...pending.values()]; pending = new Map(); state.textContent = 'Saving…';
      try { await api(`/api/timesheets/me/${month}/entries`, { method: 'POST', body: { cells } }); state.textContent = 'Saved'; } catch (e) { state.textContent = 'Not saved'; toast(e.message, 'danger'); }
    };
    const val = (date, code) => v.entries.find((e) => e.work_date === date && e.code === code)?.hours_x100 || 0;
    const dayTotal = new Map(v.days.map((d) => [d.date, v.rows.reduce((s, r) => s + val(d.date, r.code), 0)]));
    const totalCells = new Map();
    const refreshTotals = (date) => { const t = v.rows.reduce((s, r) => s + Math.round(Number(document.getElementById(`ts-${date}-${r.code}`)?.value || 0) * 100), 0); dayTotal.set(date, t); const c = totalCells.get(date); if (c) c.textContent = H(t) || '0'; };
    const [label, tone] = STATUS[v.status] || STATUS.open;
    const table = h('table', { class: 'data compact ts-grid' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Day'), v.rows.map((r) => h('th', { scope: 'col', class: 'num', title: r.label }, h('span', { class: 'ts-head' }, r.label))), h('th', { scope: 'col', class: 'num' }, 'Total'))),
      h('tbody', {}, v.days.map((d) => {
        const off = d.weekend || d.holiday;
        const note = d.holiday ? d.holiday : d.leave_x100 ? (d.leave_x100 === 100 ? 'Leave' : 'Half day leave') : d.weekend ? 'Weekend' : '';
        const tot = h('td', { class: 'num' }, H(dayTotal.get(d.date)) || (off ? '' : '0')); totalCells.set(d.date, tot);
        return h('tr', { class: off ? 'ts-off' : d.leave_x100 ? 'ts-leave' : null },
          h('th', { scope: 'row' }, h('span', {}, `${DAY[d.weekday]} ${Number(d.date.slice(8))}`), note ? h('span', { class: 'muted ts-note' }, ` ${note}`) : null),
          v.rows.map((r) => h('td', { class: 'num' }, v.can.edit ? h('input', { id: `ts-${d.date}-${r.code}`, class: 'input input-sm ts-cell', type: 'number', min: 0, max: 24, step: 0.25, inputmode: 'decimal',
            value: H(val(d.date, r.code)), 'aria-label': `${r.label}, ${d.date}`,
            oninput: (e) => { pending.set(`${d.date}|${r.code}`, { date: d.date, code: r.code, hours: e.target.value || 0 }); state.textContent = 'Unsaved changes…'; refreshTotals(d.date); clearTimeout(timer); timer = setTimeout(flush, 900); } }) : H(val(d.date, r.code)))),
          tot);
      })),
      h('tfoot', {}, h('tr', {}, h('th', { scope: 'row' }, 'Month'), v.rows.map((r) => h('td', { class: 'num' }, h('strong', {}, H(r.total_x100) || '0'))), h('td', { class: 'num' }, h('strong', {}, H(v.totals.hours_x100) || '0')))));
    return [
      statStrip([{ iconName: 'timer', value: H(v.totals.hours_x100) || '0', label: 'hours logged' }, { iconName: 'calendar-days', value: H(v.totals.capacity_x100) || '0', label: 'working hours this month' },
        { iconName: 'briefcase', value: String(v.rows.filter((r) => r.project_id && r.total_x100).length), label: 'projects' }]),
      v.status === 'returned' && v.note ? banner({ tone: 'warning', title: 'Returned for changes', text: v.note }) : null,
      card({ title: 'Hours by day', iconName: 'table', actions: [badge(label, tone), state,
        v.can.edit ? button('Redraft from assignments', { iconName: 'refresh-cw', onClick: async () => { await flush(); await api(`/api/timesheets/me/${month}/autofill`, { method: 'POST', body: { overwrite: true } }); toast('Month redrafted'); draw(); } }) : null,
        v.can.edit ? button('Submit month', { variant: 'primary', iconName: 'send', onClick: async () => { await flush(); try { await api(`/api/timesheets/me/${month}/submit`, { method: 'POST' }); toast('Submitted'); draw(); } catch (e) { toast(e.message, 'danger'); } } }) : null],
      body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Drafted for you: 8 hours per working day, split across the projects you are assigned to, minus public holidays and approved leave. Correct the hours, then submit at month end.'),
        v.rows.length ? h('div', { class: 'table-wrap' }, table) : emptyState({ iconName: 'timer', title: 'No time codes' })) }),
    ];
  }

  async function report() {
    const r = await api(`/api/timesheet-report/${month}`);
    const md = (x) => (x / 100 / (r.hours_per_day || 8)).toFixed(1);
    const subs = r.people?.filter((p) => p.status === 'submitted') || [];
    const list = await api(`/api/people`).catch(() => []);
    return [
      card({ title: 'Man-hours by project', iconName: 'briefcase', body: r.projects.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Project / code'), h('th', { scope: 'col', class: 'num' }, 'Hours'), h('th', { scope: 'col', class: 'num' }, 'Man-days'), h('th', { scope: 'col' }, 'Who'))),
        h('tbody', {}, r.projects.map((p) => h('tr', {}, h('td', {}, p.project_id ? h('a', { href: `#/projects?p=${p.project_id}` }, p.label) : p.label), h('td', { class: 'num' }, H(p.hours_x100)), h('td', { class: 'num' }, md(p.hours_x100)),
          h('td', {}, p.people.map((x, i) => [i ? ', ' : '', `${x.name} ${H(x.hours_x100)}h`, x.status === 'open' ? h('span', { class: 'muted' }, ' (draft)') : null]))))))) : emptyState({ iconName: 'timer', title: 'No hours logged this month yet' }) }),
      r.people ? card({ title: 'Who has submitted', iconName: 'user-check', body: h('ul', { class: 'eng-list' }, r.people.map((p) => {
        const id = list.find((x) => x.name === p.name)?.id;
        const [l, t] = STATUS[p.status] || ['Not started', 'neutral'];
        return h('li', { class: 'eng-item' }, h('strong', {}, p.name), h('div', { class: 'eng-side' }, badge(l, t),
          p.status === 'submitted' && id ? [button('Approve', { size: 'sm', variant: 'primary', iconName: 'check', onClick: async () => { await api(`/api/timesheets/${id}/${month}/decide`, { method: 'POST', body: { decision: 'approve' } }); toast('Approved'); draw(); } }),
            button('Return', { size: 'sm', variant: 'ghost', onClick: async () => { const note = await promptModal({ title: `Return ${p.name}’s timesheet`, label: 'What should they correct?', confirmLabel: 'Return' }); if (note) { await api(`/api/timesheets/${id}/${month}/decide`, { method: 'POST', body: { decision: 'return', note } }); toast('Returned'); draw(); } } })] : null));
      })), actions: subs.length ? badge(`${subs.length} to approve`, 'info') : null }) : null,
    ];
  }

  async function draw() {
    const tabs = approver ? filterChips([{ value: 'mine', label: 'My timesheet', iconName: 'timer' }, { value: 'report', label: 'Projects & approvals', iconName: 'briefcase' }], tab, (v) => { tab = v; draw(); }) : null;
    body.replaceChildren(h('div', { class: 'toolbar' }, nav(), tabs), h('p', { class: 'muted' }, 'Loading…'));
    try { body.replaceChildren(h('div', { class: 'toolbar' }, nav(), tabs), ...(await (tab === 'report' ? report() : mine())).filter(Boolean)); } catch (e) { body.replaceChildren(h('div', { class: 'toolbar' }, nav(), tabs), emptyState({ iconName: 'circle-alert', title: e.message })); }
  }
  await draw();
  root.append(body); root.modern = true;
  return root;
}
