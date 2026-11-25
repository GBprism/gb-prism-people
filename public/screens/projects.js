// Projects register: approve new entries (partners / People Ops), confirm who worked on a
// project (its lead), and claim or confirm contributions to deliverables.
// Uses the existing endpoints: /api/projects, /approve, /api/assignments/:id/review,
// /api/deliverables/:id/contributions, /api/contributions/:id/review.
import { h, icon, button, badge, card, banner, emptyState, filterChips, input, select, toast, promptModal, openDrawer, field } from '/ui.js';

const fmtM = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '');
const when = (a, b) => (a ? `${fmtM(a)}${b ? (fmtM(a) === fmtM(b) ? '' : ` – ${fmtM(b)}`) : ' onward'}` : '');
const ASG = { confirmed: ['Confirmed', 'success'], historical: ['Confirmed', 'success'], tentative: ['Lead to confirm', 'info'], provisional: ['Unverified lead', 'warning'] };
const CON = { confirmed: 'success', corrected: 'info', rejected: 'danger', claimed: 'warning' };

export async function projectsScreen({ api, me, query = '' }) {
  const params = new URLSearchParams(query);
  let list = await api('/api/projects');
  const canApprove = me.roles.includes('partner') || me.roles.includes('people_ops') || me.roles.includes('admin');
  const people = canApprove ? await api('/api/people').catch(() => []) : [];
  const LINES = await api('/api/service-lines').catch(() => []);
  let CHECKLISTS = null;
  const onTeam = (p) => p.is_lead || [...p.team_confirmed, ...p.team_historical, ...p.team_unconfirmed].some((a) => a.user_id === me.id);

  // Submit a deliverable for review: tick every general checklist item and the checklist for its type.
  async function submitDeliverable(p, d) {
    CHECKLISTS ||= await api('/api/checklists');
    const types = [...new Set(CHECKLISTS.filter((c) => c.kind === 'specific').map((c) => c.deliverable_type))];
    const typeSel = select([['', 'Other / no specific checklist'], ...types.map((t) => [t, t])], { id: 'sd-type' }); typeSel.value = d.deliverable_type || '';
    const link = input({ id: 'sd-link', type: 'url', value: d.drive_url || '', placeholder: 'https://docs.google.com/…' });
    const note = input({ id: 'sd-note', placeholder: 'Anything the reviewer should know' });
    const checked = {}; const lists = h('div', { class: 'stack' }); const count = h('p', { class: 'muted', 'aria-live': 'polite' });
    const drawLists = () => {
      const req = CHECKLISTS.filter((c) => c.kind === 'general' || c.deliverable_type === typeSel.value);
      const total = req.reduce((s, c) => s + c.items.length, 0);
      const upd = () => { count.textContent = `${req.flatMap((c) => c.items.map((_, i) => checked[`${c.key}:${i}`])).filter(Boolean).length} of ${total} checked`; };
      lists.replaceChildren(...req.map((c) => h('fieldset', { class: 'carry' }, h('legend', {}, c.title), c.items.map((it, i) => h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: !!checked[`${c.key}:${i}`], onchange: (e) => { checked[`${c.key}:${i}`] = e.target.checked; upd(); } }), it)))));
      upd();
    };
    typeSel.onchange = drawLists; drawLists();
    openDrawer({ title: `Submit “${d.title}” for review`, iconName: 'list-todo', body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Confirm you checked the deliverable against each item. The confirmation is recorded with your name and the time.'),
      field({ label: 'Type of deliverable', id: 'sd-type', control: typeSel }), field({ label: 'Drive link to the deliverable', id: 'sd-link', control: link }), field({ label: 'Note', id: 'sd-note', control: note }), count, lists),
    footer: (close) => button('I checked everything — submit', { variant: 'primary', iconName: 'send', onClick: async () => {
      try { await api(`/api/deliverables/${d.id}/submit`, { method: 'POST', body: { deliverableType: typeSel.value || null, checked, note: note.value, driveUrl: link.value || null } }); toast('Submitted for review'); close(); list = await api('/api/projects'); draw(); } catch (e) { toast(e.message, 'danger'); }
    } }) });
  }

  function addDeliverable(p) {
    const t = input({ id: 'ad-title', placeholder: 'e.g. Procurement manual v1.0' }); const due = input({ id: 'ad-due', type: 'date' }); const link = input({ id: 'ad-link', type: 'url', placeholder: 'https://docs.google.com/…' });
    openDrawer({ title: `New deliverable — ${p.name}`, iconName: 'file-text', body: h('div', { class: 'stack' }, field({ label: 'Title', id: 'ad-title', control: t, required: true }), field({ label: 'Due', id: 'ad-due', control: due }), field({ label: 'Drive link', id: 'ad-link', control: link })),
      footer: (close) => button('Add', { variant: 'primary', iconName: 'plus', onClick: async () => { try { await api(`/api/projects/${p.id}/deliverables`, { method: 'POST', body: { title: t.value, dueDate: due.value || null, driveUrl: link.value || null } }); close(); list = await api('/api/projects'); draw(); } catch (e) { toast(e.message, 'danger'); } } }) });
  }

  function editLinks(p) {
    const chat = input({ id: 'pl-chat', type: 'url', value: p.chat_url || '', placeholder: 'https://chat.google.com/room/…' });
    const meet = input({ id: 'pl-meet', type: 'url', value: p.meet_url || '', placeholder: 'https://meet.google.com/abc-defg-hij' });
    openDrawer({ title: `Team links — ${p.name}`, iconName: 'messages-square', body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Paste the project’s Google Chat space and a standing Google Meet link. Everyone on the project sees them on this card.'),
      field({ label: 'Google Chat space', id: 'pl-chat', control: chat }), field({ label: 'Google Meet link', id: 'pl-meet', control: meet })),
    footer: (close) => button('Save', { variant: 'primary', iconName: 'check', onClick: async () => { try { await api(`/api/projects/${p.id}/links`, { method: 'POST', body: { chatUrl: chat.value, meetUrl: meet.value } }); close(); list = await api('/api/projects'); draw(); } catch (e) { toast(e.message, 'danger'); } } }) });
  }
  let line = 'all';
  let filter = params.get('status') === 'candidate' ? 'candidate' : params.get('p') ? 'mine' : 'all';
  const focus = params.get('p');
  const act = async (fn, ok) => { try { await fn(); toast(ok); list = await api('/api/projects'); draw(); } catch (e) { toast(e.message, 'danger'); } };

  const wrap = h('div', { class: 'stack' });
  const count = (f) => list.filter(f).length;
  const FILTERS = {
    all: () => true,
    candidate: (p) => p.register_status === 'candidate',
    mine: (p) => p.team_unconfirmed.some((a) => a.user_id !== me.id && (p.is_lead || (canApprove && a.user_id === p.lead_user_id))),
    proposals: (p) => p.kind === 'proposal',
    initiatives: (p) => p.kind === 'initiative',
  };
  const chips = filterChips([
    { value: 'all', label: 'All', count: list.length },
    canApprove ? { value: 'candidate', label: 'Awaiting approval', count: count(FILTERS.candidate) } : null,
    { value: 'mine', label: 'To confirm', count: count(FILTERS.mine) },
    { value: 'proposals', label: 'Proposals', count: count(FILTERS.proposals) },
    { value: 'initiatives', label: 'Internal initiatives', count: count(FILTERS.initiatives) },
  ].filter(Boolean), filter, (v) => { filter = v; draw(); });

  function projectCard(p) {
    const team = [...p.team_confirmed, ...p.team_historical, ...p.team_unconfirmed];
    const status = p.register_status === 'approved' ? badge('Approved', 'success') : p.register_status === 'archived' ? badge('Archived', 'neutral') : badge('Awaiting approval', 'warning');
    const canLine = canApprove || p.is_lead;
    const lineCtl = canLine && p.kind !== 'initiative' ? select([['', 'Service line…'], ...LINES.map((l) => [l, l])], { 'aria-label': `Service line for ${p.name}`, class: 'select select-sm',
      onchange: (e) => act(() => api(`/api/projects/${p.id}/service-line`, { method: 'POST', body: { line: e.target.value } }), 'Service line updated') }) : null;
    if (lineCtl) lineCtl.value = p.service_line || '';
    const head = h('div', { class: 'project-meta' }, badge(p.kind === 'proposal' ? 'Proposal' : p.kind === 'initiative' ? 'Initiative' : 'Engagement', 'neutral'), status,
      lineCtl || (p.service_line ? badge(p.service_line, 'info') : null),
      h('span', { class: 'muted' }, icon('user'), ` Lead ${p.lead_name || 'to be identified'}`), p.start_date ? h('span', { class: 'muted' }, icon('calendar-days'), ` ${when(p.start_date, p.end_date)}`) : null,
      p.chat_url ? h('a', { class: 'btn btn-ghost btn-sm', href: p.chat_url, target: '_blank', rel: 'noopener' }, icon('messages-square'), h('span', {}, 'Chat')) : null,
      p.meet_url ? h('a', { class: 'btn btn-ghost btn-sm', href: p.meet_url, target: '_blank', rel: 'noopener' }, icon('video'), h('span', {}, 'Meet')) : null,
      canApprove || p.is_lead ? button(p.chat_url || p.meet_url ? 'Edit links' : 'Add Chat / Meet', { size: 'sm', variant: 'ghost', iconName: 'pencil', onClick: () => editLinks(p) }) : null);
    const teamList = team.length ? h('ul', { class: 'asg-list' }, team.map((a) => {
      const [label, tone] = ASG[a.status] || [a.status, 'neutral'];
      const canConfirm = ['provisional', 'tentative'].includes(a.status) && a.user_id !== me.id && (p.is_lead || (a.user_id === p.lead_user_id && canApprove));
      return h('li', {}, h('div', { class: 'asg-row' }, h('div', {}, h('strong', {}, a.name), h('div', { class: 'muted' }, a.role, a.start_date ? ` · ${when(a.start_date, a.end_date)}` : '')),
        h('div', { class: 'asg-actions' }, badge(label, tone),
          canConfirm ? button('Confirm', { size: 'sm', variant: 'primary', iconName: 'check', onClick: () => act(() => api(`/api/assignments/${a.id}/review`, { method: 'POST', body: { decision: 'confirm' } }), `${a.name} confirmed`) }) : null,
          canConfirm ? button('Not on this project', { size: 'sm', variant: 'ghost', onClick: async () => {
            const why = await promptModal({ title: `Remove ${a.name} from ${p.name}?`, text: 'They will no longer count as working on this project. You can restore them from this card.', label: 'Why? (short reason)', confirmLabel: 'Remove', tone: 'danger', placeholder: 'e.g. was only copied on emails' });
            if (why) act(() => api(`/api/assignments/${a.id}/review`, { method: 'POST', body: { decision: 'reject', note: why } }), `${a.name} removed — restore from “Removed” if this was a mistake`);
          } }) : null)),
        a.source && (p.is_lead || canApprove) ? h('div', { class: 'asg-source muted' }, icon('info'), ` ${a.source.replace(/^2026 PMS – Consultant Reviewers workbook: /, '')}`) : null);
    })) : h('p', { class: 'muted' }, 'No one assigned yet.');
    const removed = p.removed?.length ? h('details', { class: 'removed' }, h('summary', {}, `Removed (${p.removed.length})`), h('ul', { class: 'asg-list' }, p.removed.map((r) => h('li', {}, h('div', { class: 'asg-row' },
      h('div', {}, h('strong', {}, r.name), h('div', { class: 'muted' }, `${r.role} · removed by ${r.removed_by || '—'} on ${new Date(r.removed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}: “${r.reason}”`)),
      button('Restore', { size: 'sm', iconName: 'rotate-ccw', onClick: () => act(() => api(`/api/assignment-removals/${r.id}/restore`, { method: 'POST' }), `${r.name} restored`) })))))) : null;
    const dels = p.deliverables.length ? h('div', { class: 'stack' }, h('h3', { class: 'kv-head' }, 'Deliverables'), p.deliverables.map((d) => {
      const resp = select(['lead', 'author', 'analyst', 'reviewer', 'support'].map((x) => [x, x[0].toUpperCase() + x.slice(1)]), { 'aria-label': 'My responsibility' });
      const desc = input({ 'aria-label': 'What I did', placeholder: 'What you did' }); const ev = input({ 'aria-label': 'Evidence link', type: 'url', placeholder: 'Drive link' });
      return h('div', { class: 'deliverable' }, h('div', { class: 'asg-row' }, h('strong', {}, `${d.title} ${d.version || ''}`), h('span', { class: 'muted' }, [d.milestone, d.status === 'submitted' ? null : d.status, d.acceptance].filter(Boolean).join(' · ')),
        d.status === 'submitted' ? badge(`Submitted${d.submitted_at ? ` ${new Date(d.submitted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''} · checklists confirmed`, 'success')
          : onTeam(p) ? button('Submit for review', { size: 'sm', variant: 'primary', iconName: 'list-todo', onClick: () => submitDeliverable(p, d) }) : null,
        d.drive_url ? h('a', { href: d.drive_url, target: '_blank', rel: 'noopener', class: 'drive-link' }, icon('folder-open'), ' Open') : null),
        d.contributions.length ? h('ul', { class: 'bullets' }, d.contributions.map((c) => h('li', {}, `${c.name} — ${c.responsibility}${c.description ? `: ${c.description}` : ''} `, badge(c.status, CON[c.status] || 'neutral'),
          p.is_lead && c.status === 'claimed' && c.user_id !== me.id ? [' ', button('Confirm', { size: 'sm', onClick: () => act(() => api(`/api/contributions/${c.id}/review`, { method: 'POST', body: { decision: 'confirm' } }), 'Contribution confirmed') })] : null))) : null,
        h('div', { class: 'inline-form' }, resp, desc, ev, button('Claim my contribution', { size: 'sm', onClick: () => act(() => api(`/api/deliverables/${d.id}/contributions`, { method: 'POST', body: { responsibility: resp.value, description: desc.value, evidenceUrl: ev.value || null } }), 'Claimed — the lead will confirm') })));
    })) : null;
    const addDel = onTeam(p) || canApprove ? button('Add deliverable', { size: 'sm', variant: 'ghost', iconName: 'plus', onClick: () => addDeliverable(p) }) : null;
    const leadPick = canApprove ? select([['', p.lead_user_id ? 'Change lead…' : 'Set lead…'], ...[...people, { id: me.id, name: me.name }].sort((a, b) => a.name.localeCompare(b.name)).map((x) => [x.id, x.name])],
      { 'aria-label': `Lead for ${p.name}`, class: 'select select-sm', onchange: (e) => e.target.value && act(() => api(`/api/projects/${p.id}/lead`, { method: 'POST', body: { userId: e.target.value } }), 'Lead updated') }) : null;
    const actions = canApprove && p.register_status === 'candidate' ? button('Approve', { variant: 'primary', size: 'sm', iconName: 'check', onClick: () => act(() => api(`/api/projects/${p.id}/approve`, { method: 'POST' }), `${p.name} approved`) }) : null;
    const c = card({ title: p.name, iconName: p.kind === 'proposal' ? 'file-text' : 'briefcase', actions: [leadPick, actions], body: h('div', { class: 'stack' }, head, teamList, removed, dels, addDel) });
    c.id = `project-${p.id}`;
    return c;
  }

  const lineSel = select([['all', 'All service lines'], ...LINES.map((l) => [l, l]), ['none', 'No service line yet']], { 'aria-label': 'Filter by service line', class: 'select select-sm', onchange: (e) => { line = e.target.value; draw(); } });
  function draw() {
    const shown = list.filter(FILTERS[filter] || FILTERS.all).filter((p) => line === 'all' || (line === 'none' ? !p.service_line && p.kind !== 'initiative' : p.service_line === line));
    const pending = count(FILTERS.candidate);
    wrap.replaceChildren(
      h('div', { class: 'toolbar' }, h('div', { class: 'row' }, chips, lineSel), canApprove && pending && filter === 'candidate' ? button(`Approve all with a lead (${list.filter(FILTERS.candidate).filter((p) => p.lead_user_id).length})`, { variant: 'secondary', iconName: 'check', onClick: async () => {
        const noLead = list.filter(FILTERS.candidate).filter((p) => !p.lead_user_id);
        for (const p of list.filter(FILTERS.candidate).filter((x) => x.lead_user_id)) { try { await api(`/api/projects/${p.id}/approve`, { method: 'POST' }); } catch (e) { toast(`${p.name}: ${e.message}`, 'danger'); } }
        toast(noLead.length ? `Approved. Not approved until a lead is set: ${noLead.map((p) => p.name).join(', ')}` : 'Projects approved'); list = await api('/api/projects'); draw();
      } }) : null),
      ...(shown.length ? shown.map(projectCard) : [emptyState({ iconName: 'folder-kanban', title: filter === 'all' ? 'No projects visible to you' : 'Nothing here', text: 'Projects you lead or work on appear here.' })]));
    if (focus) setTimeout(() => document.getElementById(`project-${focus}`)?.scrollIntoView({ block: 'start' }), 0);
  }
  draw();
  const root = h('div', { class: 'stack' },
    banner({ tone: 'info', title: 'Leads, not facts', text: 'Assignments from task sheets, Drive activity and the review workbook are leads. A project’s lead confirms who actually worked on it; only confirmed work counts in reviews.' }), wrap);
  root.modern = true;
  return root;
}
