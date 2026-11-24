// AI examples and the Admin pages (Completion, Roster, Policy, Reminders, AI adoption, Audit).
// Same endpoints and permissions as before; presentation only, plus a roster edit drawer that
// uses the existing POST /api/admin/roster/:id/employment endpoint.
import { h, icon, button, badge, card, banner, emptyState, statStrip, dataTable, filterChips, field, input, select, textarea, toast, promptModal, openDrawer } from '/ui.js';

const fmt = (s) => (s ? new Date(s.length === 10 ? `${s}T00:00:00` : s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const rerender = () => dispatchEvent(new HashChangeEvent('hashchange'));
const run = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok); rerender(); return r; } catch (e) { toast(e.message, 'danger'); return null; } };
const page = (...kids) => { const r = h('div', { class: 'stack' }, ...kids); r.modern = true; return r; };
const STATE_TONE = { closed: 'success', acknowledged: 'success', released: 'info', partner_calibration: 'info', manager_review: 'warning', self_assessment: 'warning', approved_plan: 'info', draft_plan: 'warning' };

// ------------------------------------------------------------- AI examples --
export async function aiExamplesScreen({ api }) {
  const [seats, ex] = await Promise.all([api('/api/ai/seats/mine'), api('/api/ai/examples/mine')]);
  const f = {};
  const fld = (k, label, { long, help, required } = {}) => field({ label, id: `ai_${k}`, help, required, control: (long ? textarea : input)({ id: `ai_${k}`, rows: long ? 3 : undefined, oninput: (e) => { f[k] = e.target.value; } }) });
  const seatCard = seats.length ? card({ title: 'Shared-seat usage to confirm', iconName: 'user-check', body: h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'These are leads from chat titles and Drive activity on shared Claude seats. Confirm only what you did.'),
    h('ul', { class: 'asg-list' }, seats.map((s) => h('li', {}, h('div', { class: 'asg-row' },
      h('div', {}, h('strong', {}, s.engagement || 'Unnamed work'), h('div', { class: 'muted' }, `${s.seat_email} · ${s.evidence_type} · ${s.confidence} confidence`)),
      h('div', { class: 'asg-actions' }, badge(s.status === 'candidate' ? 'To confirm' : s.status, s.status === 'confirmed' ? 'success' : s.status === 'candidate' ? 'warning' : 'neutral'),
        s.status === 'candidate' ? [button('That was me', { size: 'sm', variant: 'primary', iconName: 'check', onClick: () => run(() => api(`/api/ai/seats/${s.id}/confirm`, { method: 'POST', body: { decision: 'confirm' } }), 'Confirmed') }),
          button('Not me', { size: 'sm', variant: 'ghost', onClick: () => run(() => api(`/api/ai/seats/${s.id}/confirm`, { method: 'POST', body: { decision: 'reject' } }), 'Noted') })] : null)))))) }) : null;
  const form = card({ title: 'Add an example', iconName: 'plus', body: h('div', { class: 'stack' },
    h('div', { class: 'form-grid' }, fld('task', 'Task', { required: true }), fld('tool', 'Tool and model', { help: 'e.g. Claude Opus, Gemini in Docs' }), fld('why', 'Why you chose it')),
    fld('contribution', 'What you did vs what the tool did', { long: true }),
    fld('verification', 'How you checked the output', { long: true, required: true }),
    h('div', { class: 'form-grid' }, fld('riskHandling', 'Confidentiality / risk handling'), fld('outcome', 'Outcome'), fld('timeSavedEstimate', 'Time saved (optional)'), fld('estimateBasis', 'Basis for the estimate')),
    h('div', { class: 'form-actions' }, button('Save example', { variant: 'primary', iconName: 'check', onClick: () => {
      if (!f.task || !f.verification) return toast('Add the task and how you checked the output', 'danger');
      run(() => api('/api/ai/examples', { method: 'POST', body: { ...f, submit: true } }), 'Example saved');
    } }))) });
  const mine = card({ title: 'My examples', iconName: 'sparkles', flush: !!ex.length, body: ex.length ? dataTable({ compact: true, rows: ex, columns: [
    { key: 'task', label: 'Task' }, { key: 'tool', label: 'Tool' }, { key: 'status', label: 'Status', render: (e) => badge(e.status, e.status === 'submitted' ? 'success' : 'neutral') }] })
    : emptyState({ iconName: 'sparkles', title: 'No examples yet', text: 'Up to three good examples are enough.' }) });
  return page(banner({ tone: 'info', title: 'Kept apart from ratings', text: 'Share up to three examples where Claude or Gemini helped, or hit a meaningful limit. Usage counts, cost and model choice never change ratings.' }),
    seatCard, h('div', { class: 'timeoff-grid' }, form, mine));
}

