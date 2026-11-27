// Manager workspace.
//   Approvals    — one queue of decisions on other people's work (leave, expenses, timesheets,
//                  reviews, project teams, letters, CVs), oldest due first, one action per row.
//   Team reviews — where each of your reviewees stands, plus calibration for partners.
// Reads /api/inbox?scope=team and /api/team/progress.
import { h, icon, badge, button, emptyState, filterChips, dataTable, promptModal, toast } from '/ui.js';

const KIND = { review: ['Reviews', 'clipboard-check'], request: ['Leave', 'calendar-days'], calibration: ['Calibration', 'scale'], contribution: ['Project teams', 'folder-kanban'],
  assignment: ['Project teams', 'folder-kanban'], clarification: ['Questions', 'circle-help'], expense: ['Expenses', 'receipt'], timesheet: ['Timesheets', 'timer'],
  letter: ['Letters', 'mail-check'], cv: ['CVs', 'id-card'], document: ['Company documents', 'file-check-2'], offboarding: ['Offboarding', 'log-out'], project_change: ['Project changes', 'briefcase'] };
const group = (t) => (t === 'assignment' ? 'contribution' : t);
const d0 = (s) => new Date(`${s}T00:00:00`);
const fmt = (s) => d0(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(new Date());

export async function approvalsScreen({ api }) {
  let { items } = await api('/api/inbox?scope=team');
  const reload = async () => { ({ items } = await api('/api/inbox?scope=team')); sorted = [...items].sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')); draw(); };
  const today = todayIso();
  let sorted = [...items].sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  let filter = 'all';
  const list = h('ul', { class: 'attn-list approvals' });
  const draw = () => {
    const shown = sorted.filter((i) => filter === 'all' || group(i.type) === filter);
    list.replaceChildren(...(shown.length ? shown.map((i) => {
      const [label, ic] = KIND[i.type] || [i.kind, 'circle-dot'];
      const overdue = i.due && i.due < today && i.type !== 'request';
      return h('li', {}, h('div', { class: `attn-row approval${overdue ? ' is-overdue' : ''}` },
        h('span', { class: 'attn-icon', 'aria-hidden': 'true' }, icon(ic)),
        h('span', { class: 'attn-text' }, h('strong', {}, i.title), h('span', { class: 'muted' }, [i.kind, i.state, i.warnings ? `${i.warnings} warning${i.warnings === 1 ? '' : 's'}` : null, i.note ? `“${i.note}”` : null].filter(Boolean).join(' · '))),
        i.due ? h('span', { class: `due due-${overdue ? 'danger' : 'neutral'}` }, i.type === 'request' ? `Starts ${fmt(i.due)}` : overdue ? `Overdue · ${fmt(i.due)}` : `Due ${fmt(i.due)}`) : h('span', { class: 'muted due' }, label),
        i.type === 'project_change' ? h('span', { class: 'row-actions' },
          button('Approve', { size: 'sm', variant: 'secondary', iconName: 'check', onClick: async () => { try { await api(`/api/project-changes/${i.id}/decide`, { method: 'POST', body: { decision: 'approve' } }); toast('Approved — their projects are updated'); await reload(); } catch (e) { toast(e.message, 'danger'); } } }),
          button('Decline', { size: 'sm', variant: 'ghost', onClick: async () => { const note = await promptModal({ title: 'Decline this change?', text: i.title, label: 'Why (they will see this)', confirmLabel: 'Decline', tone: 'danger' }); if (!note) return; try { await api(`/api/project-changes/${i.id}/decide`, { method: 'POST', body: { decision: 'decline', note } }); toast('Declined'); await reload(); } catch (e) { toast(e.message, 'danger'); } } }))
          : h('a', { class: 'btn btn-secondary btn-sm', href: i.link, 'aria-label': `${i.action || 'Review'}: ${i.title}` }, h('span', {}, i.action || 'Review'))));
    }) : [h('li', {}, emptyState({ iconName: 'party-popper', title: 'Nothing waiting for your decision', text: 'Leave, expenses, timesheets, reviews and project teams that need you appear here.' }))]));
  };
  draw();
  const kinds = [...new Set(items.map((i) => group(i.type)))];
  const chips = kinds.length > 1 ? filterChips([{ value: 'all', label: 'All', count: items.length }, ...kinds.map((k) => ({ value: k, label: KIND[k]?.[0] || k, count: items.filter((i) => group(i.type) === k).length }))], 'all', (v) => { filter = v; draw(); }) : null;
  const root = h('div', { class: 'stack' },
    h('section', { class: 'card', 'aria-labelledby': 'ap-h' }, h('header', { class: 'card-header' }, h('h2', { id: 'ap-h' }, `${items.length} waiting for you`), chips ? h('div', { class: 'card-actions' }, chips) : null), h('div', { class: 'card-body' }, list)),
    h('p', { class: 'muted' }, icon('info'), ' Your own tasks — your review, timesheet and policies — stay on ', h('a', { href: '#/' }, 'Home'), '.'));
  root.modern = true;
  return root;
}

export async function teamReviewsScreen({ api }) {
  const [progress, inbox] = await Promise.all([api('/api/team/progress').catch(() => []), api('/api/inbox?scope=team').catch(() => ({ items: [] }))]);
  const reviews = inbox.items.filter((i) => ['review', 'calibration', 'clarification'].includes(i.type));
  const root = h('div', { class: 'stack' },
    reviews.length ? h('section', { class: 'card', 'aria-labelledby': 'tr-h' }, h('header', { class: 'card-header' }, h('h2', { id: 'tr-h' }, 'Your next review steps')),
      h('div', { class: 'card-body' }, h('ul', { class: 'attn-list' }, reviews.map((i) => h('li', {}, h('a', { class: 'attn-row', href: i.link },
        h('span', { class: 'attn-icon', 'aria-hidden': 'true' }, icon(KIND[i.type]?.[1] || 'clipboard-check')),
        h('span', { class: 'attn-text' }, h('strong', {}, `${i.kind}: ${i.title}`), h('span', { class: 'muted' }, i.state || '')),
        i.due ? h('span', { class: 'due due-neutral' }, `Due ${fmt(i.due)}`) : null, icon('chevron-right', { flip: true }))))))) : null,
    h('section', { class: 'card', 'aria-labelledby': 'tp-h' }, h('header', { class: 'card-header' }, h('h2', { id: 'tp-h' }, 'Where each review stands')),
      h('div', { class: 'card-body flush' }, progress.length ? dataTable({ compact: true, rows: progress, columns: [
        { key: 'name', label: 'Person', render: (p) => h('a', { href: `#/review/${p.id}` }, p.name) },
        { key: 'cycle', label: 'Cycle' }, { key: 'stateLabel', label: 'Stage', render: (p) => badge(p.stateLabel, 'info') },
        { key: 'check_ins', label: 'Check-ins', num: true }, { key: 'open_actions', label: 'Open actions', num: true }] })
        : emptyState({ iconName: 'clipboard-check', title: 'You are not reviewing anyone this cycle', text: 'People you review appear here with the stage their review is at.' }))));
  root.modern = true;
  return root;
}
