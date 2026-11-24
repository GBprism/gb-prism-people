// GB Prism People & Performance — client. Plain ES modules, no build step.
// All DOM is created with h() (textContent), never innerHTML with data.
import { mountShell, pageFor } from '/shell.js';
import { pageHeader, emptyState, skeletonLines, button as uiButton } from '/ui.js';
import { importsScreen } from '/screens/imports.js';
import { homeScreen } from '/screens/home.js';
import { signInScreen } from '/screens/signin.js';
import { myProfileScreen, peopleScreen } from '/screens/people.js';
import { timeoffScreen, requestScreen } from '/screens/timeoff.js';
import { inboxScreen } from '/screens/inbox.js';
import { projectsScreen } from '/screens/projects.js';
import { historyScreen } from '/screens/history.js';
import { reviewScreen } from '/screens/review.js';

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
  [/^#\/?$/, home], [/^#\/inbox$/, () => inboxScreen({ api })], [/^#\/review\/(.+)$/, (id) => reviewScreen({ api, id })], [/^#\/timeoff$/, () => timeoffScreen({ api })], [/^#\/request\/(.+)$/, (id) => requestScreen({ api, id })],
  [/^#\/history$/, () => historyScreen({ api })], [/^#\/projects(?:\?(.*))?$/, (query) => projectsScreen({ api, me: ME, query })], [/^#\/admin(?:\/(\w+))?$/, admin], [/^#\/ai$/, myAi],
  [/^#\/profile$/, () => myProfileScreen({ api })], [/^#\/people$/, () => peopleScreen({ api })],
];
let SHELL = null;
async function boot() {
  try { ME = await api('/api/me'); } catch (e) { if (e.status === 401) return login(); throw e; }
  SHELL = mountShell({ me: ME, api, onSignOut: async () => { await api('/api/logout', { method: 'POST' }); location.hash = '#/'; location.reload(); } });
  window.addEventListener('hashchange', render);
  render();
}
async function render() {
  const hash = location.hash || '#/';
  const page = pageFor(hash);
  SHELL.setPage(hash);
  const banner = SHELL.banner; banner.replaceChildren();
  const main = SHELL.main;
  const container = h('div', { class: 'page legacy' }, banner, skeletonLines(5));
  main.replaceChildren(container);
  for (const [re, fn] of routes) {
    const m = re.exec(hash);
    if (!m) continue;
    let node;
    try { node = await fn(...m.slice(1)); } catch (e) { node = errorBox(e); }
    // standard page template: icon + title + one-line description; the screen's own h1 supplies the title text
    const h1 = node.querySelector?.('h1');
    const titleText = h1?.textContent?.trim();
    const header = pageHeader({ iconName: page.icon, title: titleText || page.title, description: page.desc, actions: node.pageActions || [] });
    if (!node.modern) { if (h1) h1.replaceWith(header); else node.prepend?.(header); }
    if (page.parent && titleText) SHELL.setPage(hash, titleText);
    container.className = node.modern ? 'page' : 'page legacy';
    if (node.modern) container.replaceChildren(...(node.noHeader ? [banner, node] : [header, banner, node])); else container.replaceChildren(banner, node);
    main.focus({ preventScroll: true });
    SHELL.refreshInbox();
    return;
  }
  container.replaceChildren(banner, emptyState({ iconName: 'circle-help', title: 'Page not found', text: 'The link may be out of date.', action: uiButton('Go to Home', { variant: 'primary', iconName: 'house', href: '#/' }) }));
}
async function login() { document.body.replaceChildren(await signInScreen({ api })); }

// ---------------------------------------------------------------- home --
function home() { return homeScreen({ api, me: ME }); }

// ------------------------------------------------------------ time off --
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
  // sub-pages are listed in the sidebar (Admin group); the page header comes from the shell
  return await ({ dashboard: adminDashboard, roster: adminRoster, imports: adminImports, policy: adminPolicy, reminders: adminReminders, ai: adminAi, audit: adminAudit }[tab] || adminDashboard)();
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
function adminImports() { return importsScreen({ api, toBase64, render }); }
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