// ------------------------------------------------------------- Completion --
export async function adminDashboardScreen({ api }) {
  const d = await api('/api/admin/dashboard');
  const total = d.rows.length;
  const count = (states) => d.rows.filter((r) => states.includes(r.state)).length;
  let filter = 'all';
  const table = dataTable({ rows: d.rows, columns: [
    { key: 'name', label: 'Employee', render: (r) => h('strong', {}, r.name) },
    { key: 'stateLabel', label: 'Stage', render: (r) => badge(r.stateLabel, STATE_TONE[r.state] || 'neutral') },
    { key: 'reviewer', label: 'Lead reviewer', render: (r) => r.reviewer || '—' }, { key: 'partner', label: 'Partner', render: (r) => r.partner || '—' },
    { key: 'basis_status', label: 'Basis', render: (r) => (r.basis_status === 'unverified' ? badge('Unverified', 'warning') : r.basis_status === 'gb_decision' ? badge('GB decision', 'info') : badge('Verified', 'success')) },
    { key: 'self_submitted_at', label: 'Self submitted', render: (r) => fmt(r.self_submitted_at) },
    { key: 'released_at', label: 'Released', render: (r) => fmt(r.released_at) }, { key: 'acknowledged_at', label: 'Acknowledged', render: (r) => fmt(r.acknowledged_at) }] });
  const groups = { all: () => true, plan: (r) => ['draft_plan', 'approved_plan'].includes(r.state), progress: (r) => ['self_assessment', 'manager_review', 'partner_calibration'].includes(r.state), done: (r) => ['released', 'acknowledged', 'closed'].includes(r.state) };
  const chips = filterChips([{ value: 'all', label: 'All', count: total }, { value: 'plan', label: 'Plan stage', count: d.rows.filter(groups.plan).length },
    { value: 'progress', label: 'In review', count: d.rows.filter(groups.progress).length }, { value: 'done', label: 'Released', count: d.rows.filter(groups.done).length }], 'all', (v) => { filter = v; table.setRows(d.rows.filter(groups[filter])); });
  return page(
    statStrip([{ iconName: 'clipboard-list', value: String(count(['draft_plan'])), label: 'plans in draft' }, { iconName: 'user', value: String(count(['approved_plan', 'self_assessment'])), label: 'at self-assessment' },
      { iconName: 'user-check', value: String(count(['manager_review', 'partner_calibration'])), label: 'with reviewers or partners' }, { iconName: 'award', value: String(count(['released', 'acknowledged', 'closed'])), label: 'released' }]),
    d.needs_basis_decision ? banner({ tone: 'warning', title: `${d.needs_basis_decision} plan(s) have an unverified basis`, text: 'Approve each plan with its reviewer, or record a GB decision, before scoring.' }) : null,
    d.without_plan.length ? banner({ tone: 'warning', title: 'No plan yet', text: d.without_plan.map((u) => u.name).join(', ') }) : null,
    card({ title: 'Reviews this cycle', iconName: 'layout-dashboard', actions: chips, flush: true, body: total ? table : emptyState({ iconName: 'clipboard-list', title: 'No reviews in this cycle yet' }) }),
    h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, icon('lock'), ' Completion only. Ratings are visible to assigned reviewers and partners, never on this page.'),
      button('Open self-assessment for approved plans', { iconName: 'send', onClick: () => run(() => api(`/api/cycles/${d.cycleId}/open-self`, { method: 'POST' }), 'Self-assessment opened') })));
}

