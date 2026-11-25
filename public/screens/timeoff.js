// Time off: balances, a request form with a live preview, my requests and team availability.
// Request decision: one page with the facts an approver needs and the two actions.
// Same endpoints and rules as before; only the presentation changed.
import { h, icon, button, badge, card, banner, emptyState, statStrip, dataTable, field, input, select, textarea, toast, confirmModal, promptModal } from '/ui.js';

const fmt = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const span = (a, b) => (a === b ? fmt(a) : `${fmt(a)} → ${fmt(b)}`);
const PORTION = { full: 'Full day', am: 'Morning', pm: 'Afternoon' };
const STATE = { submitted: ['Waiting for approval', 'warning'], approved: ['Approved', 'success'], declined: ['Declined', 'danger'], cancelled: ['Cancelled', 'neutral'], withdrawn: ['Withdrawn', 'neutral'] };
export const stateBadge = (s) => { const [t, tone] = STATE[s] || [s, 'neutral']; return badge(t, tone); };
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''));

export async function timeoffScreen({ api }) {
  const year = new Date().getFullYear();
  const [types, mine, people, status, balances] = await Promise.all([api('/api/leave/types'), api('/api/leave/requests'), api('/api/people'),
    api('/api/leave/status').catch(() => ({ live: true })), api(`/api/leave/balances?year=${year}`).catch(() => [])]);
  const root = h('div', { class: 'stack' });
  root.modern = true;

  if (!status.live) root.append(banner({ tone: 'warning', title: 'Keep using LeaveBoard for now',
    text: `Time off moves to Prism after the LeaveBoard cutover on ${fmt(status.cutover)}. Your balances carry over then${status.approver ? `, and requests will go to ${status.approver}` : ''}.` }));

  // ---- balances
  const tracked = balances.filter((b) => b.tracks_balance);
  if (tracked.length && status.live) root.append(statStrip(tracked.slice(0, 4).map((b) => ({ iconName: b.category === 'offsite' ? 'house' : b.type === 'SL' ? 'stethoscope' : 'calendar-days', value: b.projected, label: `${b.name} left${Number(b.pending) ? ` · ${b.pending} pending` : ''}` }))));

  // ---- request form
  const f = { typeCode: types[0]?.code, start: '', end: '', startPortion: 'full', endPortion: 'full', coverUserId: '', reason: '', handover: '', exceptionReason: '' };
  const key = crypto.randomUUID();
  const preview = h('div', { class: 'leave-preview', 'aria-live': 'polite' });
  const submit = button('Submit request', { variant: 'primary', iconName: 'send', disabled: true, onClick: async () => {
    try { await api('/api/leave/requests', { method: 'POST', body: { ...clean(f), clientKey: key } }); toast('Request submitted'); location.hash = '#/'; } catch (e) { toast(e.message, 'danger'); }
  } });
  let timer = null;
  const refresh = () => { clearTimeout(timer); timer = setTimeout(async () => {
    if (!f.start || !f.end) { submit.disabled = true; return preview.replaceChildren(h('p', { class: 'muted' }, icon('info'), ' Pick dates to see the working days and your balance afterwards.')); }
    try {
      const p = await api('/api/leave/preview', { method: 'POST', body: clean(f) });
      submit.disabled = !!p.blocking.length || !status.live;
      preview.replaceChildren(
        h('div', { class: 'leave-sum' }, h('strong', { class: 'leave-days' }, `${p.chargeable}`), h('span', {}, ' working day(s)'), p.approver ? h('span', { class: 'muted' }, ` · goes to ${p.approver}`) : null),
        p.projected ? h('p', { class: 'muted' }, Object.entries(p.projected).map(([y, b]) => `${y}: ${b.before} → ${b.after} days`).join(' · ')) : null,
        p.blocking.length ? banner({ tone: 'danger', title: 'Can’t submit yet', text: p.blocking.join(' · ') }) : null,
        p.warnings.length ? banner({ tone: 'warning', title: 'Check before sending', text: p.warnings.join(' · ') }) : null,
        h('details', { class: 'leave-days-detail' }, h('summary', {}, 'How the days were counted'), h('ul', {}, p.days.map((d) => h('li', {}, `${fmt(d.date)}: ${d.note}${d.charge !== '0' ? ` (${d.charge})` : ''}`)))),
        p.policy.status !== 'approved' ? h('p', { class: 'muted' }, `Leave policy v${p.policy.version ?? '—'} is awaiting GB approval.`) : null);
    } catch (e) { submit.disabled = true; preview.replaceChildren(banner({ tone: 'danger', title: 'Can’t check these dates', text: e.message })); }
  }, 300); };
  const bind = (k) => ({ oninput: (e) => { f[k] = e.target.value; refresh(); }, onchange: (e) => { f[k] = e.target.value; refresh(); } });
  const typeSel = select(types.map((t) => [t.code, t.name]), { id: 'f_type', ...bind('typeCode') });
  const portion = (k) => select(Object.entries(PORTION), { id: `f_${k}`, ...bind(k) });
  const form = card({ title: 'New request', iconName: 'calendar-check', body: h('div', { class: 'leave-form' },
    h('div', { class: 'form-grid' },
      field({ label: 'Request type', id: 'f_type', control: typeSel }),
      field({ label: 'First day', id: 'f_start', control: input({ id: 'f_start', type: 'date', ...bind('start') }) }),
      field({ label: 'First day is', id: 'f_startPortion', control: portion('startPortion') }),
      field({ label: 'Last day', id: 'f_end', control: input({ id: 'f_end', type: 'date', ...bind('end') }) }),
      field({ label: 'Last day is', id: 'f_endPortion', control: portion('endPortion') }),
      field({ label: 'Who covers your work?', id: 'f_cover', help: 'Required for annual leave', control: select([['', 'Choose a colleague'], ...people.map((x) => [x.id, x.name])], { id: 'f_cover', ...bind('coverUserId') }) })),
    field({ label: 'Handover notes', id: 'f_handover', control: textarea({ id: 'f_handover', rows: 2, ...bind('handover') }) }),
    field({ label: 'Reason', id: 'f_reason', help: 'Optional unless the type needs one. Only you, your approver and People Ops see it.', control: input({ id: 'f_reason', ...bind('reason') }) }),
    field({ label: 'Exception reason', id: 'f_exc', help: 'Only for short notice, retroactive or over-quota requests.', control: input({ id: 'f_exc', ...bind('exceptionReason') }) }),
    preview, h('div', { class: 'form-actions' }, submit)) });
  refresh();

  // ---- my requests
  const myTable = mine.length ? dataTable({ compact: true, rows: mine, columns: [
    { key: 'type', label: 'Type', render: (r) => r.type.name, sortValue: (r) => r.type.name },
    { key: 'start_date', label: 'Dates', render: (r) => span(r.start_date, r.end_date) },
    { key: 'chargeable', label: 'Days', num: true },
    { key: 'state', label: 'Status', render: (r) => stateBadge(r.state) },
    { key: 'actions', label: '', sortable: false, render: (r) => (['submitted', 'approved'].includes(r.state) ? button(r.state === 'submitted' ? 'Withdraw' : 'Cancel', { size: 'sm', variant: 'ghost', onClick: async () => {
      if (!(await confirmModal({ title: r.state === 'submitted' ? 'Withdraw this request?' : 'Cancel this leave?', text: `${r.type.name}, ${span(r.start_date, r.end_date)}.`, confirmLabel: r.state === 'submitted' ? 'Withdraw' : 'Cancel leave', tone: 'danger' }))) return;
      try { await api(`/api/leave/requests/${r.id}/cancel`, { method: 'POST', body: {} }); toast(r.state === 'submitted' ? 'Withdrawn' : 'Cancelled'); dispatchEvent(new HashChangeEvent('hashchange')); } catch (e) { toast(e.message, 'danger'); }
    } }) : null) },
  ] }) : emptyState({ iconName: 'calendar-days', title: 'No requests yet', text: 'Requests you send appear here with their status.' });

  // ---- team availability
  const today = new Date().toISOString().slice(0, 10); const in60 = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  const cal = await api(`/api/leave/calendar?from=${today}&to=${in60}`).catch(() => []);
  const avail = cal.length ? h('ul', { class: 'avail-list' }, cal.map((c) => h('li', {}, h('strong', {}, c.name), h('span', {}, c.availability), h('span', { class: 'muted' }, `${span(c.start_date, c.end_date)}${c.half ? ' · part day' : ''}`), c.tentative ? badge('Pending', 'warning') : null)))
    : emptyState({ iconName: 'sun', title: 'Everyone is available', text: 'Approved and pending time off for the next 60 days shows here.' });

  root.append(h('div', { class: 'timeoff-grid' }, form, h('div', { class: 'stack' },
    card({ title: 'My requests', iconName: 'list-checks', flush: !!mine.length, body: myTable }),
    card({ title: 'Team availability', iconName: 'users', body: [h('p', { class: 'muted' }, 'Next 60 days. Shows who is away, never why.'), avail] }))));
  return root;
}

