// Review page: one plan from draft to close. Section nav on the left, items with self |
// manager | calibration side by side, a sticky bar with save state and the next action.
// Same endpoints and permissions as before (the server decides what each person may see
// and do); only the presentation changed and prompt() dialogs became proper modals.
import { h, icon, button, badge, card, banner, stepper, field, input, select, textarea, toast, promptModal, confirmModal, openDrawer } from '/ui.js';

const CAT = { objective: 'Objectives', competency: 'Competencies', initiative: 'Internal initiatives' };
const STEPS = [['draft_plan', 'Plan'], ['approved_plan', 'Approved'], ['self_assessment', 'Self'], ['manager_review', 'Manager'], ['partner_calibration', 'Calibration'], ['released', 'Released'], ['acknowledged', 'Acknowledged'], ['closed', 'Closed']];
const TONE = { closed: 'success', acknowledged: 'success', released: 'info', partner_calibration: 'info', manager_review: 'warning', self_assessment: 'warning', approved_plan: 'info', draft_plan: 'warning' };
const fmt = (s) => (s ? new Date(s.length === 10 ? `${s}T00:00:00` : s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const rerender = () => dispatchEvent(new HashChangeEvent('hashchange'));

export async function reviewScreen({ api, id }) {
  const v = await api(`/api/plans/${id}`);
  const a = v.access;
  if (a.relation === 'project_lead') return leadFeedbackScreen({ api, v });
  if (a.relation === 'input') return inputScreen({ api, v });

  const editSelf = a.relation === 'self' && ['approved_plan', 'self_assessment'].includes(v.state);
  const editMgr = a.editManager; const calib = a.calibrate;
  const draft = v.state === 'draft_plan' && ['self', 'reviewer'].includes(a.relation);
  const closedStates = ['released', 'acknowledged', 'closed'];

  // ---- autosave for self / manager edits (same payloads as before)
  const saveState = h('span', { class: 'save-state', 'aria-live': 'polite' });
  let pending = {}; let timer = null; let sumPending = null;
  const schedule = () => { saveState.textContent = 'Unsaved changes…'; saveState.dataset.state = 'dirty'; clearTimeout(timer); timer = setTimeout(flush, 1200); };
  async function flush() {
    clearTimeout(timer);
    const items = Object.values(pending); const summary = sumPending; pending = {}; sumPending = null;
    if (!items.length && !summary) return true;
    saveState.textContent = 'Saving…'; saveState.dataset.state = 'saving';
    try {
      await api(`/api/plans/${id}/${editSelf ? 'self' : 'manager'}`, { method: 'POST', body: { items, summary } });
      saveState.textContent = `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; saveState.dataset.state = 'saved'; return true;
    } catch (e) { saveState.textContent = 'Not saved'; saveState.dataset.state = 'error'; toast(e.message, 'danger'); return false; }
  }
  const setItem = (itemId, patch) => { pending[itemId] = { ...(pending[itemId] || { id: itemId }), ...patch }; schedule(); };
  const setSummary = (k, val) => { sumPending = { ...(sumPending || {}), [k]: val }; schedule(); };
  window.onbeforeunload = () => (Object.keys(pending).length || sumPending ? true : undefined);
  const act = async (fn, ok) => { if (!(await flush())) return; try { await fn(); if (ok) toast(ok); rerender(); } catch (e) { toast(e.message, 'danger'); } };

  const sections = [];
  const section = (key, title, iconName, ...body) => { const s = h('section', { class: 'review-section', id: `rv-${key}`, 'aria-labelledby': `rv-${key}-h` }, h('h2', { id: `rv-${key}-h`, class: 'review-section-title' }, icon(iconName, { size: 'lg' }), title), ...body); sections.push([key, title, s]); return s; };

  // ---- header
  const stepIdx = Math.max(0, STEPS.findIndex(([s]) => s === v.state));
  const meta = [v.role_title, `Lead reviewer: ${v.reviewer?.name || 'not assigned'}`, v.partner ? `Partner: ${v.partner.name}` : null, v.rubric_version ? `Template ${v.rubric_version}` : null].filter(Boolean);
  const head = h('header', { class: 'review-head' },
    h('div', {}, h('h1', {}, `${v.employee.name} — ${v.cycle.name}`), h('p', { class: 'page-desc' }, meta.join(' · '))),
    h('div', { class: 'review-head-state' }, badge(v.stateLabel, TONE[v.state] || 'neutral')));
  const notices = h('div', { class: 'stack' },
    v.basis_status !== 'verified' ? banner({ tone: v.basis_status === 'gb_decision' ? 'info' : 'warning', title: v.basis_status === 'gb_decision' ? 'Assessment basis: GB decision' : 'Plan not verified yet', text: v.basis_status === 'gb_decision' ? v.basis_note : 'The approved plan for this review has not been verified. Raise it with your reviewer before scoring.' }) : null,
    v.scoring_status !== 'approved' && v.scoring_status !== 'historical' ? banner({ tone: 'info', title: 'Draft rating scale', text: 'The rating scale and thresholds are awaiting GB approval.' }) : null,
    editSelf && v.cycle.self_due ? banner({ tone: 'info', title: `Due ${fmt(v.cycle.self_due)} (Amman time)`, text: 'Changes save automatically. Submit when every item has a rating and a short rationale.' }) : null,
    v.discrepancies?.length ? banner({ tone: 'warning', title: 'Self and manager differ by 1 point or more', text: `${v.discrepancies.map((d) => `${d.title} (${d.self} vs ${d.manager})`).join('; ')}. Check the evidence with project leads before finalising.` }) : null);

  // ---- who reviews
  const reviewers = [];
  const byCat = Object.fromEntries((v.category_reviewers || []).map((r) => [r.category, r.name]));
  for (const c of Object.keys(CAT)) if (v.category_weights[c]) reviewers.push([CAT[c], byCat[c] || v.reviewer?.name || '—']);
  let noteBlock = null;
  if (v.reviewer_note) {
    const n = v.reviewer_note;
    const label = { confirmed: ['Reviewers confirmed', 'success'], change_requested: ['Change of reviewer requested', 'danger'], draft: ['Reviewers in draft — partner to confirm', 'warning'] }[n.status];
    noteBlock = h('div', { class: 'stack' }, h('div', { class: 'row' }, badge(label[0], label[1]), n.confirmed_by ? h('span', { class: 'muted' }, `by ${n.confirmed_by}`) : null),
      n.rationale ? h('p', {}, h('strong', {}, 'Why these reviewers: '), n.rationale) : null,
      n.can_decide && n.status !== 'confirmed' ? h('div', { class: 'form-actions start' },
        button('Confirm reviewers', { variant: 'primary', iconName: 'check', onClick: () => act(() => api(`/api/plans/${id}/reviewer-note`, { method: 'POST', body: { decision: 'confirm' } }), 'Reviewers confirmed') }),
        button('Ask for a change', { onClick: async () => { const note = await promptModal({ title: 'Ask for a different reviewer', label: 'What should change?', confirmLabel: 'Send' }); if (note) act(() => api(`/api/plans/${id}/reviewer-note`, { method: 'POST', body: { decision: 'change', note } }), 'Change requested'); } })) : null);
  }
  const overview = section('overview', 'Overview', 'clipboard-list',
    h('div', { class: 'profile-grid' },
      card({ title: 'Weights and reviewers', iconName: 'scale', body: h('dl', { class: 'kv' }, Object.entries(v.category_weights).filter(([, w]) => w).map(([c, w]) => [h('dt', {}, `${CAT[c]} · ${w}%`), h('dd', {}, reviewers.find(([t]) => t === CAT[c])?.[1] || '—')])) }),
      noteBlock ? card({ title: 'Reviewer choice', iconName: 'user-check', body: noteBlock }) : null));

  // ---- draft plan editor
  const draftSec = draft ? section('plan', 'Plan in draft', 'pencil', draftEditor({ api, v, act })) : null;

  // ---- items by category
  const itemSecs = Object.keys(CAT).map((cat) => {
    const its = v.items.filter((i) => i.category === cat);
    if (!its.length) return null;
    const canEditCat = editMgr && (!a.editCategories || a.editCategories.includes(cat));
    return section(cat, `${CAT[cat]}${v.category_weights[cat] ? ` · ${v.category_weights[cat]}%` : ''}`, cat === 'objective' ? 'target' : cat === 'competency' ? 'award' : 'lightbulb',
      ...its.map((it) => itemCard({ api, v, it, editSelf, editMgr: canEditCat, calib, setItem, act })));
  });

  // ---- projects, feedback and input
  const projBits = [];
  if (v.projects?.length) projBits.push(card({ title: 'Confirmed projects this cycle', iconName: 'folder-kanban', body: h('div', { class: 'stack' },
    h('ul', { class: 'asg-list' }, v.projects.map((p) => h('li', {}, h('div', { class: 'asg-row' }, h('div', {}, h('strong', {}, p.name), h('div', { class: 'muted' }, `${p.kind === 'proposal' ? 'Proposal' : 'Engagement'} · ${p.role}`)),
      a.relation === 'reviewer' && !closedStates.includes(v.state) ? button('Ask lead for feedback', { size: 'sm', iconName: 'send', onClick: () => act(() => api(`/api/plans/${id}/feedback-invite`, { method: 'POST', body: { assignmentId: p.assignment_id } }), 'Project lead invited') }) : null)))),
    editSelf ? field({ label: 'Confirm your projects and what you personally owned or contributed', id: 'projconf', control: textarea({ id: 'projconf', rows: 3, oninput: (e) => setSummary('projects', e.target.value) }, v.summary.self?.projects || '') }) : null) }));
  if (v.project_feedback?.length) projBits.push(card({ title: 'Project lead feedback', iconName: 'messages-square', body: h('div', { class: 'stack' }, v.project_feedback.map((f) => quote(`${f.author} on ${f.project}`, f.body, f.evidence_url))) }));
  if (v.inputs || v.input_invites) {
    const people = a.relation === 'reviewer' && !closedStates.includes(v.state) ? await api('/api/people').catch(() => []) : [];
    const who = select([['', 'Invite someone for input'], ...people.filter((p) => p.id !== v.employee.id).map((p) => [p.id, p.name])], { 'aria-label': 'Invite someone for input' });
    projBits.push(card({ title: 'Input from seniors', iconName: 'users', body: h('div', { class: 'stack' },
      v.input_invites?.length ? h('ul', { class: 'invite-list' }, v.input_invites.map((i) => h('li', {}, h('strong', {}, i.name), h('span', { class: 'muted' }, i.label), i.given ? badge('Given', 'success') : badge('Waiting', 'warning'),
        !i.given && a.relation === 'reviewer' && !closedStates.includes(v.state) ? button('Remove', { size: 'sm', variant: 'ghost', iconName: 'x', onClick: async () => {
          const why = await promptModal({ title: `Withdraw ${i.name}'s input request?`, label: 'Reason (optional)', required: false, confirmLabel: 'Withdraw' });
          if (why !== null) act(() => api(`/api/plans/${id}/input-invites/remove`, { method: 'POST', body: { inviteeId: i.user_id, reason: why } }), 'Request withdrawn');
        } }) : null))) : null,
      (v.inputs || []).map((i) => quote(`${i.author} — ${i.label}`, i.body, i.evidence_url)),
      people.length ? h('div', { class: 'inline-form' }, who, button('Invite', { onClick: () => who.value && act(() => api(`/api/plans/${id}/input-invites`, { method: 'POST', body: { inviteeId: who.value, label: 'Project feedback' } }), 'Invitation added') })) : null) }));
  }
  const projSec = projBits.length ? section('projects', 'Projects and input', 'briefcase', ...projBits) : null;

  // ---- summaries
  const sumBits = [];
  if (a.viewSelf) {
    const s = v.summary.self || {};
    const f = (k, label) => (editSelf ? field({ label, id: `s_${k}`, control: textarea({ id: `s_${k}`, rows: 3, oninput: (e) => setSummary(k, e.target.value) }, s[k] || '') }) : h('div', { class: 'read-field' }, h('h3', {}, label), h('p', {}, s[k] || '—')));
    sumBits.push(card({ title: a.relation === 'self' ? 'Your summary' : 'Employee summary', iconName: 'user', body: h('div', { class: 'stack' },
      f('strongest_outcomes', 'Strongest outcomes'), f('improvements', 'What you would approach differently'), f('proposed_goals', 'Proposed goals for next year'), f('development_priorities', 'Development priorities and support needed'),
      editSelf ? h('p', { class: 'muted' }, 'Optional: add an AI-assisted example under ', h('a', { href: '#/ai' }, 'AI examples'), ' and link it to an objective. Usage figures never affect ratings.') : null) }));
  }
  if (a.viewManager && a.relation !== 'self') {
    const s = v.summary.manager || {};
    const leadEdit = editMgr && a.relation === 'reviewer';
    const f = (k, label, list) => (leadEdit ? field({ label, id: `m_${k}`, help: list ? 'One per line' : null, control: textarea({ id: `m_${k}`, rows: list ? 3 : 2, oninput: (e) => setSummary(k, list ? e.target.value.split('\n').filter(Boolean) : e.target.value) }, list ? (s[k] || []).join('\n') : s[k] || '') })
      : h('div', { class: 'read-field' }, h('h3', {}, label), h('p', {}, (list ? (s[k] || []).join('; ') : s[k]) || '—')));
    sumBits.push(card({ title: 'Manager summary', iconName: 'user-check', body: h('div', { class: 'stack' }, f('strengths', 'One or two supported strengths', true), f('gaps', 'One or two gaps or open questions', true), f('next_action', 'Measurable next action'), f('evidence_checked_with', 'Evidence checked with (project leads)')) }));
  }
  const sumSec = sumBits.length ? section('summary', 'Summaries', 'file-text', h('div', { class: 'profile-grid' }, ...sumBits)) : null;

  // ---- scores and outcome
  const scoreTile = (label, s) => s && h('div', { class: 'score-tile' }, h('div', { class: 'score-label' }, label),
    s.status === 'scored' ? h('div', { class: 'score-value' }, String(s.rounded), h('span', {}, s.rating)) : h('div', { class: 'score-pending' }, s.status === 'incomplete' ? `${s.missing.length} item(s) still to rate` : 'Weights or N/A need attention'),
    h('details', {}, h('summary', {}, 'Show the math'), h('pre', { class: 'math' }, s.math.join('\n')), s.redistributions.length ? h('p', { class: 'muted' }, s.redistributions.map((r) => r.message).join('; ')) : null,
      s.errors.length ? h('ul', { class: 'bullets' }, s.errors.map((e) => h('li', {}, e.message))) : null));
  const tiles = [scoreTile('Self', v.scores.self), scoreTile('Manager', v.scores.manager), scoreTile('Calibrated (final)', v.scores.final)].filter(Boolean);
  const scoreSec = section('scores', 'Scores', 'gauge',
    v.outcome ? card({ title: 'Released result', iconName: 'award', body: h('div', { class: 'stack' },
      h('div', { class: 'score-value big' }, String(v.outcome.final_score ?? '—'), h('span', {}, v.outcome.final_rating || '')), h('p', { class: 'muted' }, `Released ${fmt(v.outcome.released_at)}`),
      v.outcome.math ? h('details', {}, h('summary', {}, 'How this was calculated'), h('pre', { class: 'math' }, v.outcome.math.join('\n'))) : null,
      v.outcome.acknowledged_at ? h('p', {}, `Acknowledged ${fmt(v.outcome.acknowledged_at)}${v.outcome.ack_comment ? ` — “${v.outcome.ack_comment}”` : ''}`) : null) }) : null,
    tiles.length ? h('div', { class: 'score-grid' }, ...tiles) : h('p', { class: 'muted' }, 'Scores appear once ratings are entered.'),
    h('p', { class: 'muted' }, 'Self, manager and final ratings are kept separate. Rounding and rating bands apply only to the final score.'));

  // ---- development actions and check-ins
  let devSec = null;
  if (v.development_actions.length || (a.relation === 'reviewer' && ['released', 'acknowledged', 'manager_review', 'partner_calibration'].includes(v.state))) {
    const t = input({ id: 'da_t', placeholder: 'e.g. Lead one client presentation' }); const due = input({ id: 'da_d', type: 'date' });
    const kind = select([['improvement', 'Improvement'], ['strength', 'Build on a strength'], ['development', 'Development']], { id: 'da_k' });
    devSec = section('actions', 'Development actions', 'list-checks', card({ body: h('div', { class: 'stack' },
      v.development_actions.length ? h('ul', { class: 'asg-list' }, v.development_actions.map((d) => h('li', {}, h('div', { class: 'asg-row' }, h('div', {}, h('strong', {}, d.title), h('div', { class: 'muted' }, `${d.kind} · due ${fmt(d.due_date)}`)),
        h('div', { class: 'asg-actions' }, badge(d.status, d.status === 'done' ? 'success' : 'neutral'),
          ['self', 'reviewer'].includes(a.relation) && d.status !== 'done' ? button('Mark done', { size: 'sm', iconName: 'check', onClick: () => act(() => api(`/api/actions/${d.id}`, { method: 'PATCH', body: { status: 'done' } }), 'Marked done') }) : null))))) : h('p', { class: 'muted' }, 'No actions yet.'),
      a.relation === 'reviewer' ? h('div', { class: 'form-grid' }, field({ label: 'Action', id: 'da_t', control: t }), field({ label: 'Type', id: 'da_k', control: kind }), field({ label: 'Due date', id: 'da_d', control: due }),
        h('div', { class: 'form-actions start align-end' }, button('Add action', { iconName: 'plus', onClick: () => t.value.trim() && act(() => api(`/api/plans/${id}/actions`, { method: 'POST', body: { title: t.value, kind: kind.value, dueDate: due.value, ownerId: v.employee.id } }), 'Action added') }))) : null,
      v.check_ins?.length ? h('div', {}, h('h3', { class: 'kv-head' }, 'Check-ins'), h('ul', { class: 'bullets' }, v.check_ins.map((c) => h('li', {}, `${fmt(c.held_on)} (${c.kind})${c.note ? `: ${c.note}` : ''}`)))) : null) }));
  }

  // ---- history
  const histSec = section('history', 'History', 'history', card({ body: h('div', { class: 'stack' },
    h('ol', { class: 'timeline' }, v.transitions.map((t) => h('li', {}, h('strong', {}, fmt(t.at)), ` ${t.from_state ? `${label(t.from_state)} → ` : ''}${label(t.to_state)}`, t.reason ? h('span', { class: 'muted' }, ` — ${t.reason}`) : null))),
    v.revisions.length ? h('p', { class: 'muted' }, 'Plan revisions: ', v.revisions.map((r) => `rev ${r.revision} (${r.kind}, ${fmt(r.approved_at)})`).join(', ')) : null) }));

  // ---- sticky action bar (same transitions as before)
  const primary = []; const secondary = [];
  const go = (list, label, fn, opts = {}) => list.push(button(label, { variant: opts.variant || (list === primary ? 'primary' : 'secondary'), iconName: opts.iconName, onClick: async () => {
    if (opts.confirm && !(await confirmModal(opts.confirm))) return;
    let extra = {};
    if (opts.ask) { const r = await promptModal(opts.ask); if (r === null) return; extra = { value: r }; }
    act(() => fn(extra.value), opts.done || `${label}: done`);
  } }));
  if (editSelf) go(primary, 'Submit self-assessment', () => api(`/api/plans/${id}/self/submit`, { method: 'POST' }), { iconName: 'send', confirm: { title: 'Submit your self-assessment?', text: 'You can’t edit it after submitting unless your reviewer returns it.', confirmLabel: 'Submit' } });
  if (a.relation === 'self' && ['approved_plan', 'self_assessment'].includes(v.state)) go(secondary, 'Ask for clarification', (q) => api(`/api/plans/${id}/clarifications`, { method: 'POST', body: { question: q } }), { iconName: 'circle-help', ask: { title: 'Ask your reviewer', label: 'What needs clarifying? (e.g. a target or project attribution)', confirmLabel: 'Send' }, done: 'Question sent' });
  if (draft && a.relation === 'reviewer') go(primary, 'Approve plan', () => api(`/api/plans/${id}/approve`, { method: 'POST', body: { note: 'Approved in Prism' } }), { iconName: 'check', confirm: { title: `Approve ${v.employee.name}’s plan?`, text: 'Targets and weights become the agreed basis for this review. Later changes need an amendment.', confirmLabel: 'Approve plan' } });
  if (editMgr && a.relation === 'reviewer') {
    go(primary, 'Submit to partner calibration', () => api(`/api/plans/${id}/manager/submit`, { method: 'POST' }), { iconName: 'send', confirm: { title: 'Submit for partner calibration?', text: 'Every section must be rated. Partners calibrate and release the result.', confirmLabel: 'Submit' } });
    go(secondary, 'Return to employee', (r) => api(`/api/plans/${id}/return`, { method: 'POST', body: { reason: r } }), { iconName: 'rotate-ccw', ask: { title: 'Return to the employee', label: 'Why are you returning it?', confirmLabel: 'Return', tone: 'danger' } });
  }
  if (calib) {
    go(primary, 'Release result', () => api(`/api/plans/${id}/release`, { method: 'POST', body: { note: 'Calibrated' } }), { iconName: 'send', confirm: { title: `Release ${v.employee.name}’s result?`, text: 'They will see their final score and can acknowledge it.', confirmLabel: 'Release' } });
    go(secondary, 'Return to manager', (r) => api(`/api/plans/${id}/return`, { method: 'POST', body: { reason: r } }), { iconName: 'rotate-ccw', ask: { title: 'Return to the manager', label: 'Why are you returning it?', confirmLabel: 'Return', tone: 'danger' } });
  }
  if (a.relation === 'self' && v.state === 'released') go(primary, 'Acknowledge receipt', (c) => api(`/api/plans/${id}/acknowledge`, { method: 'POST', body: { comment: c || null } }), { iconName: 'check', ask: { title: 'Acknowledge your result', text: 'Acknowledging receipt is not the same as agreeing.', label: 'Comment (optional)', required: false, confirmLabel: 'Acknowledge' } });
  if (a.relation === 'reviewer' && v.state === 'acknowledged') go(primary, 'Close review', () => api(`/api/plans/${id}/close`, { method: 'POST' }), { iconName: 'check' });
  if (['self', 'reviewer'].includes(a.relation) && ['approved_plan', 'self_assessment', 'closed', 'acknowledged'].includes(v.state)) go(secondary, 'Log check-in', (n) => api(`/api/plans/${id}/check-ins`, { method: 'POST', body: { kind: 'quarterly', heldOn: new Date().toISOString().slice(0, 10), note: n || '' } }), { iconName: 'calendar-check', ask: { title: 'Log a check-in', label: 'Notes', required: false, confirmLabel: 'Save' }, done: 'Check-in logged' });
  if ((a.relation === 'partner' || a.relation === 'granted') && closedStates.includes(v.state)) go(secondary, 'Reopen…', (r) => api(`/api/plans/${id}/reopen`, { method: 'POST', body: { reason: r } }), { variant: 'danger', iconName: 'rotate-ccw', ask: { title: 'Reopen this review', label: 'Reason (recorded in the audit log)', confirmLabel: 'Reopen', tone: 'danger' } });
  if (['reviewer', 'partner'].includes(a.relation)) secondary.push(button('Export CSV', { variant: 'ghost', iconName: 'download', href: `/api/plans/${id}/export` }));
  const hint = editMgr && a.relation === 'category_reviewer' ? h('span', { class: 'muted' }, `Your ratings save automatically. ${v.reviewer?.name || 'The lead reviewer'} submits once every section is rated.`) : null;
  const bar = primary.length || secondary.length || hint || editSelf || editMgr ? h('div', { class: 'review-bar', role: 'region', 'aria-label': 'Review actions' }, h('div', { class: 'review-bar-state' }, editSelf || editMgr ? saveState : null, hint), h('div', { class: 'review-bar-actions' }, ...secondary, ...primary)) : null;

  // ---- layout: section nav + content
  const nav = h('nav', { class: 'review-nav', 'aria-label': 'Sections' }, h('ol', {}, sections.map(([key, title]) => h('li', {}, h('a', { href: `#rv-${key}`, onclick: (e) => { e.preventDefault(); document.getElementById(`rv-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, title.replace(/ · \d+%$/, ''))))));
  const content = h('div', { class: 'review-content' }, notices, overview, draftSec, ...itemSecs, projSec, sumSec, scoreSec, devSec, histSec);
  const root = h('div', { class: 'review' }, head, stepper(STEPS.map(([, l]) => ({ label: l })), stepIdx), h('div', { class: 'review-layout' }, nav, content), bar);
  root.modern = true; root.noHeader = true; root.area = a.relation === 'self' ? 'growth' : 'manager';
  return root;
}

function label(s) { return { draft_plan: 'Plan in draft', approved_plan: 'Plan approved', self_assessment: 'Self-assessment', manager_review: 'Manager review', partner_calibration: 'Partner calibration', released: 'Result released', acknowledged: 'Acknowledged', closed: 'Closed' }[s] || s; }

function quote(who, body, url) {
  return h('blockquote', { class: 'quote' }, h('p', {}, body), h('footer', {}, h('strong', {}, who), url ? [' · ', h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Evidence ', icon('external-link'))] : null));
}

/** Rating control: segmented buttons for whole-number scales, a select for finer steps. */
function ratingControl({ name, scale, value, onChange, disabled }) {
  const values = []; for (let x = scale.min; x <= scale.max + 1e-9; x += scale.step || 1) values.push(Math.round(x * 10) / 10);
  if (values.length > 11) { const sel = select([['', 'Choose…'], ...values.map((x) => [String(x), String(x)])], { 'aria-label': name, disabled, onchange: (e) => e.target.value && onChange(Number(e.target.value)) }); sel.value = value == null ? '' : String(value); return sel; }
  return h('div', { class: 'rating-seg', role: 'radiogroup', 'aria-label': name }, values.map((x) => h('label', { title: scale.anchors?.[x] || '' },
    h('input', { type: 'radio', name, value: x, checked: value === x, disabled, onchange: () => onChange(x) }), h('span', {}, String(x)))));
}

/** Pick up to three GB strategy KPIs this objective moves (Strategy 2026–2028). */
async function linkStrategy({ api, it }) {
  const st = await api('/api/strategy');
  const chosen = new Set((it.strategy || []).map((k) => k.id));
  const note = h('p', { class: 'muted', 'aria-live': 'polite' });
  const upd = () => { note.textContent = `${chosen.size} of 3 chosen`; };
  const body = h('div', { class: 'stack' }, h('p', {}, `Which GB strategy KPIs does “${it.title}” move? Choose up to three.`), note,
    ...[...new Set(st.objectives.map((o) => o.theme))].map((th) => h('fieldset', { class: 'carry' }, h('legend', {}, th),
      st.objectives.filter((o) => o.theme === th).map((o) => {
        const ks = st.kpis.filter((k) => k.objectives.includes(o.code));
        return h('div', { class: 'stack' }, h('strong', {}, `${o.code} ${o.title_en}`), ks.map((k) => h('label', { class: 'check-row' },
          h('input', { type: 'checkbox', value: k.id, checked: chosen.has(k.id), 'data-kpi': k.id, onchange: (e) => {
            if (e.target.checked && chosen.size >= 3) { e.target.checked = false; toast('Choose at most three', 'danger'); return; }
            document.querySelectorAll(`input[data-kpi="${k.id}"]`).forEach((x) => { x.checked = e.target.checked; });
            e.target.checked ? chosen.add(k.id) : chosen.delete(k.id); upd();
          } }), `${k.code} ${k.name_en}`)));
      }))));
  upd();
  openDrawer({ title: 'Link to GB strategy', iconName: 'target', body, footer: (close) => button('Save links', { variant: 'primary', iconName: 'check', onClick: async () => {
    try { await api(`/api/plan-items/${it.id}/strategy`, { method: 'POST', body: { kpiIds: [...chosen] } }); toast('Strategy links saved'); close(); rerender(); } catch (e) { toast(e.message, 'danger'); }
  } }) });
}

function itemCard({ api, v, it, editSelf, editMgr, calib, setItem, act }) {
  const scale = v.scale; const anchors = it.anchors || scale.anchors;
  const metaBits = [it.weight != null ? `Weight ${it.weight}%` : 'Weight to agree', it.target ? `Target: ${it.target}` : null, it.kpi ? `KPI: ${it.kpi}` : null, it.expected_proficiency ? `Expected proficiency ${it.expected_proficiency}` : null].filter(Boolean);
  const cols = [];
  if ('self_rating' in it || editSelf) {
    const ev = (it.self_evidence || [])[0] || {};
    cols.push(h('div', { class: 'item-col' }, h('h4', {}, icon('user'), ' Self-assessment'), ...(editSelf ? [
      field({ label: 'Actual result', id: `act_${it.id}`, control: input({ id: `act_${it.id}`, value: it.actual || '', oninput: (e) => setItem(it.id, { actual: e.target.value }) }) }),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Self-rating'), ratingControl({ name: `self_${it.id}`, scale, value: it.self_rating, onChange: (x) => setItem(it.id, { self_rating: x }) })),
      field({ label: 'Short rationale', id: `why_${it.id}`, control: textarea({ id: `why_${it.id}`, rows: 2, oninput: (e) => setItem(it.id, { self_rationale: e.target.value }) }, it.self_rationale || '') }),
      field({ label: 'Strongest evidence', id: `ev_${it.id}`, help: 'Drive link — existing sharing permissions apply', control: input({ id: `ev_${it.id}`, type: 'url', value: ev.url || '', placeholder: 'https://drive.google.com/…', oninput: (e) => setItem(it.id, { self_evidence: [{ url: e.target.value }] }) }) }),
      h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: it.na, onchange: async (e) => {
        if (!e.target.checked) return setItem(it.id, { propose_na: false, na_reason: null });
        const why = await promptModal({ title: 'Propose N/A', label: 'Why does this item not apply this year?', confirmLabel: 'Propose' });
        if (why) setItem(it.id, { propose_na: true, na_reason: why }); else e.target.checked = false;
      } }), 'Propose N/A (needs reviewer approval)'),
    ] : [h('div', { class: 'item-rating' }, h('strong', {}, it.self_rating ?? '—'), it.actual ? h('span', { class: 'muted' }, ` · Actual: ${it.actual}`) : null), it.self_rationale ? h('p', {}, it.self_rationale) : null, ev.url ? h('a', { href: ev.url, target: '_blank', rel: 'noopener' }, 'Evidence ', icon('external-link')) : null])));
  }
  if ('manager_rating' in it) {
    cols.push(h('div', { class: 'item-col' }, h('h4', {}, icon('user-check'), ' Manager'), ...(editMgr ? [
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Manager rating'), ratingControl({ name: `mgr_${it.id}`, scale, value: it.manager_rating, onChange: (x) => setItem(it.id, { manager_rating: x }) })),
      field({ label: 'Rationale', id: `mr_${it.id}`, control: textarea({ id: `mr_${it.id}`, rows: 2, oninput: (e) => setItem(it.id, { manager_rationale: e.target.value }) }, it.manager_rationale || '') }),
    ] : [h('div', { class: 'item-rating' }, h('strong', {}, it.manager_rating ?? '—')), it.manager_rationale ? h('p', {}, it.manager_rationale) : null])));
  }
  if ('calibrated_rating' in it && (calib || it.calibrated_rating != null)) {
    const reason = input({ id: `cr_${it.id}`, placeholder: 'Reason for any change', value: it.calibration_reason || '' });
    cols.push(h('div', { class: 'item-col' }, h('h4', {}, icon('scale'), ' Calibration'), ...(calib ? [
      h('p', { class: 'muted' }, `Manager’s rating: ${it.manager_rating ?? '—'}`),
      field({ label: 'Reason', id: `cr_${it.id}`, control: reason }),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Calibrated rating'), ratingControl({ name: `cal_${it.id}`, scale, value: it.calibrated_rating, onChange: (x) => act(() => api(`/api/plans/${v.id}/items/${it.id}/calibrate`, { method: 'POST', body: { calibrated_rating: x, reason: reason.value } }), 'Calibration saved') })),
    ] : [h('div', { class: 'item-rating' }, h('strong', {}, it.calibrated_rating)), it.calibration_reason ? h('p', { class: 'muted' }, it.calibration_reason) : null])));
  }
  const links = it.strategy || [];
  const canLink = v.can_link_strategy && it.category !== 'competency';
  const strat = links.length || canLink ? h('div', { class: 'kpi-links' }, icon('target'), h('span', { class: 'muted' }, links.length ? 'Supports GB strategy:' : 'Not linked to a GB strategy KPI yet'),
    links.map((k) => h('span', { class: 'tag tag-info', title: k.name_en }, `${k.code} ${k.name_en}`)),
    canLink ? button(links.length ? 'Change' : 'Link to strategy', { size: 'sm', variant: 'ghost', iconName: 'pencil', onClick: () => linkStrategy({ api, it }) }) : null) : null;
  return h('article', { class: 'item-card card' },
    h('header', { class: 'item-head' }, h('div', {}, h('h3', {}, it.title, it.carried_from_item_id ? badge('Carried forward', 'info') : null), h('p', { class: 'muted' }, metaBits.join(' · ')), strat),
      it.na ? badge(it.na_approved ? 'N/A approved' : 'N/A proposed', it.na_approved ? 'neutral' : 'warning') : null),
    h('div', { class: 'item-body' },
      it.description ? h('p', {}, it.description) : null,
      anchors ? h('details', { class: 'anchors' }, h('summary', {}, 'Rating anchors'), h('dl', { class: 'kv' }, Object.entries(anchors).map(([k, t]) => [h('dt', {}, k), h('dd', {}, t)]))) : null,
      it.source_rating_raw ? h('p', { class: 'muted' }, `Historical rating (source value): ${it.source_rating_raw}`) : null,
      it.na ? banner({ tone: 'warning', title: it.na_approved ? 'Not applicable (approved)' : 'Not applicable — awaiting approval', text: it.na_reason || 'No reason given',
        actions: !it.na_approved && (editMgr || calib) ? button('Approve N/A', { size: 'sm', onClick: () => act(() => api(`/api/plans/${v.id}/items/${it.id}/approve-na`, { method: 'POST' }), 'N/A approved') }) : null }) : null,
      cols.length ? h('div', { class: `item-cols cols-${cols.length}` }, ...cols) : null));
}

function draftEditor({ api, v, act }) {
  const cw = { ...v.category_weights }; const edits = {};
  const sumCw = h('span', { class: 'muted' });
  const showSum = () => { const t = Object.values(cw).reduce((x, y) => x + (Number(y) || 0), 0); sumCw.textContent = `Total ${t}%`; sumCw.className = t === 100 ? 'muted' : 'field-error'; };
  const weights = h('div', { class: 'form-grid' }, Object.keys(CAT).map((c) => field({ label: `${CAT[c]} %`, id: `cw_${c}`, control: input({ id: `cw_${c}`, type: 'number', min: 0, max: 100, value: cw[c] ?? 0, oninput: (e) => { cw[c] = Number(e.target.value); showSum(); } }) })));
  showSum();
  const edit = (i, k, val) => { edits[i.id] = { ...(edits[i.id] || { id: i.id }), [k]: val }; };
  const rows = v.items.map((i) => h('tr', {}, h('td', {}, CAT[i.category]),
    h('td', {}, input({ 'aria-label': `Item ${i.title}`, value: i.title, oninput: (e) => edit(i, 'title', e.target.value) })),
    h('td', {}, input({ 'aria-label': `KPI for ${i.title}`, value: i.kpi || '', oninput: (e) => edit(i, 'kpi', e.target.value) })),
    h('td', {}, input({ 'aria-label': `Target for ${i.title}`, value: i.target || '', oninput: (e) => edit(i, 'target', e.target.value) })),
    h('td', { class: 'num' }, input({ 'aria-label': `Weight for ${i.title}`, type: 'number', class: 'input input-num', value: i.weight ?? '', oninput: (e) => edit(i, 'weight', Number(e.target.value)) }))));
  const newCat = select(Object.entries(CAT), { 'aria-label': 'New item category' });
  const newTitle = input({ 'aria-label': 'New item title', placeholder: 'New goal or competency' });
  return card({ body: h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Set measures, targets and weights. Category weights must total 100%, and item weights within each category must total 100%.'),
    weights, sumCw,
    h('div', { class: 'table-wrap' }, h('table', { class: 'data compact draft-table' }, h('thead', {}, h('tr', {}, ['Category', 'Item', 'Measure / KPI', 'Target', 'Weight %'].map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, rows))),
    h('div', { class: 'inline-form' }, newCat, newTitle, button('Add item', { iconName: 'plus', onClick: () => newTitle.value.trim() && act(() => api(`/api/plans/${v.id}/draft`, { method: 'POST', body: { upsertItems: [{ category: newCat.value, title: newTitle.value }] } }), 'Item added') })),
    h('div', { class: 'form-actions' }, button('Save draft', { variant: 'primary', iconName: 'check', onClick: () => act(() => api(`/api/plans/${v.id}/draft`, { method: 'POST', body: { categoryWeights: cw, upsertItems: Object.values(edits) } }), 'Draft saved') }))) });
}

function inputScreen({ api, v }) {
  const body = textarea({ id: 'inp_body', rows: 5 }); const ev = input({ type: 'url', id: 'inp_ev', placeholder: 'Drive link to a deliverable (optional)' });
  const root = h('div', { class: 'stack' }, h('header', { class: 'request-head' }, h('h1', {}, `${v.label}: ${v.employee.name}`)),
    banner({ tone: 'info', title: 'Private input', text: 'You were asked for input on the projects you led with this person. You can’t see their ratings or anyone else’s input.' }),
    card({ title: 'Your input', iconName: 'messages-square', body: h('div', { class: 'stack' },
      field({ label: 'What did they deliver, how good was it, and what should they work on next?', id: 'inp_body', control: body }), field({ label: 'Evidence', id: 'inp_ev', control: ev }),
      h('div', { class: 'form-actions' }, button('Send input', { variant: 'primary', iconName: 'send', onClick: async () => {
        if (!body.value.trim()) return toast('Write your input first', 'danger');
        try { await api(`/api/plans/${v.id}/inputs`, { method: 'POST', body: { body: body.value, evidenceUrl: ev.value || null } }); toast('Input sent'); rerender(); } catch (e) { toast(e.message, 'danger'); }
      } }))) }),
    v.myInputs.length ? card({ title: 'Your input so far', iconName: 'history', body: h('div', { class: 'stack' }, v.myInputs.map((i) => h('p', {}, i.body))) }) : null);
  root.modern = true; root.noHeader = true; root.area = 'manager';
  return root;
}

function leadFeedbackScreen({ api, v }) {
  const root = h('div', { class: 'stack' }, h('header', { class: 'request-head' }, h('h1', {}, `Project feedback for ${v.employee.name}`)),
    banner({ tone: 'info', title: 'Only this assignment', text: 'You were invited to give evidence-based feedback on this assignment. You can’t see the rest of the review.' }),
    ...v.assignments.map((asg) => {
      const body = textarea({ id: `fb_${asg.id}`, rows: 4 }); const ev = input({ type: 'url', id: `fbe_${asg.id}`, placeholder: 'Drive link to the deliverable' });
      return card({ title: `${asg.project} — ${asg.role}`, iconName: 'folder-kanban', body: h('div', { class: 'stack' },
        field({ label: 'What did they deliver, how good was it, and what should they work on?', id: `fb_${asg.id}`, control: body }), field({ label: 'Evidence', id: `fbe_${asg.id}`, control: ev }),
        h('div', { class: 'form-actions' }, button('Send feedback', { variant: 'primary', iconName: 'send', onClick: async () => {
          if (!body.value.trim()) return toast('Write your feedback first', 'danger');
          try { await api(`/api/plans/${v.id}/feedback`, { method: 'POST', body: { assignmentId: asg.id, body: body.value, evidenceUrl: ev.value || null } }); toast('Feedback sent'); rerender(); } catch (e) { toast(e.message, 'danger'); }
        } }))) });
    }),
    v.myFeedback.length ? card({ title: 'Your feedback', iconName: 'history', body: h('div', { class: 'stack' }, v.myFeedback.map((f) => h('p', {}, f.body))) }) : null);
  root.modern = true; root.noHeader = true; root.area = 'manager';
  return root;
}