// ----------------------------------------------------------------- Roster --
export async function adminRosterScreen({ api }) {
  const rows = await api('/api/admin/roster');
  const people = rows.filter((u) => u.active).map((u) => [u.id, u.name]);
  const edit = (u) => {
    const title = input({ id: 're_title', value: u.title || '' });
    const mgr = select([['', 'No manager'], ...people.filter(([id]) => id !== u.id)], { id: 're_mgr' }); mgr.value = rows.find((x) => x.name === u.manager)?.id || '';
    const bk = select([['', 'No backup'], ...people.filter(([id]) => id !== u.id)], { id: 're_bk' }); bk.value = rows.find((x) => x.name === u.backup)?.id || '';
    const hire = input({ id: 're_hire', type: 'date', value: u.hire_date || '' }); const prob = input({ id: 're_prob', type: 'date', value: u.probation_end || '' });
    const from = input({ id: 're_from', type: 'date', value: new Date().toISOString().slice(0, 10) });
    openDrawer({ title: u.name, iconName: 'users', body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Changes start a new employment record from the effective date; the old one is kept as history.'),
      field({ label: 'Title', id: 're_title', control: title }), field({ label: 'Manager', id: 're_mgr', control: mgr }), field({ label: 'Backup approver', id: 're_bk', control: bk }),
      field({ label: 'Joining date', id: 're_hire', control: hire }), field({ label: 'Probation ends', id: 're_prob', control: prob }), field({ label: 'Effective from', id: 're_from', control: from })),
    footer: (close) => h('div', { class: 'row' }, button('Cancel', { onClick: close }), button('Save', { variant: 'primary', iconName: 'check', onClick: async () => {
      const ok = await run(() => api(`/api/admin/roster/${u.id}/employment`, { method: 'POST', body: { title: title.value, managerId: mgr.value || null, backupId: bk.value || null, hireDate: hire.value || null, probationEnd: prob.value || null, effectiveFrom: from.value } }), 'Roster updated');
      if (ok) close();
    } })) });
  };
  return page(card({ title: 'Roster', iconName: 'users', flush: true, body: dataTable({ rows, onRowClick: edit, columns: [
    { key: 'name', label: 'Name', render: (u) => h('div', {}, h('strong', {}, u.name), u.active ? null : badge('Inactive', 'neutral'), u.synthetic ? badge('Synthetic', 'warning') : null, h('div', { class: 'muted cell-sub' }, u.email)) },
    { key: 'title', label: 'Title', render: (u) => u.title || '—' }, { key: 'manager', label: 'Manager', render: (u) => u.manager || '—' }, { key: 'backup', label: 'Backup', render: (u) => u.backup || '—' },
    { key: 'hire_date', label: 'Joined', render: (u) => h('span', { class: 'nowrap' }, fmt(u.hire_date)) }, { key: 'probation_end', label: 'Probation ends', render: (u) => h('span', { class: 'nowrap' }, fmt(u.probation_end)) },
    { key: 'roles', label: 'Roles', sortValue: (u) => u.roles.join(), render: (u) => h('div', { class: 'row' }, u.roles.length ? u.roles.map((r) => badge(r.replace('_', ' '), r === 'partner' ? 'info' : 'neutral')) : h('span', { class: 'muted' }, 'employee')) },
  ] }) }), h('p', { class: 'muted' }, 'Click a person to change their title, manager, backup approver or dates.'));
}