export async function requestScreen({ api, id }) {
  const r = await api(`/api/leave/requests/${id}`);
  const root = h('div', { class: 'stack' });
  root.modern = true; root.noHeader = true;
  const h1 = h('h1', {}, `${r.user.name} — ${r.type.name}`);
  const note = textarea({ id: 'dn', rows: 2, placeholder: 'Optional when approving; required when declining' });
  const decide = (decision) => async () => {
    if (decision === 'decline' && !note.value.trim()) { toast('Add a note explaining the decline', 'danger'); note.focus(); return; }
    try {
      await api(`/api/leave/requests/${id}/decide`, { method: 'POST', body: { decision, note: note.value, rowVersion: r.row_version, ...(decision === 'approve' ? { approveException: !!r.exception } : {}) } });
      toast(decision === 'approve' ? 'Approved' : 'Declined'); location.hash = '#/inbox';
    } catch (e) { toast(e.message, 'danger'); }
  };
  const steps = r.pm ? h('ol', { class: 'stepper', 'aria-label': 'Approval steps' },
    h('li', { class: r.stage === 'final' || r.state !== 'submitted' ? 'done' : null, 'aria-current': r.stage === 'pm' && r.state === 'submitted' ? 'step' : null },
      h('span', { class: 'step-dot' }, r.stage === 'final' || r.state !== 'submitted' ? icon('check') : '1'), h('span', { class: 'step-label' }, `Project manager — ${r.pm.name}${r.pm.project ? ` (${r.pm.project})` : ''}`)),
    h('li', { class: r.state === 'approved' ? 'done' : null, 'aria-current': r.stage === 'final' && r.state === 'submitted' ? 'step' : null },
      h('span', { class: 'step-dot' }, r.state === 'approved' ? icon('check') : '2'), h('span', { class: 'step-label' }, `Final approval — ${r.approver_name || 'GB approver'}`))) : null;
  const cancel = r.can_cancel ? button('Cancel this request', { variant: 'ghost', iconName: 'circle-x', onClick: async () => {
    const reason = await promptModal({ title: 'Cancel this request?', text: r.state === 'approved' ? 'The days go back to the balance.' : 'It is withdrawn and nothing is deducted.', label: 'Reason (shown to the employee)', confirmLabel: 'Cancel request', tone: 'danger' });
    if (!reason) return;
    try { await api(`/api/leave/requests/${id}/cancel`, { method: 'POST', body: { reason } }); toast('Request cancelled'); location.hash = '#/inbox'; } catch (e) { toast(e.message, 'danger'); }
  } }) : null;
  root.append(h('header', { class: 'request-head' }, h1, stateBadge(r.state), cancel), steps,
    r.pm?.note ? banner({ tone: 'info', title: `${r.pm.name} (project manager)`, text: r.pm.note }) : null,
    r.warnings.length ? banner({ tone: 'warning', title: 'Warnings', text: r.warnings.join(' · ') }) : null,
    r.exception ? banner({ tone: 'warning', title: 'Exception requested', text: r.exception.reason }) : null,
    h('div', { class: 'profile-grid' },
      card({ title: 'Request', iconName: 'calendar-days', body: h('dl', { class: 'kv' },
        h('dt', {}, 'Dates'), h('dd', {}, span(r.start_date, r.end_date)),
        h('dt', {}, 'Part days'), h('dd', {}, `${PORTION[r.start_portion]} → ${PORTION[r.end_portion]}`),
        h('dt', {}, 'Working days'), h('dd', {}, h('strong', {}, r.chargeable)),
        r.reason ? [h('dt', {}, 'Reason'), h('dd', {}, r.reason)] : null,
        r.handover ? [h('dt', {}, 'Handover'), h('dd', {}, r.handover)] : null,
        h('dt', {}, 'Sent'), h('dd', {}, fmt(r.created_at?.slice(0, 10)))) }),
      card({ title: 'Balance', iconName: 'calculator', body: r.balances?.length ? h('dl', { class: 'kv' }, r.balances.map((b) => [h('dt', {}, b.name), h('dd', {}, `${b.posted} days`, Number(b.pending) ? h('span', { class: 'muted' }, ` · ${b.pending} pending`) : null)]))
        : h('p', { class: 'muted' }, 'No balance for this request type.') })),
    card({ title: 'Day by day', iconName: 'list-checks', body: h('ul', { class: 'bullets' }, (r.breakdown?.days || []).map((d) => h('li', {}, `${fmt(d.date)}: ${d.note}`))) }),
    r.can_decide ? card({ title: 'Your decision', iconName: 'user-check', body: h('div', { class: 'stack' },
      field({ label: 'Note to the employee', id: 'dn', control: note }),
      h('div', { class: 'form-actions' }, button('Decline', { variant: 'danger', iconName: 'circle-x', onClick: decide('decline') }),
        button(r.exception ? 'Approve with exception' : 'Approve', { variant: 'primary', iconName: 'check', onClick: decide('approve') }))) })
      : r.decision_note ? card({ title: 'Decision', iconName: 'user-check', body: h('p', {}, r.decision_note) }) : null);
  return root;
}
