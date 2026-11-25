// Team inbox: everything waiting for you, filterable by kind, plus your team's review progress.
import { h, icon, badge, card, emptyState, dataTable, filterChips } from '/ui.js';

const KIND = { review: ['Reviews', 'clipboard-check'], request: ['Time off', 'calendar-days'], feedback: ['Feedback', 'messages-square'], calibration: ['Calibration', 'scale'],
  contribution: ['Projects', 'folder-kanban'], assignment: ['Projects', 'folder-kanban'], clarification: ['Questions', 'circle-help'],
  expense: ['Expenses', 'receipt'], timesheet: ['Timesheets', 'timer'], letter: ['Letters', 'mail-check'], cv: ['CVs', 'id-card'], policy: ['Policies', 'book-open-check'], document: ['Company documents', 'file-check-2'] };
const fmt = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null);

export async function inboxScreen({ api }) {
  const [{ items }, progress] = await Promise.all([api('/api/inbox'), api('/api/team/progress').catch(() => [])]);
  const group = (t) => (t === 'assignment' ? 'contribution' : t);
  let filter = 'all';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(new Date());
  const list = h('ul', { class: 'task-list', 'aria-label': 'Waiting for you' });
  const draw = () => {
    const shown = items.filter((i) => filter === 'all' || group(i.type) === filter);
    list.replaceChildren(...(shown.length ? shown.map((i) => {
      const [, ic] = KIND[i.type] || ['', 'circle-dot']; const overdue = i.due && i.due < today && i.type !== 'request';
      return h('li', {}, h('a', { class: `task${overdue ? ' is-overdue' : ''}`, href: i.link },
        h('span', { class: 'task-app' }, icon(ic, { size: 'lg' })),
        h('span', { class: 'task-title' }, h('strong', {}, i.kind), ` · ${i.title}`, i.warnings ? h('span', { class: 'muted' }, ` · ${i.warnings} warning${i.warnings === 1 ? '' : 's'}`) : null),
        overdue ? badge('Overdue', 'danger', 'clock') : i.state ? badge(i.state, 'neutral') : null,
        h('span', { class: 'task-due' }, i.due ? [icon('calendar-days'), i.type === 'request' ? `Starts ${fmt(i.due)}` : fmt(i.due)] : h('span', { class: 'muted' }, 'No due date')),
        icon('chevron-right', { flip: true })));
    }) : [h('li', {}, emptyState({ iconName: 'party-popper', title: 'Nothing waiting for you', text: 'Reviews, requests and feedback that need you appear here.' }))]));
  };
  draw();
  const kinds = [...new Set(items.map((i) => group(i.type)))];
  const chips = kinds.length > 1 ? filterChips([{ value: 'all', label: 'All', count: items.length }, ...kinds.map((k) => ({ value: k, label: KIND[k]?.[0] || k, iconName: KIND[k]?.[1], count: items.filter((i) => group(i.type) === k).length }))], 'all', (v) => { filter = v; draw(); }) : null;
  const root = h('div', { class: 'stack' },
    card({ title: 'Waiting for you', iconName: 'inbox', actions: chips, flush: true, body: list }),
    progress.length ? card({ title: 'Team progress', iconName: 'gauge', flush: true, body: dataTable({ compact: true, rows: progress, columns: [
      { key: 'name', label: 'Person', render: (p) => h('a', { href: `#/review/${p.id}` }, p.name) },
      { key: 'cycle', label: 'Cycle' }, { key: 'stateLabel', label: 'Stage', render: (p) => badge(p.stateLabel, 'info') },
      { key: 'check_ins', label: 'Check-ins', num: true }, { key: 'open_actions', label: 'Open actions', num: true }] }) }) : null);
  root.modern = true;
  return root;
}
