// HR profiles. "My profile" for everyone (read-only); "People" directory with an
// edit drawer for People Ops and partners. The server enforces who may see what:
// the person, People Ops/admin and partners — never managers or peers.
import { h, icon, button, badge, card, banner, emptyState, dataTable, filterChips, openDrawer, field, input, textarea, toast } from '/ui.js';

const fmt = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const monthYear = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '');
const split = (s) => String(s || '').split(/;\s*/).map((x) => x.trim()).filter(Boolean);
const ageText = (p) => (p.age != null ? `${p.age}` : p.age_recorded != null ? `${p.age_recorded}${p.age_recorded_on ? ` (as of ${monthYear(p.age_recorded_on)})` : ''}` : 'Not on file');

/** Tone for free-text statuses such as "Not on file", "Policy: yes – confirm", "Yes (2024)". */
export function statusTone(s) {
  const t = String(s || '').toLowerCase();
  if (!t || /not on file|not verified|no reply|check if|missing/.test(t)) return 'warning';
  if (/confirm|tbc|~|asked|declined/.test(t)) return 'info';
  if (/^yes|eligible|enrolled|issued|active|\d{4}-\d{2}-\d{2}/.test(t)) return 'success';
  return 'neutral';
}
const statusBadge = (s) => badge(s || 'Not on file', statusTone(s));

const ASG = { confirmed: ['Confirmed', 'success'], historical: ['Confirmed', 'success'], tentative: ['Lead to confirm', 'info'], provisional: ['Unverified lead', 'warning'] };
function kv(rows) {
  return h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]));
}

function profileBody(p) {
  const emp = card({ title: 'Employment', iconName: 'briefcase', body: kv([
    ['Title', p.title], ['Level (2026)', p.level || p.title], ['Manager', p.manager],
    ['Joined GB', p.hire_date ? `${fmt(p.hire_date)} · ${p.years_with_gb} years` : '—'],
    ['Probation', p.probation_end ? [statusBadge(`Ended ${fmt(p.probation_end)}`), p.probation_status ? h('span', { class: 'muted' }, ` ${p.probation_status}`) : null] : statusBadge(p.probation_status)],
    ['Post-probation contract', statusBadge(p.contract_status)],
  ]) });
  const personal = card({ title: 'Personal & benefits', iconName: 'shield-check', body: kv([
    ['Date of birth', p.date_of_birth ? fmt(p.date_of_birth) : statusBadge('Not on file')], ['Age', ageText(p)],
    ['Social security', statusBadge(p.social_security_status)], ['Medical insurance', [statusBadge(p.medical_insurance_status), h('span', { class: 'muted' }, ' opt-in, 50% paid by GB')]],
    ['Gym stipend', [statusBadge(p.gym_stipend_status), h('span', { class: 'muted' }, ' 35 JOD a month')]],
  ]) });
  const work = card({ title: '2026 work', iconName: 'folder-kanban', body: h('div', { class: 'stack' },
    p.assignments.length ? h('ul', { class: 'asg-list' }, p.assignments.map((a) => {
      const [label, tone] = ASG[a.status] || [a.status, 'neutral'];
      return h('li', {}, h('div', {}, h('strong', {}, a.project), h('span', { class: 'muted' }, ` · ${a.kind === 'proposal' ? 'Proposal' : 'Engagement'}${a.lead ? ` · lead ${a.lead}` : ''}`)),
        h('div', { class: 'asg-meta' }, h('span', {}, a.role), a.start_date ? h('span', { class: 'muted' }, `${monthYear(a.start_date)}${a.end_date ? ` – ${monthYear(a.end_date)}` : ' onward'}`) : null, badge(label, tone)));
    })) : h('p', { class: 'muted' }, 'No projects in the register yet.'),
    split(p.projects_summary).length ? h('div', {}, h('h3', { class: 'kv-head' }, 'Projects and roles (from the 2026 review workbook)'), h('ul', { class: 'bullets' }, split(p.projects_summary).map((x) => h('li', {}, x)))) : null,
    h('div', {}, h('h3', { class: 'kv-head' }, 'Proposals worked on'), split(p.proposals_summary).length ? h('ul', { class: 'bullets' }, split(p.proposals_summary).map((x) => h('li', {}, x))) : h('p', { class: 'muted' }, 'None recorded.'))) });
  const more = (p.leave_history || p.equipment || p.learning_notes) ? h('div', { class: 'profile-grid' },
    card({ title: 'Leave history', iconName: 'history', body: p.leave_history ? h('ul', { class: 'bullets' }, p.leave_history.split(/\s·\s/).map((x) => h('li', {}, x))) : h('p', { class: 'muted' }, 'Not recorded.') }),
    card({ title: 'Equipment & learning', iconName: 'briefcase', body: kv([['Laptop & software', p.equipment || 'Not in the IT register'], ['Learning', p.learning_notes || '—']]) })) : null;
  const gaps = p.gaps_list.length ? banner({ tone: 'warning', title: 'Still to confirm', text: p.gaps_list.join(' · ') }) : null;
  const foot = h('p', { class: 'profile-note' }, icon('lock'), ` Visible only to ${p.can_edit ? 'this person' : 'you'}, People Ops and partners.`, p.source ? ` Source: ${p.source}${p.updated_at ? `, updated ${fmt(p.updated_at.slice(0, 10))}` : ''}.` : '');
  return [gaps, h('div', { class: 'profile-grid' }, emp, personal), work, more, foot];
}

export async function myProfileScreen({ api }) {
  const p = await api('/api/profile');
  const root = h('div', { class: 'profile' }, profileBody(p));
  root.modern = true;
  return root;
}

