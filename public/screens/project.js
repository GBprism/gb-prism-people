// Project detail — "My engagement". Name, client, lead and the person's own assignment first,
// then the next milestone, a timeline (when real dates exist) and the deliverables by workstream.
// The canonical place for a project; the register, close-out and commercial views open from here.
import { h, icon, button, badge, avatar, emptyState } from '/ui.js';

const d0 = (s) => new Date(`${s}T00:00:00`);
const fmt = (s) => (s ? d0(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null);
const fmtShort = (s) => d0(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(new Date());
const cap = (s) => (s ? s.replace(/^\w/, (c) => c.toUpperCase()) : s);
const STATUS = { in_progress: ['In progress', 'info'], submitted: ['In quality review', 'warning'], accepted: ['Done', 'success'], done: ['Done', 'success'], cancelled: ['Cancelled', 'neutral'] };
const ASG = { confirmed: null, historical: null, tentative: 'To be confirmed by the lead', provisional: 'Not yet confirmed' };

/** Percent position of a date inside [from, to]. */
const pos = (s, from, to) => Math.min(100, Math.max(0, ((d0(s) - d0(from)) / Math.max(1, d0(to) - d0(from))) * 100));
const place = (el, left, width) => { el.style.insetInlineStart = `${left}%`; if (width != null) el.style.inlineSize = `${Math.max(width, 1.5)}%`; return el; };

function timeline(v, today) {
  const dates = [v.start_date, v.end_date, ...v.deliverables.map((d) => d.due_date), ...v.team.flatMap((t) => [t.start_date, t.end_date])].filter(Boolean).sort();
  if (dates.length < 2) return null;
  // long engagements: focus on the stretch around today (two months back, four ahead, and the next milestone)
  const shift = (s0, n) => { const d = d0(s0); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  let from = dates[0]; let to = dates.at(-1);
  if (d0(to) - d0(from) > 200 * 864e5 && today > from && today < to) {
    from = [from, shift(today, -60)].sort().at(-1);
    to = [to, [shift(today, 120), v.next?.date].filter(Boolean).sort().at(-1)].sort()[0];
  }
  if (d0(to) - d0(from) < 7 * 864e5) return null;
  // month ticks
  const ticks = []; const t = d0(from); t.setDate(1); t.setMonth(t.getMonth() + 1);
  while (t <= d0(to)) { const iso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-01`; ticks.push(iso); t.setMonth(t.getMonth() + 1); }
  const showToday = today >= from && today <= to;
  const todayLine = () => (showToday ? place(h('span', { class: 'tl-today', 'aria-hidden': 'true' }), pos(today, from, to)) : null);
  const tone = (i) => `block-${(i % 6) + 1}`;
  const dels = v.deliverables.filter((d) => d.due_date && d.status !== 'cancelled' && d.due_date >= from && d.due_date <= to);
  // milestone labels: stack into lanes so they never overlap; flip to the left near the right edge
  const laneEnd = []; const pinLane = new Map();
  for (const d of [...dels].sort((a, b) => a.due_date.localeCompare(b.due_date))) {
    const x = pos(d.due_date, from, to); let l = laneEnd.findIndex((e) => e < x - 1);
    if (l < 0) { l = laneEnd.length; laneEnd.push(0); }
    laneEnd[l] = x + 18; pinLane.set(d.id, l);
  }
  const lanesN = Math.max(1, laneEnd.length);
  const rows = [
    (() => { const r = h('div', { class: 'tl-row tl-milestones' }, h('span', { class: 'tl-label' }, h('strong', {}, 'Milestones'), h('span', { class: 'muted' }, `${dels.length} dated`)),
      h('div', { class: 'tl-track' }, todayLine(), dels.map((d) => { const done = ['accepted', 'done'].includes(d.status); const late = !done && d.due_date < today;
        const x = pos(d.due_date, from, to);
        const pin = place(h('span', { class: `tl-pin${done ? ' is-done' : late ? ' is-late' : ''}${x > 78 ? ' is-flipped' : ''}`, title: `${d.milestone || d.title} — ${fmt(d.due_date)}${done ? ' (done)' : late ? ' (overdue)' : ''}` },
          h('span', { class: 'tl-pin-dot', 'aria-hidden': 'true' }), h('span', { class: 'tl-pin-label' }, d.milestone || d.title)), x);
        pin.style.insetBlockStart = `${6 + pinLane.get(d.id) * 22}px`; return pin; })));
      r.querySelector('.tl-track').style.blockSize = `${12 + lanesN * 22}px`; return r; })(),
    ...v.team.map((m, i) => { const s = [m.start_date || from, from].sort().at(-1); const e = [m.end_date || to, to].sort()[0];
      return h('div', { class: 'tl-row' }, h('span', { class: 'tl-label' }, h('strong', {}, m.name), h('span', { class: 'muted' }, cap(m.role) || '—')),
        h('div', { class: 'tl-track' }, todayLine(), place(h('span', { class: `tl-bar ${tone(i)}${m.status === 'tentative' || m.status === 'provisional' ? ' is-tentative' : ''}`, title: `${m.name}: ${fmt(s)} → ${fmt(e)}${m.allocation_pct != null ? ` · ${m.allocation_pct}%` : ''}` },
          h('span', {}, m.allocation_pct != null ? `${m.allocation_pct}%` : cap(m.role) || '')), pos(s, from, to), pos(e, from, to) - pos(s, from, to)))); }),
  ];
  return h('section', { class: 'card', 'aria-labelledby': 'tl-h' },
    h('header', { class: 'card-header' }, h('h2', { id: 'tl-h' }, 'Timeline'), h('div', { class: 'card-actions muted' }, `${fmt(from)} → ${fmt(to)}`)),
    h('div', { class: 'card-body' }, h('div', { class: 'timeline', role: 'img', 'aria-label': `Timeline from ${fmt(from)} to ${fmt(to)}: ${dels.length} dated deliverables and ${v.team.length} people` },
      h('div', { class: 'tl-row tl-head' }, h('span', { class: 'tl-label' }), h('div', { class: 'tl-track' }, ticks.map((m) => place(h('span', { class: 'tl-tick' }, d0(m).toLocaleDateString('en-GB', { month: 'short' })), pos(m, from, to))),
        showToday ? place(h('span', { class: 'tl-today-label' }, 'Today'), pos(today, from, to)) : null)),
      rows)));
}

export async function projectScreen({ api, me, id }) {
  const v = await api(`/api/projects/${encodeURIComponent(id)}/overview`);
  const today = todayIso();
  const people = await api('/api/team').catch(() => []);
  const photo = (m) => people.find((p) => p.id === m.id) || m;

  // ---- header: back, name, client; team faces
  const head = h('header', { class: 'proj-head' },
    h('a', { class: 'back-link', href: '#/active' }, icon('chevron-left', { flip: true }), 'Projects'),
    h('div', { class: 'proj-title-row' },
      h('div', { class: 'proj-titles' }, h('h1', {}, v.name), h('p', { class: 'muted' }, [v.client, v.sector, v.country].filter(Boolean).join(' · ') || 'Client not recorded')),
      v.team.length ? h('ul', { class: 'face-stack', 'aria-label': `Team: ${v.team.map((m) => m.name).join(', ')}` }, v.team.slice(0, 6).map((m) => h('li', { title: m.name }, avatar(photo(m), 'sm'))), v.team.length > 6 ? h('li', { class: 'face-more' }, `+${v.team.length - 6}`) : null) : null));

  // ---- facts: lead, my assignment, dates
  const mine = v.me;
  const facts = h('dl', { class: 'proj-facts' },
    h('div', {}, h('dt', {}, 'Project lead'), h('dd', {}, v.lead?.name || 'To be set')),
    h('div', {}, h('dt', {}, 'Your assignment'), h('dd', {}, mine ? [cap(mine.role) || 'Team member', mine.allocation_pct != null ? ` · ${mine.allocation_pct}% of your time` : '', ASG[mine.status] ? h('span', { class: 'muted' }, ` · ${ASG[mine.status]}`) : null] : 'You are not on this project')),
    h('div', {}, h('dt', {}, 'Dates'), h('dd', {}, `${fmt(v.start_date) || 'Start not set'} → ${fmt(v.end_date) || 'ongoing'}`)),
    mine ? h('div', {}, h('dt', {}, 'Your hours logged'), h('dd', {}, `${Math.round(mine.hours)} h`)) : null);

  // ---- next milestone (dominant) and counts
  const daysTo = v.next ? Math.round((d0(v.next.date) - d0(today)) / 864e5) : null;
  const nextCard = h('div', { class: `next-tile${v.next ? '' : ' is-empty'}` },
    h('span', { class: 'next-eyebrow' }, 'Next milestone'),
    v.next ? [h('strong', { class: 'next-title' }, v.next.title), h('span', { class: 'next-meta' }, `${fmt(v.next.date)} · ${daysTo === 0 ? 'today' : daysTo === 1 ? 'tomorrow' : `in ${daysTo} days`}`, v.next.deliverable !== v.next.title ? ` · ${v.next.deliverable}` : '')]
      : [h('strong', { class: 'next-title' }, v.full ? 'No dated milestone' : 'Visible to the team'), h('span', { class: 'next-meta' }, v.full ? 'Add due dates to deliverables to see them here.' : 'Deliverables and milestones are shown to the people on this project.')]);
  const tiles = v.full ? h('div', { class: 'count-tiles' },
    h('div', { class: 'count-tile' }, h('strong', {}, `${v.counts.done}/${v.counts.deliverables}`), h('span', {}, 'deliverables done')),
    h('div', { class: `count-tile${v.counts.overdue ? ' is-alert' : ''}` }, h('strong', {}, String(v.counts.overdue)), h('span', {}, v.counts.overdue === 1 ? 'deliverable overdue' : 'deliverables overdue')),
    h('div', { class: 'count-tile' }, h('strong', {}, String(v.counts.team)), h('span', {}, v.counts.team === 1 ? 'person on the team' : 'people on the team'))) : null;

  // ---- links: one primary per screen, the rest are quiet
  const links = h('div', { class: 'proj-links' },
    v.drive_url ? h('a', { class: 'btn btn-primary', href: v.drive_url, target: '_blank', rel: 'noopener' }, icon('folder-open'), h('span', {}, 'Open the Drive folder')) : null,
    v.chat_url ? h('a', { class: 'text-link', href: v.chat_url, target: '_blank', rel: 'noopener' }, 'Team chat', icon('external-link')) : null,
    v.meet_url ? h('a', { class: 'text-link', href: v.meet_url, target: '_blank', rel: 'noopener' }, 'Standing Meet', icon('external-link')) : null,
    v.can.register ? h('a', { class: 'text-link', href: `#/projects?p=${v.id}` }, 'Deliverables & contributions', icon('arrow-right')) : null,
    v.can.closeout ? h('a', { class: 'text-link', href: `#/library?closeout=${v.engagement_id}` }, 'Close-out', icon('arrow-right')) : null,
    v.can.commercial ? h('a', { class: 'text-link', href: `#/commercial?p=${v.id}` }, 'Budget & burn', icon('arrow-right')) : null);

  // ---- deliverables by workstream
  const groups = new Map();
  for (const d of v.deliverables) { const k = d.workstream || 'Deliverables'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); }
  const delCard = v.full ? h('section', { class: 'card', 'aria-labelledby': 'dl-h' },
    h('header', { class: 'card-header' }, h('h2', { id: 'dl-h' }, 'Workstreams & deliverables')),
    h('div', { class: 'card-body flush' }, v.deliverables.length ? [...groups].map(([ws, list]) => h('div', { class: 'ws-group' }, groups.size > 1 || ws !== 'Deliverables' ? h('h3', { class: 'ws-title' }, ws) : null,
      h('ul', { class: 'del-list' }, list.map((d) => { const [lab, tone] = STATUS[d.status] || [cap(d.status), 'neutral']; const late = d.due_date && d.due_date < today && !['accepted', 'done', 'cancelled'].includes(d.status);
        return h('li', { class: 'del-row' }, h('span', { class: 'del-name' }, h('strong', {}, d.title), d.milestone && d.milestone !== d.title ? h('span', { class: 'muted' }, d.milestone) : null),
          h('span', { class: `del-due${late ? ' is-late' : ''}` }, d.due_date ? (late ? `Overdue · ${fmtShort(d.due_date)}` : fmtShort(d.due_date)) : h('span', { class: 'muted' }, 'No date')),
          badge(lab, tone), d.drive_url ? h('a', { class: 'btn btn-ghost btn-sm btn-icon', href: d.drive_url, target: '_blank', rel: 'noopener', 'aria-label': `Open ${d.title} in Drive` }, icon('external-link')) : h('span', { class: 'del-spacer' })); }))))
      : emptyState({ iconName: 'file-text', title: 'No deliverables recorded yet', text: 'The project lead adds deliverables and due dates; they appear here and on the timeline.', action: v.can.register ? button('Add deliverables', { iconName: 'plus', href: `#/projects?p=${v.id}` }) : null }))) : null;

  const scope = v.scope || v.title ? h('p', { class: 'proj-scope' }, v.scope || v.title) : null;
  const root = h('div', { class: 'project-page' }, head, facts, h('div', { class: 'proj-top' }, nextCard, tiles), links, scope, timeline(v, today), delCard);
  root.modern = true; root.noHeader = true; root.area = 'work';
  return root;
}
