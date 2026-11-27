// Resource calendar: people × the next 12 weeks. Each cell shows how booked the person is; click it to
// see projects and change allocations. Partners, People Ops and leads add bookings (tentative for proposals).
import { h, icon, button, badge, card, emptyState, field, input, select, toast, openDrawer, statStrip, filterChips } from '/ui.js';

const wk = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const level = (c) => (!c.available ? 'off' : c.over ? 'over' : c.booked >= c.available - 10 ? 'full' : c.booked >= 50 ? 'busy' : c.booked > 0 ? 'light' : 'free');

const d0 = (s) => new Date(`${s}T00:00:00`);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shift = (s, n) => { const d = d0(s); d.setDate(d.getDate() + n); return iso(d); };
const sunday = (s) => shift(s, -d0(s).getDay());
const dayHead = (s) => d0(s).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
const range = (a, b) => `${d0(a).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${d0(b).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
const toneOf = (key) => { let x = 0; for (const c of String(key || '')) x = (x * 31 + c.charCodeAt(0)) % 997; return `block-${(x % 6) + 1}`; };
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('');

// on Friday and Saturday (the Jordanian weekend) the useful week is the one starting on Sunday
const thisWorkWeek = () => { const t = iso(new Date()); return d0(t).getDay() >= 5 ? shift(sunday(t), 7) : sunday(t); };

export async function staffingScreen({ api, me, query = '' }) {
  const qp = new URLSearchParams(query);
  let mode = qp.get('view') === '12' ? '12' : 'week';
  let weekStart = /^\d{4}-\d{2}-\d{2}$/.test(qp.get('w') || '') ? sunday(qp.get('w')) : thisWorkWeek();
  const [projects, pipeline] = await Promise.all([api('/api/active-projects').catch(() => []), api('/api/pipeline').catch(() => ({ rows: [] }))]);
  const people = await api('/api/people').catch(() => []);
  const everyone = [{ id: me.id, name: me.name }, ...people].sort((a, b) => a.name.localeCompare(b.name));
  const openProps = (pipeline.rows || []).filter((p) => ['lead', 'qualifying', 'proposal', 'submitted', 'negotiation'].includes(p.stage));
  const root = h('div', { class: 'stack' });
  let filter = 'all'; let v;

  function cellDrawer(person, c) {
    openDrawer({ title: `${person.name} — week of ${wk(c.week)}`, iconName: 'calendar-days', body: h('div', { class: 'stack' },
      h('p', {}, `Available ${c.available}% of the week (leave and holidays taken out). Booked ${c.booked}%${c.tentative ? `, plus ${c.tentative}% tentative for proposals` : ''}.`),
      c.items.length ? h('ul', { class: 'eng-list' }, c.items.map((it) => h('li', { class: 'kpi-row' }, h('div', {}, h('strong', {}, it.project), h('div', { class: 'muted' }, it.tentative ? 'Tentative (proposal)' : it.estimated ? 'Estimated: no allocation set, time split evenly' : 'Allocation set')),
        h('div', { class: 'eng-side' }, badge(`${it.pct}%`, it.tentative ? 'neutral' : 'info'),
          it.assignment_id && v.canEdit ? (() => { const i = input({ type: 'number', min: 0, max: 100, step: 5, class: 'input input-sm', 'aria-label': `Allocation on ${it.project}`, placeholder: 'auto' });
            return [i, button('Set %', { size: 'sm', onClick: async () => { try { await api(`/api/staffing/assignments/${it.assignment_id}`, { method: 'POST', body: { pct: i.value } }); toast('Allocation saved'); document.querySelector('.drawer header .btn')?.click(); draw(); } catch (e) { toast(e.message, 'danger'); } } })]; })() : null,
          it.booking_id && v.canEdit ? button('', { size: 'sm', variant: 'ghost', iconName: 'trash-2', ariaLabel: 'Remove booking', onClick: async () => { await api(`/api/staffing/bookings/${it.booking_id}/delete`, { method: 'POST' }); document.querySelector('.drawer header .btn')?.click(); draw(); } }) : null)))) : h('p', { class: 'muted' }, 'Nothing booked — available for new work.'),
      v.canEdit ? button('Book this person', { variant: 'primary', iconName: 'plus', onClick: () => { document.querySelector('.drawer header .btn')?.click(); book(person.id, c.week); } }) : null) });
  }

  function book(userId = '', start = '') {
    const who = select([['', 'Choose a person…'], ...everyone.map((p) => [p.id, p.name])], { id: 'bk-who' }); who.value = userId;
    const what = select([['', 'Choose a project or proposal…'], ...projects.map((p) => [`p:${p.id}`, `Project: ${p.name}`]), ...openProps.map((p) => [`o:${p.id}`, `Proposal: ${p.client_short || p.client} – ${p.title_en}`])], { id: 'bk-what' });
    const s = input({ id: 'bk-start', type: 'date', value: start }); const e = input({ id: 'bk-end', type: 'date' });
    const pct = input({ id: 'bk-pct', type: 'number', min: 5, max: 100, step: 5, value: 50 });
    const st = select([['tentative', 'Tentative'], ['confirmed', 'Confirmed']], { id: 'bk-status' });
    what.onchange = () => { st.value = what.value.startsWith('o:') ? 'tentative' : 'confirmed'; };
    openDrawer({ title: 'Book time', iconName: 'calendar-check', body: h('div', { class: 'stack' }, field({ label: 'Person', id: 'bk-who', control: who }), field({ label: 'On', id: 'bk-what', control: what, help: 'Proposals are booked as tentative and become the project’s team when won.' }),
      h('div', { class: 'form-grid' }, field({ label: 'From', id: 'bk-start', control: s }), field({ label: 'To', id: 'bk-end', control: e }), field({ label: 'Share of their time %', id: 'bk-pct', control: pct }), field({ label: 'Status', id: 'bk-status', control: st }))),
    footer: (close) => button('Book', { variant: 'primary', iconName: 'check', onClick: async () => {
      const [k, id] = what.value.split(':');
      try { await api('/api/staffing/bookings', { method: 'POST', body: { user_id: who.value, project_id: k === 'p' ? id : null, proposal_id: k === 'o' ? id : null, start_date: s.value, end_date: e.value, pct: pct.value, status: st.value } }); toast('Booked'); close(); draw(); } catch (err) { toast(err.message, 'danger'); }
    } }) });
  }

  const viewToggle = () => h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, [['week', 'Week'], ['12', '12 weeks']].map(([k, t]) =>
    h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(mode === k), onclick: () => { mode = k; draw(); } }, t)));

  /** One consultant per row, their project blocks across the work days of one week. */
  async function drawWeek() {
    v = await api(`/api/staffing?from=${weekStart}&weeks=4`);
    const wk0 = v.weeks[0]; const w = v.workweek || [0, 1, 2, 3, 4];
    const days = Array.from({ length: 7 }, (_, i) => shift(wk0.start, i)).filter((d) => w.includes(d0(d).getDay()));
    const rows = v.people.filter((p) => filter === 'all' || (filter === 'over' ? p.weeks[0].over : filter === 'free' ? p.weeks[0].free && p.weeks[0].available : p.id === me.id));
    const n = days.length;
    const col = (d) => days.indexOf(d) + 1;
    const rowFor = (p) => {
      const cell = p.weeks[0];
      const blocks = [];
      for (const s of p.spans) {
        const inWeek = days.filter((d) => d >= s.start && d <= s.end && !v.holidays[d]);
        if (!inWeek.length) continue;
        const est = cell.items.find((it) => (s.assignment_id && it.assignment_id === s.assignment_id) || (s.booking_id && it.booking_id === s.booking_id));
        const pct = s.pct ?? est?.pct;
        blocks.push({ kind: 'project', s, from: col(inWeek[0]), to: col(inWeek.at(-1)) + 1, label: s.project, sub: pct != null ? `${s.estimated ? '~' : ''}${pct}%${s.tentative ? ' · tentative' : ''}` : s.tentative ? 'tentative' : '' });
      }
      // away: contiguous runs of days on leave
      const awayDays = days.filter((d) => p.away.some((a) => a.date === d));
      for (let i = 0; i < awayDays.length;) { let j = i; while (j + 1 < awayDays.length && col(awayDays[j + 1]) === col(awayDays[j]) + 1) j++; blocks.push({ kind: 'away', from: col(awayDays[i]), to: col(awayDays[j]) + 1, label: 'Away', sub: '' }); i = j + 1; }
      // lanes: place each block in the first lane where it does not overlap
      const lanes = [];
      for (const b of blocks.sort((x, y) => x.from - y.from)) { let l = lanes.findIndex((end) => end <= b.from); if (l < 0) { l = lanes.length; lanes.push(0); } lanes[l] = b.to; b.lane = l + 1; }
      const track = h('div', { class: 'wk-track' }, days.map((d) => { const c = h('span', { class: `wk-col${v.holidays[d] ? ' is-holiday' : ''}`, 'aria-hidden': 'true' }); c.style.gridColumn = `${col(d)}`; c.style.gridRow = `1 / span ${Math.max(1, lanes.length)}`; return c; }),
        blocks.map((b) => { const el = b.kind === 'away' ? h('span', { class: 'wk-block is-away', title: 'Away (leave)' }, h('span', { class: 'wk-label' }, 'Away'))
          : h('button', { type: 'button', class: `wk-block ${toneOf(b.s.project_id || b.s.project)}${b.s.tentative ? ' is-tentative' : ''}`, title: `${b.label}${b.sub ? ` · ${b.sub}` : ''}`, onclick: () => cellDrawer(p, cell) }, h('span', { class: 'wk-label' }, b.label), b.sub ? h('span', { class: 'wk-sub' }, b.sub) : null);
          el.style.gridColumn = `${b.from} / ${b.to}`; el.style.gridRow = String(b.lane); return el; }));
      track.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
      const capTone = !cell.available ? 'neutral' : cell.over ? 'danger' : cell.free ? 'success' : 'info';
      const capText = !cell.available ? 'Away all week' : cell.over ? 'Over-booked' : cell.free ? 'Has room' : 'Booked';
      const bar = h('span', { class: `cap-fill tone-${capTone}` }); bar.style.inlineSize = `${Math.min(100, cell.available ? Math.round((cell.booked / Math.max(1, cell.available)) * 100) : 0)}%`;
      return h('div', { class: 'wk-row', role: 'row' },
        h('div', { class: 'wk-person', role: 'rowheader' }, h('span', { class: 'avatar avatar-sm', 'aria-hidden': 'true' }, initials(p.name)), h('span', {}, h('strong', {}, p.name), h('span', { class: 'muted' }, p.title || ''))),
        track,
        h('div', { class: 'wk-cap', role: 'cell' }, h('span', { class: 'cap-text' }, cell.available ? `${cell.booked}% of ${cell.available}%` : '—'), h('span', { class: 'cap-bar', 'aria-hidden': 'true' }, bar), badge(capText, capTone)));
    };
    const headTrack = h('div', { class: 'wk-track wk-days' }, days.map((d) => h('span', { class: `wk-day${d === iso(new Date()) ? ' is-today' : ''}${v.holidays[d] ? ' is-holiday' : ''}`, title: v.holidays[d] || '' }, dayHead(d), v.holidays[d] ? h('span', { class: 'wk-hol' }, v.holidays[d]) : null)));
    headTrack.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
    const overN = v.people.filter((p) => p.weeks[0].over).length; const freeN = v.people.filter((p) => p.weeks[0].free && p.weeks[0].available).length;
    root.replaceChildren(
      h('div', { class: 'toolbar' }, viewToggle(),
        h('div', { class: 'week-nav' }, button('', { variant: 'ghost', iconName: 'chevron-left', ariaLabel: 'Previous week', onClick: () => { weekStart = shift(weekStart, -7); drawWeek(); } }),
          h('strong', { class: 'week-range', 'aria-live': 'polite' }, range(days[0], days.at(-1))),
          button('', { variant: 'ghost', iconName: 'chevron-right', ariaLabel: 'Next week', onClick: () => { weekStart = shift(weekStart, 7); drawWeek(); } }),
          weekStart !== thisWorkWeek() ? h('button', { type: 'button', class: 'text-link', onclick: () => { weekStart = thisWorkWeek(); drawWeek(); } }, 'This week') : null),
        v.canEdit ? button('Book time', { variant: 'primary', iconName: 'plus', onClick: () => book('', days[0]) }) : null),
      filterChips([{ value: 'all', label: 'Everyone', count: v.people.length }, { value: 'over', label: 'Over-booked', count: overN }, { value: 'free', label: 'Has room', count: freeN }, { value: 'me', label: 'Me' }], filter, (x) => { filter = x; drawWeek(); }),
      rows.length ? h('div', { class: 'wk-grid', role: 'table', 'aria-label': `Allocations ${range(days[0], days.at(-1))}` },
        h('div', { class: 'wk-row wk-head', role: 'row' }, h('div', { class: 'wk-person', role: 'columnheader' }, `Consultants · ${rows.length}`), headTrack, h('div', { class: 'wk-cap', role: 'columnheader' }, 'Capacity')),
        rows.map(rowFor)) : emptyState({ iconName: 'users', title: 'Nobody matches this filter' }),
      h('p', { class: 'muted' }, icon('info'), ' Blocks show each project across the week. “~” means no allocation is set yet, so the person’s time is split evenly; dashed blocks are tentative proposal time. Click a block to see or change allocations.'));
  }

  async function draw() {
    if (mode === 'week') return drawWeek();
    v = await api('/api/staffing');
    const rows = v.people.filter((p) => filter === 'all' || (filter === 'over' ? v.summary.over.includes(p.name) : filter === 'free' ? v.summary.bench.includes(p.name) : p.id === me.id));
    const grid = h('div', { class: 'table-wrap' }, h('table', { class: 'data staff-grid' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Person'), v.weeks.map((w) => h('th', { scope: 'col', class: 'num' }, wk(w.start), w.workdays < 5 ? h('span', { class: 'muted staff-wd' }, ` ${w.workdays}d`) : null)))),
      h('tbody', {}, rows.map((p) => h('tr', {}, h('th', { scope: 'row' }, h('strong', {}, p.name), h('div', { class: 'muted staff-sub' }, [p.title, p.utilisation?.pct != null ? `utilisation ${p.utilisation.pct}%${p.utilisation.target ? ` / target ${p.utilisation.target}%` : ''}` : null].filter(Boolean).join(' · '))),
        p.weeks.map((c) => h('td', { class: 'staff-td' }, h('button', { type: 'button', class: `staff-cell ${level(c)}${c.tentative ? ' tent' : ''}`, onclick: () => cellDrawer(p, c),
          'aria-label': `${p.name}, week of ${wk(c.week)}: ${c.available ? `${c.booked}% booked of ${c.available}% available` : 'away'}` }, c.available ? `${c.booked}%` : 'off'))))))));
    root.replaceChildren(
      h('div', { class: 'toolbar' }, viewToggle(), filterChips([{ value: 'all', label: 'Everyone', count: v.people.length }, { value: 'over', label: 'Over-booked (4 weeks)', count: v.summary.over.length },
        { value: 'free', label: 'Free now', count: v.summary.bench.length }, { value: 'me', label: 'Me' }], filter, (x) => { filter = x; draw(); }),
        v.canEdit ? button('Book time', { variant: 'primary', iconName: 'plus', onClick: () => book() }) : null),
      statStrip([{ iconName: 'triangle-alert', value: String(v.summary.over.length), label: 'over-booked in the next 4 weeks' }, { iconName: 'user-check', value: String(v.summary.bench.length), label: 'with half their time free now' },
        { iconName: 'briefcase', value: String(projects.length), label: 'active projects' }]),
      h('div', { class: 'legend staff-legend' }, ['free', 'light', 'busy', 'full', 'over', 'off'].map((k) => h('span', {}, h('span', { class: `staff-cell ${k} sample`, 'aria-hidden': 'true' }), { free: 'Free', light: 'Under 50%', busy: '50–90%', full: 'Full', over: 'Over-booked', off: 'Away' }[k])),
        h('span', {}, h('span', { class: 'staff-cell busy tent sample', 'aria-hidden': 'true' }), 'Has tentative proposal time')),
      rows.length ? grid : emptyState({ iconName: 'users', title: 'Nobody matches this filter' }),
      h('p', { class: 'muted' }, icon('info'), ' Percentages are estimated when a project has no allocation set: the person’s time is split evenly across their running projects. Leads set allocations by clicking a week.'));
  }
  await draw(); root.modern = true;
  return root;
}
