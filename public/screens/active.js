// My Work → Projects: the engagements you are on, then everything running at GB.
// Each project opens its detail page (#/project/:id), the one place for a project's information.
import { h, icon, badge, button, emptyState, filterChips, input, select, textarea, field, toast, openDrawer } from '/ui.js';
import { avatar } from '/ui.js';

const d0 = (s) => new Date(`${s}T00:00:00`);
const fmt = (s) => (s ? d0(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null);
const fmtShort = (s) => d0(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const cap = (s) => (s ? s.replace(/^\w/, (c) => c.toUpperCase()) : s);

export async function activeScreen({ api }) {
  const [list, week, team] = await Promise.all([api('/api/active-projects'), api('/api/my-week').catch(() => ({ projects: [] })), api('/api/team').catch(() => [])]);
  const photo = (m) => team.find((t) => t.id === m.id) || m;
  const mineIds = new Set(week.projects.map((p) => p.id));

  let edit = await api('/api/my-projects').catch(() => ({ mine: [], running: [], requests: [] }));
  const pending = edit.requests.filter((r) => r.status === 'pending');
  const recent = edit.requests.filter((r) => r.status === 'declined' && Date.now() - Date.parse(r.decided_at) < 14 * 864e5);
  const describe = (r) => (r.kind === 'join' ? `Join ${r.project} as ${r.role}` : r.kind === 'leave' ? `Leave ${r.project} (last day ${r.end_date})` : `Role on ${r.project}: ${r.role}`);

  // Update my projects: the person edits their own list; each change goes to the project lead to approve
  function openEditor() {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(new Date());
    const rows = edit.mine.map((a) => ({ a, role: input({ class: 'input input-sm', value: a.role || '', 'aria-label': `Your role on ${a.name}` }),
      left: h('input', { type: 'checkbox' }), last: input({ type: 'date', class: 'input input-sm', value: today, 'aria-label': `Last day on ${a.name}`, hidden: true }) }));
    rows.forEach((r) => r.left.addEventListener('change', () => { r.last.hidden = !r.left.checked; r.role.disabled = r.left.checked; }));
    const adds = []; const addBox = h('div', { class: 'stack' });
    const addRow = () => {
      const proj = select([['', 'Choose a running project…'], ...edit.running.map((p) => [p.id, `${p.name}${p.lead_name ? ` · lead ${p.lead_name}` : ''}`])], { class: 'select select-sm', 'aria-label': 'Project' });
      const role = input({ class: 'input input-sm', placeholder: 'Your role, e.g. analyst', 'aria-label': 'Your role' });
      const start = input({ type: 'date', class: 'input input-sm', value: today, 'aria-label': 'From' });
      const row = { proj, role, start }; adds.push(row);
      addBox.append(h('div', { class: 'edit-row' }, proj, role, start));
    };
    const note = textarea({ id: 'mp-note', rows: 2, placeholder: 'Anything the lead should know (optional)' });
    openDrawer({ title: 'Update my projects', iconName: 'briefcase', body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Change what you are working on. Each change goes to the project lead (or a partner) to approve; your projects, timesheet and the resource calendar update once approved.'),
      h('h3', { class: 'kv-head' }, 'Projects you are on'),
      rows.length ? h('ul', { class: 'edit-list' }, rows.map((r) => h('li', { class: 'edit-item' }, h('strong', {}, r.a.name),
        h('div', { class: 'edit-row' }, r.role, h('label', { class: 'check-row' }, r.left, 'I have left this project'), r.last)))) : h('p', { class: 'muted' }, 'You are not on a running project.'),
      h('h3', { class: 'kv-head' }, 'Add a project you are working on'), addBox,
      edit.running.length ? button('Add another project', { size: 'sm', iconName: 'plus', onClick: addRow }) : h('p', { class: 'muted' }, 'You are on every running project.'),
      field({ label: 'Note', id: 'mp-note', control: note })),
    footer: (close) => button('Send for approval', { variant: 'primary', iconName: 'send', onClick: async () => {
      const body = { note: note.value,
        join: adds.filter((x) => x.proj.value).map((x) => ({ project_id: x.proj.value, role: x.role.value, start_date: x.start.value || null })),
        leave: rows.filter((r) => r.left.checked).map((r) => ({ assignment_id: r.a.id, end_date: r.last.value || null })),
        role: rows.filter((r) => !r.left.checked && r.role.value.trim() && r.role.value.trim() !== (r.a.role || '')).map((r) => ({ assignment_id: r.a.id, role: r.role.value })) };
      try { const o = await api('/api/my-projects/requests', { method: 'POST', body }); toast(`${o.created} change${o.created === 1 ? '' : 's'} sent for approval`); close(); location.hash = '#/active'; window.dispatchEvent(new HashChangeEvent('hashchange')); } catch (e) { toast(e.message, 'danger'); }
    } }) });
    if (edit.running.length) addRow();
  }
  const status = pending.length || recent.length ? h('ul', { class: 'attn-list req-pending', 'aria-label': 'Your project changes' }, [...pending, ...recent].map((r) => h('li', {}, h('div', { class: 'attn-row' },
    h('span', { class: 'attn-icon', 'aria-hidden': 'true' }, icon(r.status === 'pending' ? 'hourglass' : 'circle-x')),
    h('span', { class: 'attn-text' }, h('strong', {}, describe(r)), h('span', { class: 'muted' }, r.status === 'pending' ? 'Waiting for approval' : `Declined${r.decided_by_name ? ` by ${r.decided_by_name}` : ''}${r.decision_note ? `: ${r.decision_note}` : ''}`)),
    r.status === 'pending' ? badge('Waiting for approval', 'warning') : badge('Declined', 'danger'),
    r.status === 'pending' ? button('Withdraw', { size: 'sm', variant: 'ghost', onClick: async () => { await api(`/api/my-projects/requests/${r.id}/withdraw`, { method: 'POST' }); toast('Withdrawn'); window.dispatchEvent(new HashChangeEvent('hashchange')); } }) : h('span'))))) : null;

  const mine = h('section', { 'aria-labelledby': 'mine-h', class: 'stack-sm' }, h('div', { class: 'section-head-row' }, h('h2', { id: 'mine-h', class: 'section-title' }, 'Your engagements'),
      button('Update my projects', { variant: 'primary', iconName: 'pencil', onClick: openEditor })), status,
    !week.projects.length ? h('p', { class: 'muted' }, 'You are not on a running project. Use “Update my projects” to add the one you are working on.') : null,
    h('div', { class: 'eng-cards' }, week.projects.map((p) => h('a', { class: 'eng-card', href: `#/project/${p.id}` },
      h('span', { class: 'eng-card-client' }, p.client || 'Client not recorded'),
      h('strong', { class: 'eng-card-name' }, p.name),
      h('span', { class: 'muted' }, [p.role ? cap(p.role) : null, p.lead_name && !p.is_lead ? `Lead ${p.lead_name}` : null].filter(Boolean).join(' · ')),
      h('span', { class: 'eng-card-next' }, p.next ? [h('span', { class: 'muted' }, 'Next'), h('span', {}, p.next.title), h('span', { class: 'proj-date' }, fmtShort(p.next.date))] : h('span', { class: 'muted' }, 'No dated milestone'))))));

  let filter = 'all'; let q = '';
  const ul = h('ul', { class: 'proj-list' });
  const draw = () => {
    const rows = list.filter((p) => (filter === 'all' || (filter === 'mine' ? mineIds.has(p.id) || p.mine : !mineIds.has(p.id) && !p.mine)) && (!q || `${p.name} ${p.client_name || ''} ${p.lead_name || ''} ${p.team.map((m) => m.name).join(' ')}`.toLowerCase().includes(q)));
    ul.replaceChildren(...(rows.length ? rows.map((p) => h('li', {}, h('a', { class: 'proj-row', href: `#/project/${p.id}` },
      h('span', { class: 'proj-name' }, h('strong', {}, p.name), h('span', { class: 'muted' }, [p.client_name, p.lead_name ? `Lead ${p.lead_name}` : 'Lead to be set'].filter(Boolean).join(' · '))),
      h('span', { class: 'proj-faces' }, h('span', { class: 'face-stack' }, p.team.slice(0, 4).map((m) => avatar(photo(m), 'sm'))), p.team.length > 4 ? h('span', { class: 'muted' }, `+${p.team.length - 4}`) : null),
      h('span', { class: 'proj-next' }, p.end_date ? [h('span', { class: 'muted' }, 'Ends'), h('span', {}, fmt(p.end_date))] : h('span', { class: 'muted' }, 'Ongoing')),
      p.mine ? badge('You', 'info') : h('span'), icon('chevron-right', { flip: true }))))
      : [h('li', {}, emptyState({ iconName: 'briefcase', title: 'No running projects match' }))]));
  };
  draw();
  const all = h('section', { class: 'card', 'aria-labelledby': 'all-h' },
    h('header', { class: 'card-header' }, h('h2', { id: 'all-h' }, 'Running at GB'), h('div', { class: 'card-actions' },
      filterChips([{ value: 'all', label: 'All', count: list.length }, { value: 'mine', label: 'Mine', count: list.filter((p) => p.mine).length }, { value: 'others', label: 'Others' }], filter, (x) => { filter = x; draw(); }),
      input({ type: 'search', class: 'input input-sm library-search', placeholder: 'Project, client or person', 'aria-label': 'Search running projects', oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } }))),
    h('div', { class: 'card-body flush' }, ul));
  const root = h('div', { class: 'stack' }, mine, all,
    h('p', { class: 'muted' }, icon('info'), ' Deliverables, contributions and the full project register are under ', h('a', { href: '#/projects' }, 'Deliverables & contributions'), '.'));
  root.modern = true;
  return root;
}