// ----------------------------------------------------------------- Policy --
const POLICY_LABELS = {
  workweek: ['Working days', (v) => v.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')],
  workday: ['Working hours', (v) => `${v.start}–${v.end}`], hoursPerDay: ['Hours per day', (v) => `${v}`],
  annualEntitlementDays: ['Annual vacation', (v) => `${v} days a year`],
  carryover: ['Unused days', (v) => (v.maxDays == null ? 'All unused days carry into next year' : `Up to ${v.maxDays} days carry over`) + (v.expiresOn ? `, expiring ${v.expiresOn}` : ', no expiry')],
  leaveNoticeDays: ['Notice for leave', (v) => `${v} days`], noticeAppliesTo: ['Notice applies to', (v) => v.join(', ')],
  offsite: ['Off-site work', (v) => `${v.monthlyQuota} days a month${v.requiresPostProbation ? ', after probation' : ''}, ${v.noticeDays} day(s) notice`],
  projectCoverageCheck: ['Project coverage warning', (v) => (v ? 'On' : 'Off')], allowNegative: ['May go below zero', (v) => v.join(', ') || 'None'],
  requireApprovedPolicy: ['Requests need an approved policy', (v) => (v ? 'Yes' : 'No')],
};
export async function adminPolicyScreen({ api }) {
  const pols = await api('/api/admin/policy');
  return page(...(pols.length ? pols.map((p) => card({ title: `Leave policy v${p.version}`, iconName: 'scale',
    actions: [badge(p.status === 'approved' ? 'Approved' : p.status === 'superseded' ? 'Superseded' : 'Awaiting GB approval', p.status === 'approved' ? 'success' : p.status === 'superseded' ? 'neutral' : 'warning'),
      p.status === 'awaiting_confirmation' ? button('Record GB approval', { variant: 'primary', size: 'sm', iconName: 'check', onClick: async () => {
        const note = await promptModal({ title: `Approve policy v${p.version}`, label: 'Who at GB approved this, and where is it recorded?', confirmLabel: 'Approve' });
        if (note) run(() => api(`/api/admin/policy/${p.version}/approve`, { method: 'POST', body: { note } }), 'Policy approved');
      } }) : null],
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, `Effective ${fmt(p.effective_from)}${p.effective_to ? ` → ${fmt(p.effective_to)}` : ''}${p.note ? ` · ${p.note}` : ''}`),
      h('dl', { class: 'kv' }, Object.entries(p.settings).map(([k, v]) => { const [label, show] = POLICY_LABELS[k] || [k, (x) => JSON.stringify(x)]; return [h('dt', {}, label), h('dd', {}, show(v))]; }))) }))
    : [emptyState({ iconName: 'scale', title: 'No leave policy yet' })]));
}

// -------------------------------------------------------------- Reminders --
export async function adminRemindersScreen({ api }) {
  const [cycles, ob] = await Promise.all([api('/api/cycles'), api('/api/notifications/outbox')]);
  const cyc = select(cycles.map((c) => [c.id, c.name]), { id: 'rm_cycle' }); const asOf = input({ id: 'rm_asof', type: 'date' });
  const out = h('div', { class: 'stack' });
  const preview = async () => { try { const p = await api(`/api/notifications/plan?cycleId=${cyc.value}${asOf.value ? `&asOf=${asOf.value}` : ''}`);
    out.replaceChildren(banner({ tone: p.mode === 'test' ? 'info' : 'warning', title: `${p.items.length} new reminder(s) · mode: ${p.mode}`, text: `${p.already_sent_or_queued} already queued or sent.${p.mode === 'test' ? ' Test mode sends everything to the test inbox.' : ''}` }),
      p.items.length ? h('ul', { class: 'bullets' }, p.items.map((i) => h('li', {}, `${i.event} → ${i.to_email}: ${i.subject}`))) : null); } catch (e) { toast(e.message, 'danger'); } };
  const STATUS = { sent: 'success', queued: 'info', failed: 'danger', suppressed: 'neutral' };
  return page(
    card({ title: 'Review reminders', iconName: 'bell-ring', body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Sent at launch, 3 business days before the due date, and 1 business day after it if still outstanding (Amman time).'),
      h('div', { class: 'form-grid' }, field({ label: 'Cycle', id: 'rm_cycle', control: cyc }), field({ label: 'As of (optional)', id: 'rm_asof', control: asOf })),
      h('div', { class: 'form-actions start' }, button('Preview recipients', { iconName: 'eye', onClick: preview }),
        button('Queue', { variant: 'primary', iconName: 'list-checks', onClick: () => run(() => api('/api/notifications/queue', { method: 'POST', body: { cycleId: cyc.value, asOf: asOf.value || undefined } }), 'Queued') }),
        button('Deliver now', { iconName: 'send', onClick: () => run(() => api('/api/notifications/deliver', { method: 'POST' }), 'Delivery run complete') })), out) }),
    card({ title: 'Outbox', iconName: 'mail', flush: !!ob.length, body: ob.length ? dataTable({ compact: true, rows: ob, columns: [
      { key: 'event', label: 'Event' }, { key: 'to_email', label: 'To' }, { key: 'subject', label: 'Subject' },
      { key: 'status', label: 'Status', render: (n) => badge(n.status, STATUS[n.status] || 'neutral') }, { key: 'attempts', label: 'Attempts', num: true },
      { key: 'last_error', label: 'Error', render: (n) => (n.last_error ? h('span', { class: 'muted' }, n.last_error) : '') }] })
      : emptyState({ iconName: 'mail', title: 'Nothing queued', text: 'Queued and sent reminders appear here.' }) }));
}

