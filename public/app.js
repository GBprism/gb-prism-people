// GB Prism People & Performance — client. Plain ES modules, no build step.
// All DOM is created with h() (textContent), never innerHTML with data.

// ------------------------------------------------------------- helpers --
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(path, { method, headers: { 'X-Requested-With': 'prism', ...(raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined), credentials: 'same-origin' });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error(data.message || res.statusText); e.status = res.status; e.details = data.details; throw e; }
  return data;
}
const toBase64 = (file) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = fail; r.readAsDataURL(file); });
function errorBox(e) {
  return h('div', { class: 'alert error', role: 'alert' }, h('strong', {}, e.message), e.details?.length ? h('ul', {}, e.details.map((d) => h('li', {}, typeof d === 'string' ? d : d.message || JSON.stringify(d)))) : null);
}
function flash(msg, kind = 'ok') { const b = $('#banner'); b.replaceChildren(h('div', { class: `alert ${kind}` }, msg)); setTimeout(() => { if (b.textContent === msg) b.replaceChildren(); }, 5000); }
async function act(fn, okMsg) { try { const r = await fn(); if (okMsg) flash(okMsg); return r; } catch (e) { $('#banner').replaceChildren(errorBox(e)); window.scrollTo({ top: 0 }); throw e; } }
const fmtDate = (s) => (s ? new Date(s.length === 10 ? s + 'T00:00:00' : s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const CAT = { objective: 'Objectives', competency: 'Competencies', initiative: 'Internal initiatives' };
const stateTone = (s) => (['closed', 'acknowledged', 'released', 'approved'].includes(s) ? 'ok' : ['declined', 'cancelled', 'withdrawn'].includes(s) ? 'danger' : 'warn');

// --------------------------------------------------------------- shell --
let ME = null;
const routes = [
  [/^#\/?$/, home], [/^#\/inbox$/, inbox], [/^#\/review\/(.+)$/, review], [/^#\/timeoff$/, timeoff], [/^#\/request\/(.+)$/, requestPage],
  [/^#\/history$/, history], [/^#\/projects$/, projects], [/^#\/admin(?:\/(\w+))?$/, admin], [/^#\/ai$/, myAi],
];
async function boot() {
  try { ME = await api('/api/me'); } catch (e) { if (e.status === 401) return login(); throw e; }
  const nav = [['#/', 'Home'], ME.nav.inbox && ['#/inbox', 'Team inbox'], ['#/timeoff', 'Time off'], ['#/history', 'My reviews'], ['#/projects', 'Projects'], ['#/ai', 'AI examples'], ME.nav.admin && ['#/admin', 'Admin']].filter(Boolean);
  $('#nav').replaceChildren(...nav.map(([href, t]) => h('a', { href }, t)));
  $('#who').replaceChildren(h('span', {}, `${ME.name}${ME.title ? ' · ' + ME.title : ''}`), h('button', { class: 'btn small', onclick: async () => { await api('/api/logout', { method: 'POST' }); location.hash = '#/'; location.reload(); } }, 'Sign out'));
  window.addEventListener('hashchange', render);
  render();
}
async function render() {
  const hash = location.hash || '#/';
  for (const a of document.querySelectorAll('nav a')) a.toggleAttribute('aria-current', hash === a.getAttribute('href') || (a.getAttribute('href') !== '#/' && hash.startsWith(a.getAttribute('href'))));
  document.querySelectorAll('nav a[aria-current]').forEach((a) => a.setAttribute('aria-current', 'page'));
  $('#banner').replaceChildren();
  const main = $('#main');
  main.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  for (const [re, fn] of routes) {
    const m = re.exec(hash);
    if (m) { try { main.replaceChildren(await fn(...m.slice(1))); } catch (e) { main.replaceChildren(errorBox(e)); } main.focus({ preventScroll: true }); return; }
  }
  main.replaceChildren(h('p', {}, 'Page not found.'));
}
async function login() {
  let users = []; let cfg = {};
  try { cfg = await api('/api/auth/config'); } catch { /* ignore */ }
  if (cfg.google) {
    return $('#main').replaceChildren(h('div', { class: 'card' }, h('h1', {}, 'Sign in'), h('p', { class: 'muted' }, `Use your @${cfg.domain} Google Workspace account.`), h('a', { class: 'btn primary', href: '/auth/google' }, 'Sign in with Google')));
  }
  try { users = await api('/api/dev/users'); } catch { /* production: gateway handles sign-in */ }
  $('#main').replaceChildren(h('div', { class: 'card' }, h('h1', {}, 'Sign in'),
    users.length ? [h('p', { class: 'muted' }, 'Development mode — choose a synthetic account. Production uses GB Prism sign-in.'),
      h('div', { class: 'grid' }, users.map((u) => h('button', { class: 'btn', onclick: async () => { await api('/api/dev/login', { method: 'POST', body: { userId: u.id } }); location.reload(); } },
        h('span', {}, h('strong', {}, u.name), h('br'), h('span', { class: 'small muted' }, `${u.roles || 'employee'} · ${u.tenant}`)))))]
      : h('p', {}, 'Please sign in through GB Prism.')));
}

// ---------------------------------------------------------------- home --
async function home() {
  const d = await api('/api/home');
  const n = d.next;
  return h('div', {},
    h('h1', {}, `Hello, ${ME.name.split(' ')[0]}`),
    h('div', { class: 'grid' },
      h('section', { class: 'card hero', 'aria-labelledby': 'next' }, h('h2', { id: 'next' }, 'My next action'), h('p', {}, n.label), n.due ? h('p', { class: 'small muted' }, `Due ${fmtDate(n.due)} (Amman time)`) : null, n.link ? h('a', { class: 'btn primary', href: n.link }, 'Open') : null),
      h('section', { class: 'card', 'aria-labelledby': 'perf' }, h('h2', { id: 'perf' }, 'My performance'),
        d.plans.length ? h('ul', {}, d.plans.map((p) => h('li', {}, h('a', { href: `#/review/${p.id}` }, p.cycle), ' ', h('span', { class: `pill ${stateTone(p.state)}` }, p.stateLabel)))) : h('p', { class: 'muted' }, 'No active plan yet.'),
        d.development_actions.length ? [h('h3', {}, 'Development actions'), h('ul', {}, d.development_actions.map((a) => h('li', {}, a.title, a.due_date ? h('span', { class: 'small muted' }, ` · due ${fmtDate(a.due_date)}`) : null)))] : null),
      h('section', { class: 'card', 'aria-labelledby': 'to' }, h('h2', { id: 'to' }, 'My time off'),
        h('table', {}, h('tbody', {}, d.balances.map((b) => h('tr', {}, h('td', {}, b.name), h('td', {}, h('strong', {}, b.posted), ' days'), h('td', { class: 'small muted' }, b.pending !== '0' ? `${b.pending.replace('-', '')} pending` : ''))))),
        h('p', { class: 'small' }, `Off-site this month: ${d.offsite.used} of ${d.offsite.quota} days`),
        d.policy_status !== 'approved' ? h('p', { class: 'small muted' }, 'Rules shown are awaiting GB confirmation.') : null),
      h('section', { class: 'card', 'aria-labelledby': 'rq' }, h('h2', { id: 'rq' }, 'Request time off'), h('p', { class: 'muted' }, 'Leave or off-site work. You will see the working days and your balance before you submit.'), h('a', { class: 'btn primary', href: '#/timeoff' }, 'New request'),
        d.requests.length ? h('ul', { class: 'small' }, d.requests.map((r) => h('li', {}, `${r.type.name}: ${fmtDate(r.start_date)}${r.end_date !== r.start_date ? ' → ' + fmtDate(r.end_date) : ''} `, h('span', { class: `pill ${stateTone(r.state)}` }, r.state)))) : null)));
}

// --------------------------------------------------------------- inbox --
async function inbox() {
  const { items } = await api('/api/inbox');
  const types = [...new Set(items.map((i) => i.type))];
  let filter = null;
  const list = h('div', {});
  const draw = () => list.replaceChildren(...(items.filter((i) => !filter || i.type === filter).map((i) => h('div', { class: 'item' },
    h('header', {}, h('div', {}, h('span', { class: 'pill' }, i.kind), ' ', h('a', { href: i.link }, i.title)), h('span', { class: 'small muted' }, i.due ? `Due ${fmtDate(i.due)}` : '', i.warnings ? ` · ${i.warnings} warning(s)` : ''))))));
  if (!items.length) list.append(h('p', { class: 'muted' }, 'Nothing waiting for you.'));
  else draw();
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter' },
    [null, ...types].map((t) => h('button', { class: 'btn small', 'aria-pressed': String(t === filter), onclick: (e) => { filter = t; chips.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); draw(); } }, t ? t[0].toUpperCase() + t.slice(1) : 'All')));
  const progress = await api('/api/team/progress').catch(() => []);
  return h('div', {}, h('h1', {}, 'Team inbox'), chips, list,
    progress.length ? h('section', { class: 'card' }, h('h2', {}, 'Team progress'), h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Person', 'Cycle', 'Stage', 'Check-ins', 'Open actions'].map((x) => h('th', {}, x)))),
      h('tbody', {}, progress.map((p) => h('tr', {}, h('td', {}, h('a', { href: `#/review/${p.id}` }, p.name)), h('td', {}, p.cycle), h('td', {}, p.stateLabel), h('td', {}, p.check_ins), h('td', {}, p.open_actions))))))) : null);
}