const EDIT = [
  ['level', 'Level (2026)'], ['probation_status', 'Probation'], ['contract_status', 'Post-probation contract'], ['date_of_birth', 'Date of birth (yyyy-mm-dd)'],
  ['social_security_status', 'Social security'], ['medical_insurance_status', 'Medical insurance'], ['gym_stipend_status', 'Gym stipend'],
  ['leave_history', 'Leave history (separate years with ·)', true], ['equipment', 'Laptop & software', true], ['learning_notes', 'Learning', true],
  ['projects_summary', 'Projects and roles (separate with ;)', true], ['proposals_summary', 'Proposals (separate with ;)', true], ['gaps', 'Still to confirm (separate with ;)', true],
];

async function openProfile(api, id, onSaved) {
  const p = await api(`/api/profiles/${id}`);
  let editing = false;
  const body = h('div', { class: 'stack' });
  const draw = () => {
    if (!editing) return body.replaceChildren(...profileBody(p).filter(Boolean));
    body.replaceChildren(h('form', { class: 'stack', id: 'profile-form' }, EDIT.map(([k, label, long]) => field({ label, id: `pf_${k}`, control: long ? textarea({ id: `pf_${k}`, name: k, rows: 3 }, p[k] || '') : input({ id: `pf_${k}`, name: k, value: p[k] || '' }) })),
      h('p', { class: 'profile-note' }, 'Title, manager and joining date are changed on the Roster page. The audit log records which fields changed, not their values.')));
  };
  draw();
  openDrawer({ title: p.user.name, iconName: 'id-card', body,
    footer: (close) => {
      const wrap = h('div', { class: 'row' });
      const redraw = () => wrap.replaceChildren(...(editing
        ? [button('Cancel', { onClick: () => { editing = false; draw(); redraw(); } }), button('Save', { variant: 'primary', iconName: 'check', onClick: async () => {
          const f = new FormData(body.querySelector('form'));
          const changes = Object.fromEntries(EDIT.map(([k]) => [k, String(f.get(k) ?? '').trim()]).filter(([k, v]) => v !== (p[k] || '')));
          if (!Object.keys(changes).length) { editing = false; draw(); return redraw(); }
          try { Object.assign(p, await api(`/api/profiles/${id}`, { method: 'PATCH', body: changes })); toast('Profile saved'); editing = false; draw(); redraw(); onSaved(); } catch (e) { toast(e.message, 'danger'); }
        } })]
        : [button('Close', { onClick: close }), p.can_edit ? button('Edit', { variant: 'primary', iconName: 'pencil', onClick: () => { editing = true; draw(); redraw(); } }) : null]));
      redraw();
      return wrap;
    } });
}

export async function peopleScreen({ api }) {
  let rows = await api('/api/profiles');
  let filter = 'all';
  const flags = (r) => [r.contract_status, r.social_security_status, r.medical_insurance_status].filter((s) => statusTone(s) === 'warning').length;
  const table = dataTable({
    columns: [
      { key: 'name', label: 'Name', render: (r) => h('div', {}, h('strong', {}, r.name), h('div', { class: 'muted cell-sub' }, r.level || r.title || '—')) },
      { key: 'hire_date', label: 'Joined', render: (r) => (r.hire_date ? h('span', {}, h('span', { class: 'nowrap' }, fmt(r.hire_date)), h('div', { class: 'muted cell-sub' }, `${r.years_with_gb} yrs`)) : '—') },
      { key: 'probation_status', label: 'Probation', render: (r) => (r.probation_end ? statusBadge(`Ended ${fmt(r.probation_end)}`) : statusBadge(r.probation_status)) },
      { key: 'contract_status', label: 'Contract', render: (r) => statusBadge(r.contract_status) },
      { key: 'medical_insurance_status', label: 'Insurance', render: (r) => statusBadge(r.medical_insurance_status) },
      { key: 'gym_stipend_status', label: 'Gym', render: (r) => statusBadge(r.gym_stipend_status) },
      { key: 'assignments', label: 'Projects', num: true },
      { key: 'gaps', label: 'To confirm', sortValue: (r) => r.gaps_list.length, render: (r) => (r.gaps_list.length ? badge(String(r.gaps_list.length), 'warning', 'circle-alert') : badge('None', 'success', 'check')) },
    ],
    rows, onRowClick: (r) => openProfile(api, r.id, refresh), emptyText: 'No people yet',
  });
  const shown = () => rows.filter((r) => filter === 'all' || (filter === 'gaps' && r.gaps_list.length) || (filter === 'flags' && flags(r)));
  async function refresh() { rows = await api('/api/profiles'); table.setRows(shown()); }
  const chips = filterChips([{ value: 'all', label: 'Everyone', count: rows.length }, { value: 'gaps', label: 'Something to confirm', count: rows.filter((r) => r.gaps_list.length).length },
    { value: 'flags', label: 'Contract or benefits not on file', count: rows.filter(flags).length }], 'all', (v) => { filter = v; table.setRows(shown()); });
  const root = h('div', { class: 'stack' },
    banner({ tone: 'info', title: 'Restricted', text: 'Profiles hold date of birth, insurance and contract status. Only the person, People Ops and partners can see them; managers and project leads cannot.' }),
    card({ title: 'Team', iconName: 'users', actions: chips, flush: true, body: rows.length ? table : emptyState({ iconName: 'users', title: 'No profiles yet', text: 'Load the 2026 review workbook on the server to fill these in.' }) }));
  root.modern = true;
  return root;
}