// ------------------------------------------------------------ AI adoption --
export async function adminAiScreen({ api }) {
  const rows = await api('/api/ai/adoption');
  return page(banner({ tone: 'info', title: 'Adoption, not performance', text: 'These figures support enablement only and are never used in ratings. Compare within the same tool and time window.' }),
    ...(rows.length ? rows.map((r) => card({ title: `${r.export.tool} · ${r.export.report}`, iconName: 'bot', body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, `${fmt(r.export.window_from)} → ${fmt(r.export.window_to)} · ${r.denominators.accounts} accounts (${r.denominators.licensed} licensed)`),
      statStrip(Object.entries(r.accounts_by_state).map(([k, v]) => ({ iconName: 'users', value: String(v), label: k.replace(/_/g, ' ') }))),
      r.unmatched_accounts.length ? banner({ tone: 'warning', title: 'Accounts not matched to a person', text: r.unmatched_accounts.join(', ') }) : null,
      r.caveats.length ? h('ul', { class: 'bullets muted' }, r.caveats.map((c) => h('li', {}, c))) : null) }))
      : [emptyState({ iconName: 'bot', title: 'No usage exports yet', text: 'Import a Gemini or Claude usage export from Imports.' })]));
}

// ------------------------------------------------------------------ Audit --
export async function adminAuditScreen({ api }) {
  const rows = await api('/api/admin/audit');
  const kinds = [...new Set(rows.map((a) => a.entity))].sort();
  let q = ''; let kind = 'all';
  const table = dataTable({ compact: true, rows, columns: [
    { key: 'at', label: 'When', render: (a) => h('span', { class: 'nowrap' }, new Date(a.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) },
    { key: 'actor', label: 'Who', render: (a) => a.actor || h('span', { class: 'muted' }, 'System') }, { key: 'action', label: 'Action', render: (a) => h('code', {}, a.action) },
    { key: 'entity', label: 'Record', render: (a) => `${a.entity}${a.entity_id ? ` · ${a.entity_id}` : ''}` }, { key: 'reason', label: 'Reason', render: (a) => a.reason || '' }] });
  const apply = () => table.setRows(rows.filter((a) => (kind === 'all' || a.entity === kind) && (!q || `${a.actor} ${a.action} ${a.entity} ${a.entity_id} ${a.reason}`.toLowerCase().includes(q))));
  const search = input({ type: 'search', placeholder: 'Search the audit log', 'aria-label': 'Search the audit log', oninput: (e) => { q = e.target.value.trim().toLowerCase(); apply(); } });
  const kindSel = select([['all', 'All records'], ...kinds.map((k) => [k, k.replace(/_/g, ' ')])], { 'aria-label': 'Record type', onchange: (e) => { kind = e.target.value; apply(); } });
  return page(card({ title: 'Audit log', iconName: 'scroll-text', actions: h('div', { class: 'inline-form' }, search, kindSel), flush: true, body: rows.length ? table : emptyState({ iconName: 'scroll-text', title: 'Nothing recorded yet' }) }),
    h('p', { class: 'muted' }, 'The latest 300 events. Sensitive values (dates of birth, insurance, ratings) are never written to the log, only which fields changed.'));
}
