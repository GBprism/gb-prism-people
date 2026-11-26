// Resource calendar: people × the next 12 weeks. Each cell shows how booked the person is; click it to
// see projects and change allocations. Partners, People Ops and leads add bookings (tentative for proposals).
import { h, icon, button, badge, card, emptyState, field, input, select, toast, openDrawer, statStrip, filterChips } from '/ui.js';

const wk = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const level = (c) => (!c.available ? 'off' : c.over ? 'over' : c.booked >= c.available - 10 ? 'full' : c.booked >= 50 ? 'busy' : c.booked > 0 ? 'light' : 'free');

export async function staffingScreen({ api, me }) {
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

  async function draw() {
    v = await api('/api/staffing');
    const rows = v.people.filter((p) => filter === 'all' || (filter === 'over' ? v.summary.over.includes(p.name) : filter === 'free' ? v.summary.bench.includes(p.name) : p.id === me.id));
    const grid = h('div', { class: 'table-wrap' }, h('table', { class: 'data staff-grid' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Person'), v.weeks.map((w) => h('th', { scope: 'col', class: 'num' }, wk(w.start), w.workdays < 5 ? h('span', { class: 'muted staff-wd' }, ` ${w.workdays}d`) : null)))),
      h('tbody', {}, rows.map((p) => h('tr', {}, h('th', { scope: 'row' }, h('strong', {}, p.name), h('div', { class: 'muted staff-sub' }, [p.title, p.utilisation?.pct != null ? `utilisation ${p.utilisation.pct}%${p.utilisation.target ? ` / target ${p.utilisation.target}%` : ''}` : null].filter(Boolean).join(' · '))),
        p.weeks.map((c) => h('td', { class: 'staff-td' }, h('button', { type: 'button', class: `staff-cell ${level(c)}${c.tentative ? ' tent' : ''}`, onclick: () => cellDrawer(p, c),
          'aria-label': `${p.name}, week of ${wk(c.week)}: ${c.available ? `${c.booked}% booked of ${c.available}% available` : 'away'}` }, c.available ? `${c.booked}%` : 'off'))))))));
    root.replaceChildren(
      h('div', { class: 'toolbar' }, filterChips([{ value: 'all', label: 'Everyone', count: v.people.length }, { value: 'over', label: 'Over-booked (4 weeks)', count: v.summary.over.length },
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