// -------------------------------------------------------------- review --
async function review(id) {
  const v = await api(`/api/plans/${id}`);
  const a = v.access;
  if (a.relation === 'project_lead') return leadFeedback(v);
  if (a.relation === 'input') return inputPage(v);
  const root = h('div', {});
  const saveState = h('span', { class: 'savestate', 'aria-live': 'polite' });
  const editSelf = a.relation === 'self' && ['approved_plan', 'self_assessment'].includes(v.state);
  const editMgr = a.editManager; const calib = a.calibrate; const draft = v.state === 'draft_plan' && ['self', 'reviewer'].includes(a.relation);

  // autosave queue for self / manager edits
  let pending = {}; let timer = null; let sumPending = null;
  const schedule = () => { saveState.textContent = 'Unsaved changes…'; clearTimeout(timer); timer = setTimeout(flush, 1200); };
  async function flush() {
    const items = Object.values(pending); const summary = sumPending; pending = {}; sumPending = null;
    if (!items.length && !summary) return;
    saveState.textContent = 'Saving…';
    try { await api(`/api/plans/${id}/${editSelf ? 'self' : 'manager'}`, { method: 'POST', body: { items, summary } }); saveState.textContent = `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; }
    catch (e) { saveState.textContent = 'Not saved'; $('#banner').replaceChildren(errorBox(e)); }
  }
  const setItem = (itemId, patch) => { pending[itemId] = { ...(pending[itemId] || { id: itemId }), ...patch }; schedule(); };
  const setSummary = (k, val) => { sumPending = { ...(sumPending || {}), [k]: val }; schedule(); };
  window.onbeforeunload = () => (Object.keys(pending).length ? true : undefined);

  root.append(h('div', { class: 'row spread' },
    h('div', {}, h('h1', {}, `${v.employee.name} — ${v.cycle.name}`), h('p', { class: 'muted small' },
      [v.role_title, `Reviewer: ${v.reviewer?.name || 'unassigned'}`, v.partner ? `Partner: ${v.partner.name}` : null, v.rubric_version ? `Template ${v.rubric_version}` : null, v.approved_revision ? `Approved plan rev. ${v.approved_revision}` : null].filter(Boolean).join(' · '))),
    h('div', {}, h('span', { class: `pill ${stateTone(v.state)}` }, v.stateLabel), ' ', saveState)));
  if (v.basis_status !== 'verified') root.append(h('div', { class: 'alert warn' }, v.basis_status === 'gb_decision' ? `Assessment basis: GB decision — ${v.basis_note}` : 'The approved plan for this review has not been verified yet. Raise it with your manager before scoring.'));
  if (v.scoring_status !== 'approved' && v.scoring_status !== 'historical') root.append(h('p', { class: 'small muted' }, 'Rating scale and thresholds are candidates awaiting GB approval.'));
  if (editSelf && v.cycle.self_due) root.append(h('p', {}, `Please complete by ${fmtDate(v.cycle.self_due)} (Amman time). Changes save automatically.`));

  if (v.category_reviewers?.length) root.append(h('p', { class: 'small' }, 'Section reviewers: ', v.category_reviewers.map((r) => `${CAT[r.category]} — ${r.name}`).join(' · '), ` · Lead reviewer: ${v.reviewer?.name || '—'}`));
  // weights summary
  root.append(h('p', { class: 'small' }, 'Weights: ', Object.entries(v.category_weights).filter(([, w]) => w).map(([c, w]) => `${CAT[c]} ${w}%`).join(' · ')));

  if (draft) root.append(draftEditor(v));
  for (const cat of ['objective', 'competency', 'initiative']) {
    const its = v.items.filter((i) => i.category === cat);
    if (!its.length) continue;
    root.append(h('h2', {}, `${CAT[cat]}${v.category_weights[cat] ? ` · ${v.category_weights[cat]}%` : ''}`));
    for (const it of its) root.append(itemCard(v, it, { editSelf, editMgr: editMgr && (!a.editCategories || a.editCategories.includes(it.category)), calib, setItem, id }));
  }

  // projects & evidence
  if (v.projects?.length) root.append(h('section', { class: 'card' }, h('h2', {}, 'Confirmed projects this cycle'),
    h('ul', {}, v.projects.map((p) => h('li', {}, `${p.name} (${p.kind}) — ${p.role}`, a.relation === 'reviewer' && !['released', 'acknowledged', 'closed'].includes(v.state) ? h('button', { class: 'btn small ml', onclick: () => act(() => api(`/api/plans/${id}/feedback-invite`, { method: 'POST', body: { assignmentId: p.assignment_id } }), 'Project lead invited') }, 'Ask lead for feedback') : null))),
    editSelf ? h('div', {}, h('label', { for: 'projconf' }, 'Confirm your projects and what you personally owned or contributed'), h('textarea', { id: 'projconf', oninput: (e) => setSummary('projects', e.target.value) }, v.summary.self?.projects || '')) : null));
  if (v.project_feedback?.length) root.append(h('section', { class: 'card' }, h('h2', {}, 'Project lead feedback'), v.project_feedback.map((f) => h('div', { class: 'side' }, h('strong', {}, `${f.author} on ${f.project}`), h('p', {}, f.body), f.evidence_url ? h('a', { href: f.evidence_url, rel: 'noopener', target: '_blank' }, 'Evidence') : null))));
  if (v.inputs || v.input_invites) {
    const people = a.relation === 'reviewer' && !['released', 'acknowledged', 'closed'].includes(v.state) ? await api('/api/people') : [];
    const who = h('select', { 'aria-label': 'Invite' }, h('option', { value: '' }, '— invite someone for input —'), people.filter((p) => p.id !== v.employee.id).map((p) => h('option', { value: p.id }, p.name)));
    root.append(h('section', { class: 'card' }, h('h2', {}, 'Input from project seniors'),
      v.input_invites?.length ? h('p', { class: 'small' }, v.input_invites.map((i) => `${i.name} (${i.label}) ${i.given ? '✓' : '— waiting'}`).join(' · ')) : null,
      (v.inputs || []).map((i) => h('div', { class: 'side' }, h('strong', {}, `${i.author} — ${i.label}`), h('p', {}, i.body), i.evidence_url ? h('a', { href: i.evidence_url, target: '_blank', rel: 'noopener' }, 'Evidence') : null)),
      people.length ? h('div', { class: 'row mt' }, who, h('button', { class: 'btn', onclick: () => act(() => api(`/api/plans/${id}/input-invites`, { method: 'POST', body: { inviteeId: who.value, label: 'Project feedback' } }), 'Invitation added').then(render) }, 'Invite')) : null));
  }
  if (v.discrepancies?.length) root.append(h('div', { class: 'alert warn' }, h('strong', {}, 'Self vs manager differences of 1 point or more: '), v.discrepancies.map((d) => `${d.title} (${d.self} vs ${d.manager})`).join('; '), '. Check evidence with project leads before finalising.'));

  // self summary
  if (a.viewSelf) {
    const s = v.summary.self || {};
    const f = (k, label) => h('div', {}, h('label', { for: `s_${k}` }, label), editSelf ? h('textarea', { id: `s_${k}`, oninput: (e) => setSummary(k, e.target.value) }, s[k] || '') : h('p', {}, s[k] || '—'));
    root.append(h('section', { class: 'card' }, h('h2', {}, a.relation === 'self' ? 'Your summary' : 'Employee summary'), f('strongest_outcomes', 'Strongest outcomes'), f('improvements', 'What you would approach differently'), f('proposed_goals', 'Proposed goals for next year'), f('development_priorities', 'Development priorities and support needed'),
      editSelf ? h('p', { class: 'small muted' }, 'Optional: add an AI-assisted example under ', h('a', { href: '#/ai' }, 'AI examples'), ' and link it to an objective. Usage figures never affect ratings.') : null));
  }
  if (a.viewManager && a.relation !== 'self') {
    const s = v.summary.manager || {};
    const leadEdit = editMgr && a.relation === 'reviewer';
    const f = (k, label, list) => h('div', {}, h('label', { for: `m_${k}` }, label), leadEdit ? h('textarea', { id: `m_${k}`, oninput: (e) => setSummary(k, list ? e.target.value.split('\n').filter(Boolean) : e.target.value) }, list ? (s[k] || []).join('\n') : s[k] || '') : h('p', {}, (list ? (s[k] || []).join('; ') : s[k]) || '—'));
    root.append(h('section', { class: 'card' }, h('h2', {}, 'Manager summary'), f('strengths', 'One or two supported strengths (one per line)', true), f('gaps', 'One or two gaps or open questions (one per line)', true), f('next_action', 'Measurable next action'), f('evidence_checked_with', 'Evidence checked with (project leads)')));
  }

  // scores
  const scoreBlock = (label, s) => s && h('div', { class: 'side' }, h('strong', {}, label), ' ', s.status === 'scored' ? h('span', {}, `${s.rounded} — ${s.rating}`) : h('span', { class: 'muted' }, s.status === 'incomplete' ? `${s.missing.length} item(s) still to complete` : 'Weights or N/A need attention'),
    h('details', {}, h('summary', {}, 'Show the math'), h('div', { class: 'math' }, s.math.join('\n')), s.redistributions.length ? h('p', { class: 'small' }, s.redistributions.map((r) => r.message).join('; ')) : null, s.errors.length ? h('ul', { class: 'small' }, s.errors.map((e) => h('li', {}, e.message))) : null));
  root.append(h('section', { class: 'card' }, h('h2', {}, 'Scores'), h('p', { class: 'small muted' }, 'Self, manager and final ratings are kept separate. Precision and thresholds apply only to the final score.'),
    h('div', { class: 'cols' }, scoreBlock('Self', v.scores.self), scoreBlock('Manager', v.scores.manager), scoreBlock('Calibrated (final)', v.scores.final))));
  if (v.outcome) root.append(h('section', { class: 'card hero' }, h('h2', {}, 'Released result'), h('p', {}, h('strong', {}, `${v.outcome.final_score ?? '—'} ${v.outcome.final_rating ? '— ' + v.outcome.final_rating : ''}`), ` · released ${fmtDate(v.outcome.released_at)}`),
    v.outcome.math ? h('details', {}, h('summary', {}, 'How this was calculated'), h('div', { class: 'math' }, v.outcome.math.join('\n'))) : null,
    v.outcome.acknowledged_at ? h('p', { class: 'small' }, `Acknowledged ${fmtDate(v.outcome.acknowledged_at)}${v.outcome.ack_comment ? ' — "' + v.outcome.ack_comment + '"' : ''}`) : null));

  // development actions
  if (v.development_actions.length || (a.relation === 'reviewer' && ['released', 'acknowledged', 'manager_review', 'partner_calibration'].includes(v.state))) {
    const t = h('input', { id: 'da_t', placeholder: 'e.g. Lead one client presentation' }); const due = h('input', { id: 'da_d', type: 'date' }); const kind = h('select', { id: 'da_k' }, ['improvement', 'strength', 'development'].map((k) => h('option', { value: k }, k)));
    root.append(h('section', { class: 'card' }, h('h2', {}, 'Development actions'),
      h('ul', {}, v.development_actions.map((d) => h('li', {}, `${d.title} (${d.kind}) · due ${fmtDate(d.due_date)} · `, h('span', { class: 'pill' }, d.status),
        ['self', 'reviewer'].includes(a.relation) && d.status !== 'done' ? h('button', { class: 'btn small ml', onclick: () => act(() => api(`/api/actions/${d.id}`, { method: 'PATCH', body: { status: 'done' } }), 'Marked done').then(render) }, 'Mark done') : null))),
      a.relation === 'reviewer' ? h('div', { class: 'cols' }, h('div', {}, h('label', { for: 'da_t' }, 'Action'), t), h('div', {}, h('label', { for: 'da_k' }, 'Type'), kind), h('div', {}, h('label', { for: 'da_d' }, 'Due date'), due),
        h('div', {}, h('label', {}, ' '), h('button', { class: 'btn', onclick: () => act(() => api(`/api/plans/${id}/actions`, { method: 'POST', body: { title: t.value, kind: kind.value, dueDate: due.value, ownerId: v.employee.id } }), 'Action added').then(render) }, 'Add action'))) : null));
  }

  // actions bar
  const bar = h('div', { class: 'row card' });
  const reasonPrompt = (msg) => { const r = prompt(msg); if (!r) throw new Error('A reason is required'); return r; };
  const go = (label, fn, cls = '') => bar.append(h('button', { class: `btn ${cls}`, onclick: async () => { await flush(); await act(fn, `${label}: done`); render(); } }, label));
  if (editSelf) go('Submit self-assessment', () => api(`/api/plans/${id}/self/submit`, { method: 'POST' }), 'primary');
  if (a.relation === 'self' && ['approved_plan', 'self_assessment'].includes(v.state)) go('Ask for clarification', () => api(`/api/plans/${id}/clarifications`, { method: 'POST', body: { question: reasonPrompt('What needs clarifying (e.g. a target or project attribution)?') } }));
  if (editMgr && a.relation === 'category_reviewer') bar.append(h('span', { class: 'small muted' }, `Your ratings save automatically. ${v.reviewer?.name || 'The lead reviewer'} submits the review once every section is rated.`));
  if (editMgr && a.relation === 'reviewer') { go('Submit to partner calibration', () => api(`/api/plans/${id}/manager/submit`, { method: 'POST' }), 'primary'); go('Return to employee', () => api(`/api/plans/${id}/return`, { method: 'POST', body: { reason: reasonPrompt('Why are you returning it?') } })); }
  if (calib) { go('Release result', () => api(`/api/plans/${id}/release`, { method: 'POST', body: { note: 'Calibrated' } }), 'primary'); go('Return to manager', () => api(`/api/plans/${id}/return`, { method: 'POST', body: { reason: reasonPrompt('Why are you returning it?') } })); }
  if (a.relation === 'self' && v.state === 'released') go('Acknowledge receipt', () => api(`/api/plans/${id}/acknowledge`, { method: 'POST', body: { comment: prompt('Optional comment (acknowledging receipt is not agreement):') || null } }), 'primary');
  if (a.relation === 'reviewer' && v.state === 'acknowledged') go('Close review', () => api(`/api/plans/${id}/close`, { method: 'POST' }), 'primary');
  if (draft && a.relation === 'reviewer') go('Approve plan', () => api(`/api/plans/${id}/approve`, { method: 'POST', body: { note: 'Approved in Prism' } }), 'primary');
  if ((a.relation === 'partner' || a.relation === 'granted') && ['released', 'acknowledged', 'closed'].includes(v.state)) go('Reopen…', () => api(`/api/plans/${id}/reopen`, { method: 'POST', body: { reason: reasonPrompt('Reason for reopening (audited):') } }), 'danger');
  if (['reviewer', 'partner'].includes(a.relation)) bar.append(h('a', { class: 'btn', href: `/api/plans/${id}/export` }, 'Export CSV'));
  if (['self', 'reviewer'].includes(a.relation) && ['approved_plan', 'self_assessment', 'closed', 'acknowledged'].includes(v.state)) go('Log check-in', () => api(`/api/plans/${id}/check-ins`, { method: 'POST', body: { kind: 'quarterly', heldOn: new Date().toISOString().slice(0, 10), note: prompt('Check-in notes:') || '' } }));
  if (bar.children.length) root.append(bar);

  root.append(h('details', { class: 'card' }, h('summary', {}, 'History'), h('ul', { class: 'small' }, v.transitions.map((t) => h('li', {}, `${fmtDate(t.at)}: ${t.from_state || '—'} → ${t.to_state}${t.reason ? ' — ' + t.reason : ''}`))),
    v.revisions.length ? h('p', { class: 'small' }, 'Plan revisions: ', v.revisions.map((r) => `rev ${r.revision} (${r.kind}, ${fmtDate(r.approved_at)})`).join(', ')) : null));
  return root;
}

function itemCard(v, it, { editSelf, editMgr, calib, setItem, id }) {
  const scale = v.scale; const values = []; for (let x = scale.min; x <= scale.max + 1e-9; x += scale.step || 1) values.push(Math.round(x * 10) / 10);
  const radios = (name, cur, onchange, disabled) => h('div', { class: 'rating', role: 'radiogroup', 'aria-label': name }, values.map((x) => h('label', { title: scale.anchors?.[x] || '' }, h('input', { type: 'radio', name: `${name}_${it.id}`, value: x, checked: cur === x, disabled, onchange: () => onchange(x) }), String(x))));
  const anchors = it.anchors || scale.anchors;
  const card = h('article', { class: 'item' },
    h('header', {}, h('div', {}, h('strong', {}, it.title), it.carried_from_item_id ? h('span', { class: 'pill ml' }, 'carried forward') : null),
      h('span', { class: 'small muted' }, [it.weight != null ? `Weight ${it.weight}%` : 'Weight to agree', it.target ? `Target: ${it.target}` : null, it.kpi ? `KPI: ${it.kpi}` : null, it.expected_proficiency ? `Expected proficiency ${it.expected_proficiency}` : null].filter(Boolean).join(' · '))),
    it.description ? h('p', { class: 'small' }, it.description) : null,
    anchors ? h('details', { class: 'small' }, h('summary', {}, 'Rating anchors'), h('ul', {}, Object.entries(anchors).map(([k, t]) => h('li', {}, `${k}: ${t}`)))) : null,
    it.source_rating_raw ? h('p', { class: 'small' }, `Historical rating (source value): ${it.source_rating_raw}`) : null,
    it.na ? h('div', { class: 'alert warn small' }, `Marked N/A — ${it.na_reason || 'no reason'} ${it.na_approved ? '(approved)' : '(awaiting approval)'}`,
      !it.na_approved && (editMgr || calib) ? h('button', { class: 'btn small ml', onclick: () => act(() => api(`/api/plans/${id}/items/${it.id}/approve-na`, { method: 'POST' }), 'N/A approved').then(render) }, 'Approve N/A') : null) : null);
  const cols = h('div', { class: 'cols' });
  if ('self_rating' in it || editSelf) {
    const ev = (it.self_evidence || [])[0] || {};
    cols.append(h('div', { class: 'side' }, h('h3', {}, 'Self-assessment'),
      editSelf ? [
        h('label', { for: `act_${it.id}` }, 'Actual result'), h('input', { id: `act_${it.id}`, value: it.actual || '', oninput: (e) => setItem(it.id, { actual: e.target.value }) }),
        h('label', {}, 'Self-rating'), radios('self', it.self_rating, (x) => setItem(it.id, { self_rating: x })),
        h('label', { for: `why_${it.id}` }, 'Short rationale'), h('textarea', { id: `why_${it.id}`, oninput: (e) => setItem(it.id, { self_rationale: e.target.value }) }, it.self_rationale || ''),
        h('label', { for: `ev_${it.id}` }, 'Strongest evidence (Drive link — existing permissions apply)'), h('input', { id: `ev_${it.id}`, type: 'url', value: ev.url || '', placeholder: 'https://drive.google.com/…', oninput: (e) => setItem(it.id, { self_evidence: [{ url: e.target.value }] }) }),
        h('label', { class: 'small plain' }, h('input', { type: 'checkbox', class: 'inline-check', checked: it.na, onchange: (e) => setItem(it.id, { propose_na: e.target.checked, na_reason: e.target.checked ? prompt('Why is this item not applicable?') : null }) }), ' Propose N/A (needs manager approval)'),
      ] : [h('p', {}, h('strong', {}, it.self_rating ?? '—'), it.actual ? ` · Actual: ${it.actual}` : ''), h('p', { class: 'small' }, it.self_rationale || ''), ev.url ? h('a', { href: ev.url, target: '_blank', rel: 'noopener' }, 'Evidence') : null]));
  }
  if ('manager_rating' in it) {
    cols.append(h('div', { class: 'side' }, h('h3', {}, 'Manager'),
      editMgr ? [h('label', {}, 'Manager rating'), radios('mgr', it.manager_rating, (x) => setItem(it.id, { manager_rating: x })),
        h('label', { for: `mr_${it.id}` }, 'Rationale'), h('textarea', { id: `mr_${it.id}`, oninput: (e) => setItem(it.id, { manager_rationale: e.target.value }) }, it.manager_rationale || '')]
        : [h('p', {}, h('strong', {}, it.manager_rating ?? '—')), h('p', { class: 'small' }, it.manager_rationale || '')]));
  }
  if ('calibrated_rating' in it && (calib || it.calibrated_rating != null)) {
    const reason = h('input', { id: `cr_${it.id}`, placeholder: 'Reason for any change', value: it.calibration_reason || '' });
    cols.append(h('div', { class: 'side' }, h('h3', {}, 'Calibration'),
      calib ? [h('p', { class: 'small' }, `Original (manager): ${it.manager_rating ?? '—'}`), radios('cal', it.calibrated_rating, (x) => act(() => api(`/api/plans/${id}/items/${it.id}/calibrate`, { method: 'POST', body: { calibrated_rating: x, reason: reason.value } }), 'Calibration saved').then(render), false), h('label', { for: `cr_${it.id}` }, 'Reason'), reason]
        : h('p', {}, h('strong', {}, it.calibrated_rating), it.calibration_reason ? ` — ${it.calibration_reason}` : '')));
  }
  if (cols.children.length) card.append(cols);
  return card;
}

function draftEditor(v) {
  const box = h('section', { class: 'card' }, h('h2', {}, 'Plan in draft'), h('p', { class: 'small muted' }, 'Set fresh measures, baselines, targets, dates, weights and support. Category weights must total 100% and item weights within each category must total 100%.'));
  const cw = { ...v.category_weights };
  box.append(h('div', { class: 'cols' }, ['objective', 'competency', 'initiative'].map((c) => h('div', {}, h('label', { for: `cw_${c}` }, `${CAT[c]} %`), h('input', { id: `cw_${c}`, type: 'number', min: 0, max: 100, value: cw[c] ?? 0, oninput: (e) => { cw[c] = Number(e.target.value); } })))));
  const edits = {};
  const tbl = h('table', {}, h('thead', {}, h('tr', {}, ['Category', 'Item', 'Measure / KPI', 'Target', 'Weight %'].map((x) => h('th', {}, x)))),
    h('tbody', {}, v.items.map((i) => h('tr', {}, h('td', {}, CAT[i.category]), h('td', {}, h('input', { 'aria-label': 'Item', value: i.title, oninput: (e) => { edits[i.id] = { ...(edits[i.id] || { id: i.id }), title: e.target.value }; } })),
      h('td', {}, h('input', { 'aria-label': 'KPI', value: i.kpi || '', oninput: (e) => { edits[i.id] = { ...(edits[i.id] || { id: i.id }), kpi: e.target.value }; } })),
      h('td', {}, h('input', { 'aria-label': 'Target', value: i.target || '', oninput: (e) => { edits[i.id] = { ...(edits[i.id] || { id: i.id }), target: e.target.value }; } })),
      h('td', {}, h('input', { 'aria-label': 'Weight', type: 'number', value: i.weight ?? '', oninput: (e) => { edits[i.id] = { ...(edits[i.id] || { id: i.id }), weight: Number(e.target.value) }; } }))))));
  const newCat = h('select', { 'aria-label': 'New item category' }, Object.entries(CAT).map(([k, t]) => h('option', { value: k }, t)));
  const newTitle = h('input', { 'aria-label': 'New item title', placeholder: 'New goal or competency' });
  box.append(h('div', { class: 'table-wrap' }, tbl), h('div', { class: 'row' }, newCat, newTitle,
    h('button', { class: 'btn', onclick: () => act(() => api(`/api/plans/${v.id}/draft`, { method: 'POST', body: { upsertItems: [{ category: newCat.value, title: newTitle.value }] } }), 'Item added').then(render) }, 'Add item'),
    h('button', { class: 'btn primary', onclick: () => act(() => api(`/api/plans/${v.id}/draft`, { method: 'POST', body: { categoryWeights: cw, upsertItems: Object.values(edits) } }), 'Draft saved').then(render) }, 'Save draft')));
  return box;
}

function inputPage(v) {
  const body = h('textarea', { id: 'inp_body' }); const ev = h('input', { type: 'url', id: 'inp_ev', placeholder: 'Drive link to a deliverable (optional)' });
  return h('div', {}, h('h1', {}, `${v.label}: ${v.employee.name}`), h('p', { class: 'muted' }, 'You were asked for input on the projects you led with this person. You cannot see their ratings or anyone else\'s input.'),
    h('section', { class: 'card' }, h('label', { for: 'inp_body' }, 'What did they deliver, how good was it, and what should they work on next?'), body, h('label', { for: 'inp_ev' }, 'Evidence'), ev,
      h('button', { class: 'btn primary mt', onclick: () => act(() => api(`/api/plans/${v.id}/inputs`, { method: 'POST', body: { body: body.value, evidenceUrl: ev.value || null } }), 'Input sent').then(render) }, 'Send input')),
    v.myInputs.length ? h('section', { class: 'card' }, h('h2', {}, 'Your input so far'), v.myInputs.map((i) => h('p', {}, i.body))) : null);
}

function leadFeedback(v) {
  return h('div', {}, h('h1', {}, `Project feedback for ${v.employee.name}`), h('p', { class: 'muted' }, 'You were invited to give evidence-based feedback on this assignment only. You cannot see the rest of the review.'),
    v.assignments.map((asg) => {
      const body = h('textarea', { id: `fb_${asg.id}` }); const ev = h('input', { type: 'url', id: `fbe_${asg.id}`, placeholder: 'Drive link to the deliverable' });
      return h('section', { class: 'card' }, h('h2', {}, `${asg.project} — ${asg.role}`), h('label', { for: `fb_${asg.id}` }, 'What did they deliver, how good was it, and what should they work on?'), body, h('label', { for: `fbe_${asg.id}` }, 'Evidence'), ev,
        h('button', { class: 'btn primary mt', onclick: () => act(() => api(`/api/plans/${v.id}/feedback`, { method: 'POST', body: { assignmentId: asg.id, body: body.value, evidenceUrl: ev.value || null } }), 'Feedback sent').then(render) }, 'Send feedback'));
    }),
    v.myFeedback.length ? h('section', { class: 'card' }, h('h2', {}, 'Your feedback'), v.myFeedback.map((f) => h('p', {}, f.body))) : null);
}

// ------------------------------------------------------------ time off --
async function timeoff() {
  const [types, mine, people] = await Promise.all([api('/api/leave/types'), api('/api/leave/requests'), api('/api/people')]);
  const f = { typeCode: types[0]?.code, start: '', end: '', startPortion: 'full', endPortion: 'full', coverUserId: '', reason: '', handover: '', exceptionReason: '' };
  const preview = h('div', { 'aria-live': 'polite' });
  const key = crypto.randomUUID();
  let t = null;
  const refresh = () => { clearTimeout(t); t = setTimeout(async () => {
    if (!f.start || !f.end) return preview.replaceChildren(h('p', { class: 'muted small' }, 'Pick dates to see working days and your projected balance.'));
    try {
      const p = await api('/api/leave/preview', { method: 'POST', body: clean(f) });
      preview.replaceChildren(h('div', { class: 'side' }, h('p', {}, h('strong', {}, `${p.chargeable} working day(s)`), p.approver ? ` · goes to ${p.approver}` : ''),
        p.projected ? h('p', { class: 'small' }, Object.entries(p.projected).map(([y, b]) => `${y}: ${b.before} → ${b.after} days`).join(' · ')) : null,
        h('details', {}, h('summary', {}, 'How the days were counted'), h('ul', { class: 'small' }, p.days.map((d) => h('li', {}, `${d.date}: ${d.note}${d.charge !== '0' ? ` (${d.charge})` : ''}`)))),
        p.blocking.length ? h('div', { class: 'alert error' }, h('strong', {}, 'Cannot submit yet'), h('ul', {}, p.blocking.map((b) => h('li', {}, b)))) : null,
        p.warnings.length ? h('div', { class: 'alert warn' }, h('ul', {}, p.warnings.map((b) => h('li', {}, b)))) : null,
        p.policy.status !== 'approved' ? h('p', { class: 'small muted' }, `Policy v${p.policy.version ?? '—'} is awaiting GB confirmation.`) : null));
    } catch (e) { preview.replaceChildren(errorBox(e)); }
  }, 300); };
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''));
  const inp = (k, attrs) => h('input', { id: `f_${k}`, ...attrs, oninput: (e) => { f[k] = e.target.value; refresh(); } });
  const portion = (k) => h('select', { id: `f_${k}`, onchange: (e) => { f[k] = e.target.value; refresh(); } }, [['full', 'Full day'], ['am', 'Morning'], ['pm', 'Afternoon']].map(([v, t]) => h('option', { value: v }, t)));
  const form = h('section', { class: 'card' }, h('h2', {}, 'New request'),
    h('div', { class: 'cols' },
      h('div', {}, h('label', { for: 'f_type' }, 'Request type'), h('select', { id: 'f_type', onchange: (e) => { f.typeCode = e.target.value; refresh(); } }, types.map((x) => h('option', { value: x.code }, x.name)))),
      h('div', {}, h('label', { for: 'f_start' }, 'First day'), inp('start', { type: 'date' })), h('div', {}, h('label', { for: 'f_startPortion' }, 'First day is'), portion('startPortion')),
      h('div', {}, h('label', { for: 'f_end' }, 'Last day'), inp('end', { type: 'date' })), h('div', {}, h('label', { for: 'f_endPortion' }, 'Last day is'), portion('endPortion'))),
    h('label', { for: 'f_coverUserId' }, 'Who covers your work? (required for annual leave)'), h('select', { id: 'f_coverUserId', onchange: (e) => { f.coverUserId = e.target.value; refresh(); } }, h('option', { value: '' }, '— choose a colleague —'), people.map((x) => h('option', { value: x.id }, x.name))),
    h('label', { for: 'f_handover' }, 'Handover notes'), inp('handover', {}),
    h('label', { for: 'f_reason' }, 'Reason (only you, your approver and People Ops see this; optional unless required)'), inp('reason', {}),
    h('label', { for: 'f_exceptionReason' }, 'Exception reason (short notice, retroactive, over quota)'), inp('exceptionReason', {}),
    preview,
    h('button', { class: 'btn primary mt', onclick: () => act(() => api('/api/leave/requests', { method: 'POST', body: { ...clean(f), clientKey: key } }), 'Request submitted').then(() => { location.hash = '#/'; }) }, 'Submit request'));
  refresh();
  const today = new Date().toISOString().slice(0, 10); const in60 = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  const cal = await api(`/api/leave/calendar?from=${today}&to=${in60}`);
  return h('div', {}, h('h1', {}, 'Time off and off-site work'), form,
    h('section', { class: 'card' }, h('h2', {}, 'My requests'), mine.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Type', 'Dates', 'Days', 'Status', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, mine.map((r) => h('tr', {}, h('td', {}, r.type.name), h('td', {}, `${fmtDate(r.start_date)}${r.end_date !== r.start_date ? ' → ' + fmtDate(r.end_date) : ''}`), h('td', {}, r.chargeable), h('td', {}, h('span', { class: `pill ${stateTone(r.state)}` }, r.state)),
        h('td', {}, ['submitted', 'approved'].includes(r.state) ? h('button', { class: 'btn small', onclick: () => act(() => api(`/api/leave/requests/${r.id}/cancel`, { method: 'POST', body: {} }), r.state === 'submitted' ? 'Withdrawn' : 'Cancelled').then(render) }, r.state === 'submitted' ? 'Withdraw' : 'Cancel') : null)))))) : h('p', { class: 'muted' }, 'No requests yet.')),
    h('section', { class: 'card' }, h('h2', {}, 'Team availability (next 60 days)'), cal.length ? h('ul', {}, cal.map((c) => h('li', {}, `${c.name}: ${c.availability} ${fmtDate(c.start_date)}${c.end_date !== c.start_date ? ' → ' + fmtDate(c.end_date) : ''}${c.half ? ' (part day)' : ''}${c.tentative ? ' · pending' : ''}`))) : h('p', { class: 'muted' }, 'Everyone is available.')));
}

async function requestPage(id) {
  const r = await api(`/api/leave/requests/${id}`);
  const note = h('input', { id: 'dn', placeholder: 'Note (required when declining)' });
  return h('div', {}, h('h1', {}, `${r.user.name} — ${r.type.name}`),
    h('section', { class: 'card' }, h('p', {}, `${fmtDate(r.start_date)} (${r.start_portion}) → ${fmtDate(r.end_date)} (${r.end_portion}) · `, h('strong', {}, `${r.chargeable} working day(s)`), ' · ', h('span', { class: `pill ${stateTone(r.state)}` }, r.state)),
      r.reason ? h('p', {}, `Reason: ${r.reason}`) : null, r.handover ? h('p', {}, `Handover: ${r.handover}`) : null,
      r.warnings.length ? h('div', { class: 'alert warn' }, h('ul', {}, r.warnings.map((w) => h('li', {}, w)))) : null,
      r.exception ? h('div', { class: 'alert warn' }, `Exception requested: ${r.exception.reason}`) : null,
      r.balances ? h('p', { class: 'small' }, r.balances.map((b) => `${b.name}: ${b.posted} (pending ${b.pending})`).join(' · ')) : null,
      h('details', {}, h('summary', {}, 'Day-by-day'), h('ul', { class: 'small' }, r.breakdown.days.map((d) => h('li', {}, `${d.date}: ${d.note}`)))),
      r.can_decide ? h('div', {}, h('label', { for: 'dn' }, 'Decision note'), note, h('div', { class: 'row mt' },
        h('button', { class: 'btn primary', onclick: () => act(() => api(`/api/leave/requests/${id}/decide`, { method: 'POST', body: { decision: 'approve', note: note.value, rowVersion: r.row_version, approveException: !!r.exception } }), 'Approved').then(() => { location.hash = '#/inbox'; }) }, r.exception ? 'Approve with exception' : 'Approve'),
        h('button', { class: 'btn danger', onclick: () => act(() => api(`/api/leave/requests/${id}/decide`, { method: 'POST', body: { decision: 'decline', note: note.value, rowVersion: r.row_version } }), 'Declined').then(() => { location.hash = '#/inbox'; }) }, 'Decline'))) : null));
}

// ------------------------------------------------------------- history --
async function history() {
  const plans = await api('/api/my/plans'); const cycles = await api('/api/cycles'); const templates = await api('/api/templates');
  const planning = cycles.filter((c) => c.status === 'planning' && !plans.find((p) => p.year === c.year));
  const tpl = h('select', { id: 'tpl' }, templates.map((t) => h('option', { value: t.id }, `${t.role_family} v${t.version}${t.status !== 'approved' ? ' (candidate)' : ''}`)));
  const prior = plans.find((p) => ['closed', 'acknowledged'].includes(p.state) && p.cycle_status !== 'historical');
  let carry = [];
  const carryBox = h('div', {});
  if (prior) {
    const pv = await api(`/api/plans/${prior.id}`);
    carryBox.append(h('p', { class: 'small' }, `Carry forward from ${pv.cycle.name} (targets and weights must be set afresh):`),
      ...pv.items.map((i) => h('label', { class: 'plain' }, h('input', { type: 'checkbox', class: 'inline-check', onchange: (e) => { carry = e.target.checked ? [...carry, i.id] : carry.filter((x) => x !== i.id); } }), ` ${i.title}`)));
  }
  return h('div', {}, h('h1', {}, 'My reviews'),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Cycle', 'Stage'].map((x) => h('th', {}, x)))), h('tbody', {}, plans.map((p) => h('tr', {}, h('td', {}, h('a', { href: `#/review/${p.id}` }, p.cycle)), h('td', {}, p.stateLabel)))))),
    planning.map((c) => h('section', { class: 'card' }, h('h2', {}, `Start your ${c.name}`), h('label', { for: 'tpl' }, 'Role template'), tpl, carryBox,
      h('button', { class: 'btn primary mt', onclick: () => act(() => api('/api/plans', { method: 'POST', body: { cycleId: c.id, templateId: tpl.value, carryItemIds: carry } })).then((p) => { location.hash = `#/review/${p.id}`; }) }, 'Create draft plan'))));
}

// ------------------------------------------------------------ projects --
async function projects() {
  const list = await api('/api/projects');
  return h('div', {}, h('h1', {}, 'Projects, proposals and initiatives'), h('p', { class: 'muted small' }, 'Provisional allocations and Drive activity are leads only. A project lead confirms who did what.'),
    list.length ? list.map((p) => h('section', { class: 'card' }, h('h2', {}, `${p.name} `, h('span', { class: 'pill' }, p.kind), ' ', h('span', { class: `pill ${p.register_status === 'approved' ? 'ok' : 'warn'}` }, p.register_status)),
      h('p', { class: 'small' }, `Lead: ${p.lead_name || '—'} · ${p.start_date || ''} → ${p.end_date || ''}`),
      h('p', { class: 'small' }, 'Confirmed team: ', p.team_confirmed.map((a) => `${a.name} (${a.role})`).join(', ') || '—'),
      p.team_unconfirmed.length ? h('div', { class: 'small' }, 'Awaiting lead confirmation: ', p.team_unconfirmed.map((a) => h('span', {}, `${a.name} (${a.role}, ${a.status}) `, p.is_lead ? h('button', { class: 'btn small', onclick: () => act(() => api(`/api/assignments/${a.id}/review`, { method: 'POST', body: { decision: 'confirm' } }), 'Confirmed').then(render) }, 'Confirm') : null, ' '))) : null,
      p.deliverables.map((d) => {
        const resp = h('select', { 'aria-label': 'My responsibility' }, ['lead', 'author', 'analyst', 'reviewer', 'support'].map((x) => h('option', { value: x }, x)));
        const desc = h('input', { 'aria-label': 'What I did', placeholder: 'What you did' }); const ev = h('input', { 'aria-label': 'Evidence link', type: 'url', placeholder: 'Drive link' });
        return h('div', { class: 'item' }, h('header', {}, h('strong', {}, `${d.title} ${d.version || ''}`), h('span', { class: 'small muted' }, [d.milestone, d.status, d.acceptance].filter(Boolean).join(' · '))),
          h('ul', { class: 'small' }, d.contributions.map((c) => h('li', {}, `${c.name} — ${c.responsibility}: ${c.description || ''} `, h('span', { class: `pill ${c.status === 'confirmed' ? 'ok' : c.status === 'rejected' ? 'danger' : 'warn'}` }, c.status),
            p.is_lead && c.status === 'claimed' && c.user_id !== ME.id ? [' ', h('button', { class: 'btn small', onclick: () => act(() => api(`/api/contributions/${c.id}/review`, { method: 'POST', body: { decision: 'confirm' } }), 'Confirmed').then(render) }, 'Confirm'), ' ',
              h('button', { class: 'btn small', onclick: () => act(() => api(`/api/contributions/${c.id}/review`, { method: 'POST', body: { decision: 'correct', note: prompt('What should it say?') } }), 'Corrected').then(render) }, 'Correct')] : null))),
          h('div', { class: 'row' }, resp, desc, ev, h('button', { class: 'btn', onclick: () => act(() => api(`/api/deliverables/${d.id}/contributions`, { method: 'POST', body: { responsibility: resp.value, description: desc.value, evidenceUrl: ev.value || null } }), 'Contribution claimed — the lead will confirm').then(render) }, 'Claim my contribution')));
      }))) : h('p', { class: 'muted' }, 'No projects visible to you.'));
}

// ------------------------------------------------------------------ AI --
async function myAi() {
  const [seats, ex] = await Promise.all([api('/api/ai/seats/mine'), api('/api/ai/examples/mine')]);
  const f = {}; const inp = (k, label, tag = 'input') => h('div', {}, h('label', { for: `ai_${k}` }, label), h(tag, { id: `ai_${k}`, oninput: (e) => { f[k] = e.target.value; } }));
  return h('div', {}, h('h1', {}, 'AI examples'), h('p', { class: 'muted' }, 'Share up to three examples where Claude or Gemini helped — or hit a meaningful limitation. Usage counts, cost and model choice never change ratings.'),
    seats.length ? h('section', { class: 'card' }, h('h2', {}, 'Shared-seat attribution to confirm'), h('p', { class: 'small muted' }, 'These are leads from chat titles and Drive activity. Please confirm only what you did.'),
      h('ul', {}, seats.map((s) => h('li', {}, `${s.seat_email} · ${s.engagement || '—'} · ${s.evidence_type} (${s.confidence}) `, h('span', { class: 'pill' }, s.status),
        s.status === 'candidate' ? [' ', h('button', { class: 'btn small', onclick: () => act(() => api(`/api/ai/seats/${s.id}/confirm`, { method: 'POST', body: { decision: 'confirm' } }), 'Confirmed').then(render) }, 'That was me'), ' ',
          h('button', { class: 'btn small', onclick: () => act(() => api(`/api/ai/seats/${s.id}/confirm`, { method: 'POST', body: { decision: 'reject' } }), 'Noted').then(render) }, 'Not me')] : null)))) : null,
    h('section', { class: 'card' }, h('h2', {}, 'Add an example'), inp('task', 'Task'), inp('tool', 'Tool and model'), inp('why', 'Why you chose it'), inp('contribution', 'What you contributed vs the tool', 'textarea'),
      inp('verification', 'How you verified the output (required)', 'textarea'), inp('riskHandling', 'Confidentiality / risk handling'), inp('outcome', 'Outcome'), inp('timeSavedEstimate', 'Estimated time saved (optional)'), inp('estimateBasis', 'Basis for the estimate'),
      h('button', { class: 'btn primary mt', onclick: () => act(() => api('/api/ai/examples', { method: 'POST', body: { ...f, submit: true } }), 'Example saved').then(render) }, 'Save example')),
    ex.length ? h('section', { class: 'card' }, h('h2', {}, 'My examples'), h('ul', {}, ex.map((e) => h('li', {}, `${e.task} — ${e.tool} (${e.status})`)))) : null);
}

// --------------------------------------------------------------- admin --
async function admin(tab = 'dashboard') {
  const tabs = [['dashboard', 'Completion'], ['roster', 'Roster'], ['imports', 'Import center'], ['policy', 'Policy settings'], ['reminders', 'Reminders'], ['ai', 'AI adoption'], ['audit', 'Audit log']];
  const body = await ({ dashboard: adminDashboard, roster: adminRoster, imports: adminImports, policy: adminPolicy, reminders: adminReminders, ai: adminAi, audit: adminAudit }[tab] || adminDashboard)();
  return h('div', {}, h('h1', {}, 'Administration'), h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, t]) => h('button', { role: 'tab', 'aria-selected': String(k === tab), onclick: () => { location.hash = `#/admin/${k}`; } }, t))), body);
}
async function adminDashboard() {
  const d = await api('/api/admin/dashboard');
  return h('div', {}, h('div', { class: 'grid' }, Object.entries(d.by_state).map(([s, n]) => h('div', { class: 'card' }, h('h2', {}, n), h('p', { class: 'muted' }, s.replace('_', ' '))))),
    d.needs_basis_decision ? h('div', { class: 'alert warn' }, `${d.needs_basis_decision} plan(s) have an unverified assessment basis.`) : null,
    d.without_plan.length ? h('div', { class: 'alert warn' }, `No plan yet: ${d.without_plan.map((u) => u.name).join(', ')}`) : null,
    h('p', { class: 'small muted' }, 'Completion only. Ratings are visible to assigned reviewers and partners, not to administrators.'),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Employee', 'Stage', 'Reviewer', 'Partner', 'Self submitted', 'Released', 'Acknowledged'].map((x) => h('th', {}, x)))),
      h('tbody', {}, d.rows.map((r) => h('tr', {}, h('td', {}, r.name), h('td', {}, r.stateLabel), h('td', {}, r.reviewer || '—'), h('td', {}, r.partner || '—'), h('td', {}, fmtDate(r.self_submitted_at)), h('td', {}, fmtDate(r.released_at)), h('td', {}, fmtDate(r.acknowledged_at))))))),
    h('button', { class: 'btn', onclick: () => act(() => api(`/api/cycles/${d.cycleId}/open-self`, { method: 'POST' }), 'Self-assessment opened').then(render) }, 'Open self-assessment for approved plans'));
}
async function adminRoster() {
  const rows = await api('/api/admin/roster');
  return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Title', 'Manager', 'Backup approver', 'Country', 'Probation ends', 'Roles'].map((x) => h('th', {}, x)))),
    h('tbody', {}, rows.map((u) => h('tr', {}, h('td', {}, u.name, u.synthetic ? h('span', { class: 'pill ml' }, 'synthetic') : null), h('td', {}, u.email), h('td', {}, u.title || '—'), h('td', {}, u.manager || '—'), h('td', {}, u.backup || '—'), h('td', {}, u.country || '—'), h('td', {}, u.probation_end || '—'), h('td', {}, u.roles.join(', ')))))));
}
async function adminImports() {
  const [batches, cycles] = await Promise.all([api('/api/imports'), api('/api/cycles')]);
  const out = h('div', {});
  const file = h('input', { type: 'file', accept: '.xlsx', id: 'impfile', multiple: true });
  const kind = h('select', { id: 'impkind' }, [['gb-forms', 'GB 2026 evaluation forms (select several)'], ['leaveboard', 'LeaveBoard export (General / Annual / Attendance / Leaves)'], ['pms-plans', 'PMS plans (one row per item)'], ['pms-history', 'PMS history team summary']].map(([v, t]) => h('option', { value: v }, t)));
  const cyc = h('select', { id: 'impcycle' }, cycles.map((c) => h('option', { value: c.id }, c.name)));
  const extra = h('input', { id: 'impextra', placeholder: 'LeaveBoard: reporting range e.g. 2026-01-01..2026-11-19 · History: year e.g. 2025' });
  const upload = async () => {
    const f = file.files[0]; if (!f) throw new Error('Choose a file');
    if (kind.value === 'gb-forms') {
      const files = await Promise.all([...file.files].map(async (x) => ({ filename: x.name, base64: await toBase64(x) })));
      return out.replaceChildren(batchView(await api('/api/imports/gb-forms', { method: 'POST', body: { cycleId: cyc.value, files } })));
    }
    const buf = await f.arrayBuffer(); const qs = new URLSearchParams({ filename: f.name });
    if (kind.value === 'pms-plans') qs.set('cycleId', cyc.value);
    if (kind.value === 'pms-history') qs.set('year', extra.value || '2025');
    if (kind.value === 'leaveboard' && extra.value.includes('..')) { const [a, b] = extra.value.split('..'); qs.set('from', a); qs.set('to', b); }
    const b = await api(`/api/imports/${kind.value}?${qs}`, { method: 'POST', raw: buf });
    out.replaceChildren(batchView(b));
  };
  return h('div', {}, h('section', { class: 'card' }, h('h2', {}, 'Upload a reviewed export'), h('p', { class: 'small muted' }, 'Selected files only — no broad Drive access. Payroll and personal columns are excluded automatically. Nothing is written until you apply the previewed batch.'),
    h('div', { class: 'cols' }, h('div', {}, h('label', { for: 'impkind' }, 'Source'), kind), h('div', {}, h('label', { for: 'impcycle' }, 'Target cycle (plans)'), cyc), h('div', {}, h('label', { for: 'impextra' }, 'Range / year'), extra), h('div', {}, h('label', { for: 'impfile' }, 'File'), file)),
    h('button', { class: 'btn primary mt', onclick: () => act(upload) }, 'Preview')), out,
    h('section', { class: 'card' }, h('h2', {}, 'Batches'), h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['File', 'Kind', 'Status', 'Range', 'Created'].map((x) => h('th', {}, x)))),
      h('tbody', {}, batches.map((b) => h('tr', {}, h('td', {}, h('a', { href: '#', onclick: async (e) => { e.preventDefault(); out.replaceChildren(batchView(await api(`/api/imports/${b.id}`))); } }, b.filename)), h('td', {}, b.kind), h('td', {}, b.status), h('td', {}, b.reporting_from ? `${b.reporting_from} → ${b.reporting_to}` : '—'), h('td', {}, fmtDate(b.created_at)))))))));
}
function batchView(b) {
  const s = b.summary;
  const cutover = h('input', { type: 'date', id: 'cutover', 'aria-label': 'Cutover date' });
  return h('section', { class: 'card' }, h('h2', {}, `${b.filename} — ${b.kind}`), b.duplicateOf ? h('div', { class: 'alert ok' }, 'This exact file was uploaded before; showing the existing batch.') : null,
    h('p', { class: 'small' }, `Status: ${b.status}${b.generated_at ? ` · generated ${b.generated_at}` : ''}${b.reporting_from ? ` · range ${b.reporting_from} → ${b.reporting_to}` : ''}`),
    s.blocking?.length ? h('div', { class: 'alert error' }, h('strong', {}, 'Blocking'), h('ul', {}, s.blocking.map((x) => h('li', {}, x)))) : null,
    s.warnings?.length ? h('div', { class: 'alert warn' }, h('ul', {}, s.warnings.map((x) => h('li', {}, x)))) : null,
    s.excluded_columns?.length ? h('p', { class: 'small' }, `Excluded columns (never read): ${s.excluded_columns.join(', ')}`) : null,
    s.plans && b.kind === 'pms_gb_form' ? s.plans.map((p) => h('div', { class: 'item' }, h('header', {}, h('strong', {}, `${p.person} — ${p.position}`), h('span', { class: 'small muted' }, `${p.file} · ${p.items} items · ${p.match_status}`)),
      h('p', { class: 'small' }, 'Weights: ', Object.entries(p.category_weights).map(([c, w]) => `${c} ${w}%`).join(' · ')),
      [...p.blocking, ...p.issues, ...p.weight_errors].length ? h('ul', { class: 'small' }, [...p.blocking, ...p.issues, ...p.weight_errors].map((x) => h('li', {}, x))) : null,
      p.formula_issues.length ? h('details', { class: 'small' }, h('summary', {}, `${p.formula_issues.length} spreadsheet formula problem(s) — Prism recalculates instead`), h('ul', {}, p.formula_issues.map((x) => h('li', {}, x)))) : null)) : null,
    s.checksum ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Column', 'Rows sum', 'Totals row', ''].map((x) => h('th', {}, x)))), h('tbody', {}, Object.entries(s.checksum).map(([k, c]) => h('tr', {}, h('td', {}, k), h('td', {}, c.rows), h('td', {}, c.source_total), h('td', {}, h('span', { class: `pill ${c.ok ? 'ok' : 'danger'}` }, c.ok ? 'reconciled' : 'mismatch'))))))) : null,
    s.totals ? h('pre', { class: 'math' }, JSON.stringify(s.totals, null, 1)) : null,
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Row', 'Key', 'Match', 'Action', 'Issues'].map((x) => h('th', {}, x)))),
      h('tbody', {}, b.rows.map((r) => h('tr', {}, h('td', {}, r.row_no), h('td', {}, r.source_key), h('td', {}, r.match_status), h('td', {}, h('span', { class: `pill ${r.action === 'reject' ? 'danger' : r.action === 'review' ? 'warn' : 'ok'}` }, r.action)), h('td', { class: 'small' }, r.issues.join('; '))))))),
    b.status === 'previewed' ? h('button', { class: 'btn primary mt', onclick: () => act(() => api(`/api/imports/${b.id}/apply`, { method: 'POST', body: {} }), 'Batch applied').then(render) }, 'Apply reviewed batch') : null,
    b.status === 'applied' && b.kind === 'leaveboard_annual_situation' ? h('div', { class: 'row' }, cutover, h('button', { class: 'btn', onclick: () => act(() => api(`/api/imports/${b.id}/opening-balances`, { method: 'POST', body: { cutover: cutover.value } }), 'Opening balances posted') }, 'Post opening balances at cutover'),
      h('button', { class: 'btn', onclick: async () => { const r = await api(`/api/imports/${b.id}/reconcile`); $('#main').append(h('section', { class: 'card' }, h('h2', {}, 'Reconciliation'), h('pre', { class: 'math' }, r.map((x) => `${x.vendor_name} · ${x.category}: ${x.status}${x.difference ? ` (Δ ${x.difference})` : ''}`).join('\n')))); } }, 'Reconcile')) : null,
    b.status === 'applied' ? h('button', { class: 'btn danger', onclick: () => act(() => api(`/api/imports/${b.id}/reverse`, { method: 'POST', body: { reason: prompt('Reason for reversing this batch (audited):') } }), 'Batch reversed').then(render) }, 'Reverse batch') : null);
}
async function adminPolicy() {
  const pols = await api('/api/admin/policy');
  return h('div', {}, pols.map((p) => h('section', { class: 'card' }, h('h2', {}, `Policy v${p.version} `, h('span', { class: `pill ${p.status === 'approved' ? 'ok' : 'warn'}` }, p.status)), h('p', { class: 'small' }, `Effective ${p.effective_from}${p.effective_to ? ' → ' + p.effective_to : ''}. ${p.note || ''}`),
    h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, Object.entries(p.settings).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, JSON.stringify(v))))))),
    p.status !== 'approved' ? h('button', { class: 'btn primary', onclick: () => act(() => api(`/api/admin/policy/${p.version}/approve`, { method: 'POST', body: { note: prompt('Who at GB approved this, and where is the record?') } }), 'Policy approved').then(render) }, 'Record GB approval') : null)));
}
async function adminReminders() {
  const cycles = await api('/api/cycles'); const cyc = h('select', { 'aria-label': 'Cycle' }, cycles.map((c) => h('option', { value: c.id }, c.name)));
  const asOf = h('input', { type: 'date', 'aria-label': 'As of' }); const out = h('div', {});
  const ob = await api('/api/notifications/outbox');
  return h('div', {}, h('section', { class: 'card' }, h('h2', {}, 'Plan reminders'), h('p', { class: 'small muted' }, 'Cadence: launch, 3 business days before the due date, then 1 business day after if outstanding (Amman time). Test mode sends everything to the test inbox.'),
    h('div', { class: 'row' }, cyc, asOf, h('button', { class: 'btn', onclick: () => act(async () => { const p = await api(`/api/notifications/plan?cycleId=${cyc.value}${asOf.value ? '&asOf=' + asOf.value : ''}`); out.replaceChildren(h('p', {}, `Mode: ${p.mode} · ${p.items.length} new · ${p.already_sent_or_queued} already queued/sent`), h('ul', { class: 'small' }, p.items.map((i) => h('li', {}, `${i.event} → ${i.to_email}: ${i.subject}`)))); }) }, 'Preview recipients'),
      h('button', { class: 'btn primary', onclick: () => act(() => api('/api/notifications/queue', { method: 'POST', body: { cycleId: cyc.value, asOf: asOf.value || undefined } }), 'Queued').then(render) }, 'Queue'),
      h('button', { class: 'btn', onclick: () => act(() => api('/api/notifications/deliver', { method: 'POST' }), 'Delivery run complete').then(render) }, 'Deliver now')), out),
    h('section', { class: 'card' }, h('h2', {}, 'Outbox'), h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Event', 'To', 'Subject', 'Status', 'Attempts', 'Error'].map((x) => h('th', {}, x)))),
      h('tbody', {}, ob.map((n) => h('tr', {}, h('td', {}, n.event), h('td', {}, n.to_email), h('td', {}, n.subject), h('td', {}, n.status), h('td', {}, n.attempts), h('td', { class: 'small' }, n.last_error || ''))))))));
}
async function adminAi() {
  const rows = await api('/api/ai/adoption');
  return h('div', {}, h('p', { class: 'muted small' }, 'Adoption and enablement only — separate from performance evidence. Compare within the same tool and window.'),
    rows.length ? rows.map((r) => h('section', { class: 'card' }, h('h2', {}, `${r.export.tool} · ${r.export.report}`), h('p', { class: 'small' }, `${r.export.window_from} → ${r.export.window_to} · ${r.denominators.accounts} accounts (${r.denominators.licensed} licensed)`),
      h('p', {}, Object.entries(r.accounts_by_state).map(([k, v]) => `${k.replace('_', ' ')}: ${v}`).join(' · ')), r.unmatched_accounts.length ? h('p', { class: 'small' }, `Unmatched accounts: ${r.unmatched_accounts.join(', ')}`) : null,
      h('ul', { class: 'small' }, r.caveats.map((c) => h('li', {}, c))))) : h('p', { class: 'muted' }, 'No usage exports imported yet.'));
}
async function adminAudit() {
  const rows = await api('/api/admin/audit');
  return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Who', 'Action', 'Record', 'Reason'].map((x) => h('th', {}, x)))),
    h('tbody', {}, rows.map((a) => h('tr', {}, h('td', {}, new Date(a.at).toLocaleString()), h('td', {}, a.actor || '—'), h('td', {}, a.action), h('td', {}, `${a.entity} ${a.entity_id || ''}`), h('td', {}, a.reason || ''))))));
}

boot();
