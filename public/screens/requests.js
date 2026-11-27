// My Work → Requests: start a request (leave is the dominant action) and follow the ones in flight.
// Reads /api/leave/requests, /api/expenses and /api/letters (mine only) and the leave balances.
import { h, icon, button, badge, emptyState } from '/ui.js';

const fmt = (s) => (s ? new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const LEAVE = { submitted: ['Waiting for approval', 'warning'], approved: ['Approved', 'success'], declined: ['Declined', 'danger'], withdrawn: ['Withdrawn', 'neutral'], cancelled: ['Cancelled', 'neutral'] };
const EXP = { draft: ['Draft — not sent', 'neutral'], submitted: ['Waiting for approval', 'warning'], approved: ['Approved — to be paid', 'info'], paid: ['Paid', 'success'], rejected: ['Returned', 'danger'], cancelled: ['Cancelled', 'neutral'] };
const LET = { requested: ['Requested', 'warning'], issued: ['Issued', 'success'], rejected: ['Declined', 'danger'], cancelled: ['Cancelled', 'neutral'] };

export async function requestsScreen({ api }) {
  const year = new Date().getFullYear();
  const [leave, claims, letters, balances] = await Promise.all([
    api('/api/leave/requests').catch(() => []), api('/api/expenses').catch(() => []), api('/api/letters').catch(() => ({ mine: [] })), api(`/api/leave/balances?year=${year}`).catch(() => []),
  ]);
  const av = (balances || []).find((b) => b.type === 'AV' || b.code === 'AV');
  const actions = h('section', { class: 'request-actions', 'aria-label': 'Start a request' },
    h('div', { class: 'request-lead' },
      h('div', {}, h('h2', {}, 'Request leave'), h('p', { class: 'muted' }, av ? `${av.posted ?? (av.posted_x100 / 100)} days of annual leave left this year. Your project manager approves first, then the final approver.` : 'Annual, sick or off-site days. Your project manager approves first, then the final approver.')),
      button('Request leave', { variant: 'primary', iconName: 'plus', href: '#/timeoff' })),
    h('ul', { class: 'request-links' },
      [['#/expenses', 'receipt', 'Submit an expense', 'Receipts on every line; approved claims are paid with salary'],
        ['#/expenses?tab=gym', 'dumbbell', 'Gym allowance', 'Attach your gym registration as the policy requires'],
        ['#/letters', 'mail-check', 'Ask for a letter', 'Experience, internship and other HR letters'],
        ['#/timeoff', 'calendar-days', 'See who is away', 'The team calendar and your balances']].map(([href, ic, t, d]) =>
        h('li', {}, h('a', { class: 'request-link', href }, h('span', { class: 'attn-icon', 'aria-hidden': 'true' }, icon(ic)), h('span', { class: 'attn-text' }, h('strong', {}, t), h('span', { class: 'muted' }, d)), icon('chevron-right', { flip: true }))))));

  const rows = [
    ...leave.map((r) => ({ when: r.start_date, kind: 'Leave', ic: 'calendar-days', title: `${r.type?.name || 'Leave'} · ${fmt(r.start_date)}${r.end_date !== r.start_date ? ` → ${fmt(r.end_date)}` : ''}`, detail: `${r.chargeable} day${r.chargeable === '1' ? '' : 's'}`, status: LEAVE[r.state] || [r.state, 'neutral'], href: '#/timeoff', open: r.state === 'submitted' })),
    ...claims.map((c) => ({ when: (c.submitted_at || c.created_at || '').slice(0, 10), kind: 'Expense', ic: 'receipt', title: c.title, detail: `${(c.total_x100 / 100).toFixed(2)} ${c.currency || ''} · ${c.lines} line${c.lines === 1 ? '' : 's'}`, status: EXP[c.status] || [c.status, 'neutral'], href: '#/expenses', open: ['draft', 'submitted', 'approved', 'rejected'].includes(c.status) })),
    ...(letters.mine || []).map((l) => ({ when: (l.created_at || '').slice(0, 10), kind: 'Letter', ic: 'mail-check', title: `${l.kind.replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase())} letter`, detail: l.addressee || l.purpose || '', status: LET[l.status] || [l.status, 'neutral'], href: '#/letters', open: l.status === 'requested' })),
  ].sort((a, b) => Number(b.open) - Number(a.open) || (b.when || '').localeCompare(a.when || ''));
  const list = rows.length ? h('ul', { class: 'attn-list req-list' }, rows.slice(0, 12).map((r) => h('li', {}, h('a', { class: 'attn-row', href: r.href },
    h('span', { class: 'attn-icon', 'aria-hidden': 'true' }, icon(r.ic)),
    h('span', { class: 'attn-text' }, h('strong', {}, r.title), h('span', { class: 'muted' }, [r.kind, r.detail].filter(Boolean).join(' · '))),
    badge(r.status[0], r.status[1]), icon('chevron-right', { flip: true })))))
    : emptyState({ iconName: 'send', title: 'No requests yet', text: 'Leave, expenses and letters you ask for appear here with their status.' });
  const root = h('div', { class: 'stack' }, actions,
    h('section', { class: 'card', 'aria-labelledby': 'rq-h' }, h('header', { class: 'card-header' }, h('h2', { id: 'rq-h' }, 'My requests'), h('div', { class: 'card-actions muted' }, 'Open requests first')), h('div', { class: 'card-body' }, list)));
  root.modern = true;
  return root;
}
