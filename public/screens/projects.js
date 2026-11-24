// Projects register: approve new entries (partners / People Ops), confirm who worked on a
// project (its lead), and claim or confirm contributions to deliverables.
// Uses the existing endpoints: /api/projects, /approve, /api/assignments/:id/review,
// /api/deliverables/:id/contributions, /api/contributions/:id/review.
import { h, icon, button, badge, card, banner, emptyState, filterChips, input, select, toast, promptModal } from '/ui.js';

const fmtM = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '');
const when = (a, b) => (a ? `${fmtM(a)}${b ? (fmtM(a) === fmtM(b) ? '' : ` – ${fmtM(b)}`) : ' onward'}` : '');
const ASG = { confirmed: ['Confirmed', 'success'], historical: ['Confirmed', 'success'], tentative: ['Lead to confirm', 'info'], provisional: ['Unverified lead', 'warning'] };
const CON = { confirmed: 'success', corrected: 'info', rejected: 'danger', claimed: 'warning' };

export async function projectsScreen({ api, me, query = '' }) {
  const params = new URLSearchParams(query);
  let list = await api('/api/projects');
  const canApprove = me.roles.includes('partner') || me.roles.includes('people_ops') || me.roles.includes('admin');
  const people = canApprove ? await api('/api/people').catch(() => []) : [];
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
    const head = h('div', { class: 'project-meta' }, badge(p.kind === 'proposal' ? 'Proposal' : p.kind === 'initiative' ? 'Initiative' : 'Engagement', 'neutral'), status,
      h('span', { class: 'muted' }, icon('user'), ` Lead ${p.lead_name || 'to be identified'}`), p.start_date ? h('span', { class: 'muted' }, icon('calendar-days'), ` ${when(p.start_date, p.end_date)}`) : null);
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
      return h('div', { class: 'deliverable' }, h('div', { class: 'asg-row' }, h('strong', {}, `${d.title} ${d.version || ''}`), h('span', { class: 'muted' }, [d.milestone, d.status, d.acceptance].filter(Boolean).join(' · '))),
        d.contributions.length ? h('ul', { class: 'bullets' }, d.contributions.map((c) => h('li', {}, `${c.name} — ${c.responsibility}${c.description ? `: ${c.description}` : ''} `, badge(c.status, CON[c.status] || 'neutral'),
          p.is_lead && c.status === 'claimed' && c.user_id !== me.id ? [' ', button('Confirm', { size: 'sm', onClick: () => act(() => api(`/api/contributions/${c.id}/review`, { method: 'POST', body: { decision: 'confirm' } }), 'Contribution confirmed') })] : null))) : null,
        h('div', { class: 'inline-form' }, resp, desc, ev, button('Claim my contribution', { size: 'sm', onClick: () => act(() => api(`/api/deliverables/${d.id}/contributions`, { method: 'POST', body: { responsibility: resp.value, description: desc.value, evidenceUrl: ev.value || null } }), 'Claimed — the lead will confirm') })));
    })) : null;
    const leadPick = canApprove ? select([['', p.lead_user_id ? 'Change lead…' : 'Set lead…'], ...[...people, { id: me.id, name: me.name }].sort((a, b) => a.name.localeCompare(b.name)).map((x) => [x.id, x.name])],
      { 'aria-label': `Lead for ${p.name}`, class: 'select select-sm', onchange: (e) => e.target.value && act(() => api(`/api/projects/${p.id}/lead`, { method: 'POST', body: { userId: e.target.value } }), 'Lead updated') }) : null;
    const actions = canApprove && p.register_status === 'candidate' ? button('Approve', { variant: 'primary', size: 'sm', iconName: 'check', onClick: () => act(() => api(`/api/projects/${p.id}/approve`, { method: 'POST' }), `${p.name} approved`) }) : null;
    const c = card({ title: p.name, iconName: p.kind === 'proposal' ? 'file-text' : 'briefcase', actions: [leadPick, actions], body: h('div', { class: 'stack' }, head, teamList, removed, dels) });
    c.id = `project-${p.id}`;
    return c;
  }

  function draw() {
    const shown = list.filter(FILTERS[filter] || FILTERS.all);
    const pending = count(FILTERS.candidate);
    wrap.replaceChildren(
      h('div', { class: 'toolbar' }, chips, canApprove && pending && filter === 'candidate' ? button(`Approve all with a lead (${list.filter(FILTERS.candidate).filter((p) => p.lead_user_id).length})`, { variant: 'secondary', iconName: 'check', onClick: async () => {
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
