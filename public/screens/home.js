// Employee Home — "My week at GB". One calm page:
//   Needs your attention (the one thing to do now, then up to three more) · This week · My projects.
// The lead card adapts: onboarding in the first weeks, the review step when one is due, otherwise
// the next task, or what is coming up when the person is up to date. Uses /api/my-week only.
import { h, icon, button, emptyState } from '/ui.js';

const KIND = {
  onboarding: ['Onboarding', 'user-plus'], review: ['Performance', 'clipboard-check'], timesheet: ['Timesheet', 'timer'], deliverable: ['Deliverable', 'file-check-2'],
  feedback: ['Feedback', 'messages-square'], survey: ['Team pulse', 'heart'], policy: ['Policy', 'book-open-check'], closeout: ['Close-out', 'lightbulb'],
  pipeline: ['Pipeline', 'trending-up'], offboarding: ['Leaving', 'log-out'], development: ['Development', 'target'], ai: ['AI', 'sparkles'],
  card: ['Task', 'list-checks'], card_review: ['Review requested', 'eye'], mention: ['Mention', 'messages-square'],
};
const AGENDA = { leave: ['Leave', 'leave'], offsite: ['Off-site', 'leave'], holiday: ['Holiday', 'holiday'], deadline: ['Deadline', 'deadline'], milestone: ['Milestone', 'milestone'] };
const d0 = (s) => new Date(`${s}T00:00:00`);
const fmtDay = (s) => d0(s).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtShort = (s) => d0(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const addDays = (s, n) => { const d = d0(s); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hourAmman = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Amman', hour: 'numeric', hour12: false }).format(new Date()));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

function dueLabel(due, today) {
  if (!due) return null;
  const days = Math.round((d0(due) - d0(today)) / 864e5);
  if (days < 0) return { text: days === -1 ? 'Overdue since yesterday' : `Overdue · was due ${fmtShort(due)}`, tone: 'danger' };
  if (days === 0) return { text: 'Due today', tone: 'warning' };
  if (days === 1) return { text: 'Due tomorrow', tone: 'warning' };
  return { text: `Due ${fmtShort(due)}`, tone: 'neutral' };
}
const dayName = (s, today) => (s === today ? 'Today' : s === addDays(today, 1) ? 'Tomorrow' : fmtDay(s));

export async function homeScreen({ api, me }) {
  const v = await api('/api/my-week');
  const first = me.name.split(' ')[0];
  const hr = hourAmman();
  const greeting = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const today = v.today;

  // ---------------------------------------------------------------- greeting
  const sub = {
    onboarding: v.onboarding ? `Day ${Math.max(1, v.onboarding.day)} at GB Advisory. Here is your next step.` : '',
    review: 'Your review needs you this week.',
    tasks: `${v.attention.length} thing${v.attention.length === 1 ? '' : 's'} need${v.attention.length === 1 ? 's' : ''} you.`,
    clear: 'You’re up to date. Here’s what’s coming next.',
  }[v.mode];
  const head = h('header', { class: 'home-hero' },
    h('p', { class: 'home-date' }, new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Amman' })),
    h('h1', {}, `${greeting}, ${first}`),
    h('p', { class: 'home-sub' }, sub));

  // ---------------------------------------------------- needs your attention
  const [lead, ...rest] = v.attention;
  const leadCard = () => {
    if (v.mode === 'onboarding') {
      const o = v.onboarding; const pct = Math.round((o.done / Math.max(1, o.total)) * 100);
      return h('div', { class: 'focus focus-onboarding' },
        h('span', { class: 'focus-eyebrow' }, icon('user-plus'), `Onboarding · ${o.done} of ${o.total} done`),
        h('h3', { class: 'focus-title' }, lead.title),
        (() => { const bar = h('span'); bar.style.inlineSize = `${pct}%`; return h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Onboarding progress' }, bar); })(),
        h('div', { class: 'focus-actions' }, button(lead.action, { variant: 'primary', iconName: 'arrow-right', href: lead.link })));
    }
    if (!lead) {
      const next = v.week[0] || null; const proj = v.projects.find((p) => p.next);
      return h('div', { class: 'focus focus-clear' },
        h('span', { class: 'focus-eyebrow' }, icon('circle-check'), 'Nothing waiting for you'),
        h('h3', { class: 'focus-title' }, next ? `Next: ${next.title}` : proj ? `Next on ${proj.name}: ${proj.next.title}` : 'Enjoy the quiet'),
        h('p', { class: 'focus-meta' }, next ? `${dayName(next.date, today)}${next.detail ? ` · ${next.detail}` : ''}` : proj ? fmtDay(proj.next.date) : 'New reviews, timesheets and requests will appear here when they need you.'),
        next?.link || proj ? h('div', { class: 'focus-actions' }, h('a', { class: 'text-link', href: next?.link || `#/project/${proj.id}` }, 'Open', icon('arrow-right'))) : null);
    }
    const due = dueLabel(lead.due, today); const [label, ic] = KIND[lead.kind] || [lead.detail, 'circle-dot'];
    return h('div', { class: `focus${lead.overdue ? ' is-overdue' : ''}` },
      h('span', { class: 'focus-eyebrow' }, icon(ic), label),
      h('h3', { class: 'focus-title' }, lead.title),
      h('p', { class: 'focus-meta' }, [lead.detail && lead.detail !== label ? lead.detail : null].filter(Boolean).join(' · '), due ? h('span', { class: `due due-${due.tone}` }, icon('clock'), due.text) : null),
      h('div', { class: 'focus-actions' }, button(lead.action || 'Open', { variant: 'primary', iconName: 'arrow-right', href: lead.link })));
  };
  const row = (a) => { const due = dueLabel(a.due, today); const [label, ic] = KIND[a.kind] || [a.detail, 'circle-dot'];
    return h('li', {}, h('a', { class: `attn-row${a.overdue ? ' is-overdue' : ''}`, href: a.link },
      h('span', { class: 'attn-icon', 'aria-hidden': 'true' }, icon(ic)),
      h('span', { class: 'attn-text' }, h('strong', {}, a.title), h('span', { class: 'muted' }, a.detail && a.detail !== a.title ? a.detail : label)),
      due ? h('span', { class: `due due-${due.tone}` }, due.text) : null, icon('chevron-right', { flip: true }))); };
  const others = rest;
  const list = h('ul', { class: 'attn-list', 'aria-label': 'Other things that need you' });
  let expanded = false;
  const more = h('button', { class: 'text-link', type: 'button', onclick: () => { expanded = !expanded; drawRows(); } });
  function drawRows() {
    list.replaceChildren(...(expanded ? others : others.slice(0, 3)).map(row));
    more.hidden = others.length <= 3;
    more.replaceChildren(expanded ? 'Show fewer' : `View all tasks (${v.attention.length})`, icon(expanded ? 'chevron-down' : 'arrow-right'));
  }
  drawRows();
  const managerLink = me.nav.manager && v.team_waiting ? h('a', { class: 'manager-hint', href: '#/manager' }, icon('users'), h('span', {}, `${v.team_waiting} decision${v.team_waiting === 1 ? '' : 's'} waiting in Manager`), icon('arrow-right')) : null;
  const attention = h('section', { class: 'card home-attn', 'aria-labelledby': 'attn-h' },
    h('header', { class: 'card-header' }, h('h2', { id: 'attn-h' }, 'Needs your attention')),
    h('div', { class: 'card-body' }, leadCard(), others.length ? list : null, h('div', { class: 'attn-foot' }, more, managerLink)));

  // ----------------------------------------------------------------- this week
  let view = store.get('prism.week.view') === 'calendar' ? 'calendar' : 'agenda';
  const weekBody = h('div', { class: 'week-body' });
  const toggle = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show this week as' }, ['agenda', 'calendar'].map((k) =>
    h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(view === k), onclick: (e) => { view = k; store.set('prism.week.view', k); e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); drawWeek(); } }, k === 'agenda' ? 'Agenda' : 'Calendar')));
  function drawWeek() {
    if (!v.week.length && view === 'agenda') return weekBody.replaceChildren(h('p', { class: 'muted week-empty' }, 'Nothing dated in the next two weeks — no leave, deadlines or milestones.'));
    if (view === 'agenda') {
      const byDay = new Map(); for (const e of v.week.slice(0, 8)) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
      return weekBody.replaceChildren(h('ol', { class: 'agenda' }, [...byDay].map(([date, items]) => h('li', { class: 'agenda-day' },
        h('span', { class: `agenda-date${date === today ? ' is-today' : ''}` }, dayName(date, today)),
        h('ul', {}, items.map((e) => { const [lab, tone] = AGENDA[e.kind] || ['', 'milestone'];
          const body = [h('span', { class: `chip-kind kind-${tone}` }, lab), h('span', { class: 'agenda-title' }, e.title, e.end && e.end !== e.date ? h('span', { class: 'muted' }, ` → ${fmtShort(e.end)}`) : null), e.detail ? h('span', { class: 'muted agenda-detail' }, e.detail) : null];
          return h('li', {}, e.link ? h('a', { class: 'agenda-item', href: e.link }, body) : h('div', { class: 'agenda-item' }, body)); }))))),
      ...(v.week.length > 8 ? [h('p', { class: 'muted' }, `+ ${v.week.length - 8} more in the next two weeks`)] : []));
    }
    // two-week calendar: work days highlighted, dated items as small labelled marks
    const start = addDays(today, -d0(today).getDay());
    const days = Array.from({ length: 14 }, (_, i) => addDays(start, i));
    const on = (d) => v.week.filter((e) => e.date === d || (e.end && e.date <= d && e.end >= d));
    weekBody.replaceChildren(h('div', { class: 'mini-cal', role: 'grid', 'aria-label': 'Next two weeks' },
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n) => h('span', { class: 'mini-dow', role: 'columnheader' }, n)),
      days.map((d) => { const items = on(d); const work = (v.workweek || [0, 1, 2, 3, 4]).includes(d0(d).getDay());
        return h('div', { class: `mini-day${d === today ? ' is-today' : ''}${work ? '' : ' is-off'}${d < today ? ' is-past' : ''}`, role: 'gridcell', 'aria-label': `${fmtDay(d)}${items.length ? `: ${items.map((e) => e.title).join(', ')}` : ''}` },
          h('span', { class: 'mini-num' }, String(d0(d).getDate())),
          items.slice(0, 2).map((e) => h('span', { class: `mini-mark kind-${(AGENDA[e.kind] || [])[1] || 'milestone'}`, title: e.title }, e.title)),
          items.length > 2 ? h('span', { class: 'mini-more' }, `+${items.length - 2}`) : null); })));
  }
  drawWeek();
  const thisWeek = h('section', { class: 'card home-week', 'aria-labelledby': 'week-h' },
    h('header', { class: 'card-header' }, h('h2', { id: 'week-h' }, 'This week'), h('div', { class: 'card-actions' }, toggle)),
    h('div', { class: 'card-body' }, weekBody));

  // ---------------------------------------------------------------- my projects
  const projects = h('section', { class: 'card home-projects', 'aria-labelledby': 'proj-h' },
    h('header', { class: 'card-header' }, h('h2', { id: 'proj-h' }, 'My projects'), h('div', { class: 'card-actions' }, h('a', { class: 'text-link', href: '#/active' }, 'Open Projects', icon('arrow-right')))),
    h('div', { class: 'card-body flush' }, v.projects.length ? h('ul', { class: 'proj-list' }, v.projects.map((p) => h('li', {}, h('a', { class: 'proj-row', href: `#/project/${p.id}` },
      h('span', { class: 'proj-name' }, h('strong', {}, p.name), h('span', { class: 'muted' }, [p.client, p.role ? p.role.replace(/^\w/, (c) => c.toUpperCase()) : null].filter(Boolean).join(' · '))),
      h('span', { class: 'proj-next' }, p.next ? [h('span', { class: 'muted' }, 'Next'), h('span', {}, p.next.title), h('span', { class: 'proj-date' }, fmtShort(p.next.date))] : h('span', { class: 'muted' }, 'No dated milestone')),
      icon('chevron-right', { flip: true })))))
      : emptyState({ iconName: 'briefcase', title: 'You are not on a running project', text: 'When you are assigned to an engagement it appears here with its next milestone.' })));

  const root = h('div', { class: 'home' }, head, h('div', { class: 'home-grid' }, attention, thisWeek), projects);
  root.modern = true; root.noHeader = true;
  return root;
}
