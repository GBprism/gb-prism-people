// Reports: one page for partners and People Ops — people, time off, timesheets, money, projects, reviews.
import { h, icon, card, statStrip, emptyState, select } from '/ui.js';

const JOD = (n) => `${Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: 2 })} JOD`;
const fmt = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const STATE = { draft_plan: 'Drafting goals', approved_plan: 'Goals approved', self_assessment: 'Self-assessment', manager_review: 'Manager review', partner_calibration: 'Calibration', released: 'Released', acknowledged: 'Acknowledged', closed: 'Closed' };

function bars(rows, { unit = '', money = false, label = (r) => r.label } = {}) {
  if (!rows?.length) return h('p', { class: 'muted' }, 'Nothing yet.');
  const max = Math.max(1, ...rows.map((r) => Number(r.n) || 0));
  const ul = h('ul', { class: 'bars' }, rows.map((r) => h('li', {}, h('span', { class: 'bar-label' }, label(r)),
    h('span', { class: 'bar' }, h('span', { 'data-w': String(Math.round(((Number(r.n) || 0) / max) * 100)) })), h('span', { class: 'bar-value' }, money ? JOD(r.n) : `${r.n}${unit}`))));
  setTimeout(() => ul.querySelectorAll('[data-w]').forEach((s) => { s.style.inlineSize = `${s.dataset.w}%`; }), 0);
  return ul;
}
const people = (rows, f) => (rows?.length ? h('ul', { class: 'bullets' }, rows.map((r) => h('li', {}, f(r)))) : h('p', { class: 'muted' }, 'None.'));

export async function reportsScreen({ api }) {
  const root = h('div', { class: 'stack' });
  let year = new Date().getFullYear();
  async function draw() {
    const r = await api(`/api/reports?year=${year}`);
    const yearSel = select([...Array(4)].map((_, i) => [String(new Date().getFullYear() - i), String(new Date().getFullYear() - i)]), { 'aria-label': 'Year', class: 'select select-sm', onchange: (e) => { year = e.target.value; draw(); } });
    yearSel.value = String(year);
    const hit = r.projects.proposals.hit_rate;
    root.replaceChildren(
      h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, 'Totals only — no ratings, reasons or pay.'), yearSel),
      statStrip([{ iconName: 'users', value: String(r.people.headcount), label: 'people' }, { iconName: 'briefcase', value: String(r.projects.active), label: 'active projects' },
        { iconName: 'trophy', value: hit == null ? '—' : `${hit}%`, label: `proposal hit rate ${r.year}` }, { iconName: 'timer', value: r.timesheets.utilisation == null ? '—' : `${r.timesheets.utilisation}%`, label: `time on projects (${r.timesheets.month})` }]),
      h('div', { class: 'report-grid' },
        card({ title: 'People', iconName: 'users', body: h('div', { class: 'stack' }, bars(r.people.by_title),
          h('h3', { class: 'kv-head' }, `Joined in ${r.year}`), people(r.people.joined_this_year, (p) => `${p.name} — ${fmt(p.hire_date)}`),
          h('h3', { class: 'kv-head' }, 'Probation ending in 60 days'), people(r.people.probation_ending, (p) => `${p.name} — ${fmt(p.probation_end)}`)) }),
        card({ title: 'Time off', iconName: 'calendar-days', body: h('div', { class: 'stack' }, h('p', {}, h('strong', {}, String(r.leave.pending)), ' request(s) waiting for a decision'),
          h('h3', { class: 'kv-head' }, `Leave days taken by month, ${r.year}`), bars(r.leave.by_month, { unit: ' d' }),
          h('h3', { class: 'kv-head' }, 'Away in the next 14 days'), people(r.leave.away_next_14, (p) => `${p.name} — ${fmt(p.start_date)}${p.end_date !== p.start_date ? ` to ${fmt(p.end_date)}` : ''}`)) }),
        card({ title: `Timesheets — ${r.timesheets.month}`, iconName: 'timer', body: h('div', { class: 'stack' }, h('p', {}, h('strong', {}, String(r.timesheets.submitted)), ' timesheet(s) submitted'), bars(r.timesheets.by_project, { unit: ' h' })) }),
        card({ title: 'Projects and proposals', iconName: 'folder-kanban', body: h('div', { class: 'stack' },
          h('p', {}, `${r.projects.proposals.submitted} proposals in ${r.year}: ${r.projects.proposals.won} won, ${r.projects.proposals.lost} lost. ${r.projects.running_engagements} engagements running.`),
          h('h3', { class: 'kv-head' }, `Engagements by service line, ${r.year}`), bars(r.projects.by_service_line)) }),
        card({ title: `Employee expenses, ${r.year}`, iconName: 'receipt', body: h('div', { class: 'stack' },
          r.expenses.claims_by_status.length ? h('p', {}, r.expenses.claims_by_status.map((s) => `${s.label}: ${s.n} (${JOD(s.amount)})`).join(' · ')) : null, bars(r.expenses.by_category, { money: true })) }),
        card({ title: `Office costs, ${r.year}`, iconName: 'building-2', body: h('div', { class: 'stack' }, bars(r.expenses.office_by_month, { money: true }), h('h3', { class: 'kv-head' }, 'By category'), bars(r.expenses.office_by_category, { money: true })) }),
        card({ title: `Reviews, ${r.year}`, iconName: 'clipboard-check', body: bars(r.reviews.by_state, { label: (x) => STATE[x.label] || x.label }) }),
        card({ title: 'Policies acknowledged', iconName: 'book-open-check', body: bars(r.policies, { unit: ` of ${r.people.headcount}` }) }),
        card({ title: 'Claude and documents', iconName: 'bot', body: h('div', { class: 'stack' }, h('p', {}, `${r.claude.active} active Claude account(s) used by ${r.claude.people} people.`),
          h('h3', { class: 'kv-head' }, 'Company documents expiring in 60 days'), people(r.documents, (d) => `${d.label} — ${fmt(d.expires_on)}`)) })));
  }
  await draw(); root.modern = true;
  return root;
}
