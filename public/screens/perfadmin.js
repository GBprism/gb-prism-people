// Founders / admin: performance setup, calibration and confirmation, promotions, compensation (restricted),
// and the 2025 history import.
import { h, icon, button, badge, card, banner, emptyState, field, input, select, textarea, toast, openDrawer, promptModal, dataTable } from '/ui.js';

const fmt = (s) => (s ? new Date(s.length > 10 ? s : `${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const refresh = () => dispatchEvent(new HashChangeEvent('hashchange'));
const act = (fn, ok) => async () => { try { await fn(); if (ok) toast(ok); refresh(); } catch (e) { toast(e.message, 'danger'); } };
const STATE = { goals: 'Priorities', in_year: 'In year', reflection: 'Reflection', manager: 'Manager', calibration: 'Calibration', approval: 'Founders confirming', released: 'Released', acknowledged: 'Acknowledged', correction: 'Correction', closed: 'Closed' };

// --------------------------------------------------------------- setup --
export async function perfSetupScreen({ api }) {
  const v = await api('/api/performance/admin');
  const p = v.policy; const pol = p.policy;
  const w = Object.fromEntries(pol.dimensions.map((d) => [d.key, input({ type: 'number', min: 1, max: 100, value: d.weight, 'aria-label': `${d.label} weight` })]));
  const minScore = input({ id: 'ps-min', type: 'number', step: '0.01', value: (pol.promotion.min_score_points / 100).toFixed(2) });
  const minDim = input({ id: 'ps-dim', type: 'number', min: 1, max: 5, value: pol.promotion.min_dimension });
  const months = input({ id: 'ps-m', type: 'number', min: 0, value: pol.promotion.next_level_months });
  const tig = input({ id: 'ps-tig', type: 'number', min: 0, value: pol.promotion.min_months_in_grade ?? '', placeholder: 'Not set' });
  const guide = input({ id: 'ps-bg', type: 'number', step: '0.5', min: 0, value: pol.compensation.bonus_guidance_months ?? '', placeholder: 'Not set' });
  const rel = h('input', { type: 'checkbox', id: 'ps-rel', checked: !!pol.compensation.employee_release });
  const save = act(() => api('/api/performance/policy', { method: 'POST', body: { policy: { ...pol, dimensions: pol.dimensions.map((d) => ({ ...d, weight: Number(w[d.key].value) })),
    promotion: { ...pol.promotion, min_score_points: Math.round(Number(minScore.value) * 100), min_dimension: Number(minDim.value), next_level_months: Number(months.value), min_months_in_grade: tig.value === '' ? null : Number(tig.value) },
    compensation: { ...pol.compensation, bonus_guidance_months: guide.value === '' ? null : Number(guide.value), employee_release: rel.checked } } } }), 'Draft saved — both founders approve it');
  const approvedBy = p.approvals.map((a) => a.name).join(', ');
  const yr = input({ id: 'cy-y', type: 'number', value: new Date().getFullYear() + 1 }); const rd = input({ id: 'cy-r', type: 'date' }); const md = input({ id: 'cy-m', type: 'date' }); const cd = input({ id: 'cy-c', type: 'date' });
  const root = h('div', { class: 'stack' },
    banner({ tone: 'info', title: 'How it works', text: 'Priorities at the start → assignment kickoffs and short project snapshots through the year → coaching in March, June (career) and September → one reflection, manager ratings, founder calibration → both founders confirm → released privately. 2025 and 2026 results stay on their original scale.' }),
    card({ title: `Policy v${p.version} — ${p.status === 'approved' ? 'approved' : 'draft'}`, iconName: 'scale', actions: p.status === 'draft' && v.founder ? button('Approve this policy', { variant: 'primary', iconName: 'check', onClick: act(() => api('/api/performance/policy/approve', { method: 'POST' }), 'Approved') }) : null,
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted' }, p.status === 'draft' ? `Needs approval from every founder (${p.founders.map((f) => f.name).join(' and ')}). ${approvedBy ? `Approved so far by ${approvedBy}.` : ''}` : `Approved by ${approvedBy || 'the founders'}.`),
        h('table', { class: 'data compact' }, h('thead', {}, h('tr', {}, h('th', {}, 'Dimension'), h('th', { class: 'num' }, 'Weight %'), h('th', {}, 'Observable examples'))),
          h('tbody', {}, pol.dimensions.map((d) => h('tr', {}, h('td', {}, d.label), h('td', { class: 'num' }, w[d.key]), h('td', { class: 'muted small' }, d.examples))))),
        h('p', { class: 'muted small' }, `Scale 1–5 (whole numbers). Bands: ${pol.bands.map((b) => `${(b.min / 100).toFixed(2)}+ ${b.label}`).join(' · ')}. Example: 4, 4, 3, 3 = 3.65.`),
        h('div', { class: 'form-grid' }, field({ label: 'Promotion: minimum annual score', id: 'ps-min', control: minScore }), field({ label: 'No dimension below', id: 'ps-dim', control: minDim }),
          field({ label: 'Months of next-level responsibility', id: 'ps-m', control: months }), field({ label: 'Minimum months in grade', id: 'ps-tig', control: tig, help: 'Leave empty until the founders decide' }),
          field({ label: 'Bonus guidance (months of salary)', id: 'ps-bg', control: guide, help: 'Used to flag proposals above it' })),
        h('label', { class: 'check-row' }, rel, 'Show approved compensation to each employee in GB People (private, after release)'),
        button('Save as draft', { iconName: 'check', onClick: save })) }),
    card({ title: 'Cycles', iconName: 'calendar-days', body: h('div', { class: 'stack' },
      ...v.cycles.map((c) => h('div', { class: 'cycle-row' }, h('div', {}, h('strong', {}, c.name), h('div', { class: 'muted' }, Object.entries(c.counts).map(([s, n]) => `${STATE[s] || s}: ${n}`).join(' · '))),
        h('div', { class: 'row' }, c.status === 'goals' || c.status === 'in_year' ? button('Open annual reviews', { size: 'sm', onClick: act(() => api(`/api/performance/cycles/${c.id}/stage`, { method: 'POST', body: { stage: 'annual' } }), 'Reflections opened') }) : null,
          c.status === 'annual' ? button('Close the cycle', { size: 'sm', onClick: act(() => api(`/api/performance/cycles/${c.id}/stage`, { method: 'POST', body: { stage: 'closed' } }), 'Closed') }) : null, badge(c.status, 'neutral')))),
      h('h3', { class: 'kv-head' }, 'Start a cycle'), h('div', { class: 'form-grid' }, field({ label: 'Year', id: 'cy-y', control: yr }), field({ label: 'Reflections due', id: 'cy-r', control: rd }), field({ label: 'Manager ratings due', id: 'cy-m', control: md }), field({ label: 'Calibration due', id: 'cy-c', control: cd })),
      h('p', { class: 'muted small' }, 'Everyone active except the founders takes part, with their current line manager as review manager. The approved policy is frozen for the cycle.'),
      button('Start the cycle', { variant: 'primary', iconName: 'send', onClick: act(() => api('/api/performance/cycles', { method: 'POST', body: { year: Number(yr.value), dates: { reflection_due: rd.value || null, manager_due: md.value || null, calibration_due: cd.value || null } } }), 'Cycle started — everyone was asked to set priorities') })) }));
  root.modern = true;
  return root;
}

// --------------------------------------------------------- calibration --
export async function calibrationScreen({ api }) {
  const v = await api('/api/performance/admin');
  const c = v.cycles.find((x) => x.status !== 'closed') || v.cycles[0];
  const root = h('div', { class: 'stack' });
  if (!c) { root.append(emptyState({ iconName: 'scale', title: 'No cycle yet', text: 'Start one in Performance setup.' })); root.modern = true; return root; }
  if (!v.founder) { root.append(banner({ tone: 'info', title: 'Founders only', text: 'Ratings are visible to the founders. You see progress.' })); }
  const dims = c.dimensions;
  root.append(card({ title: `${c.name} — side by side`, iconName: 'scale', flush: true, body: h('div', { class: 'table-wrap' }, h('table', { class: 'data compact calib' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Person'), h('th', {}, 'Stage'), ...(v.founder ? [...dims.map((d) => h('th', { class: 'num', title: d.label }, `${d.label.split(' ')[0]} ${d.weight}%`)), h('th', { class: 'num' }, 'Score'), h('th', {}, 'Band'), h('th', {}, 'Confirmed by')] : []))),
    h('tbody', {}, c.rows.map((r) => h('tr', {}, h('td', {}, h('a', { href: `#/performance/review/${r.review_id}` }, r.name), h('div', { class: 'muted small' }, r.title)), h('td', {}, STATE[r.state] || r.state),
      ...(v.founder ? [...dims.map((d) => { const x = r.ratings[d.key]; return h('td', { class: 'num' }, !x ? '—' : x.na ? (x.na_ok ? 'N/A' : 'N/A?') : x.insufficient ? 'insuff.' : x.final != null && x.final !== x.proposed ? `${x.proposed} → ${x.final}` : String(x.proposed ?? '—')); }),
        h('td', { class: 'num' }, r.score || '—'), h('td', {}, r.band || (r.outcome === 'insufficient' ? 'No score' : '—')),
        h('td', {}, r.approvals?.needed.map((a) => h('span', { class: `chip-kind ${a.approved_at ? 'kind-holiday' : 'kind-leave'}`, title: a.approved_at ? `Confirmed ${fmt(a.approved_at)}` : 'Not yet' }, `${a.approved_at ? '✓' : '·'} ${a.name.split(' ')[0]}`)))] : [])))))) }));
  root.append(h('p', { class: 'muted' }, 'Ratings are criterion-based — no forced distribution. A result reaches the employee only after every founder confirms the same version and one of them releases it.'));
  root.modern = true;
  return root;
}

// ----------------------------------------------------------- promotions --
const READY = { pending: ['Evidence pending', 'neutral'], ready: ['Ready', 'success'], development: ['Development needed', 'warning'], deferred: ['Deferred — business reasons', 'neutral'], approved: ['Approved', 'success'] };
const GATE = { pass: 'circle-check', fail: 'circle-x', pending: 'clock', not_set: 'info' };
export async function promotionsScreen({ api }) {
  const [v, people] = await Promise.all([api('/api/promotions'), api('/api/people').catch(() => [])]);
  function edit(c = {}) {
    const who = select([['', 'Person…'], ...people.map((p) => [p.id, p.name])], { id: 'pm-u', disabled: c.id ? true : null }); who.value = c.user_id || '';
    const kind = select([['title', 'Title change'], ['grade', 'Grade movement within the title'], ['probation', 'Probation confirmation']], { id: 'pm-k' }); kind.value = c.outcome_kind || 'title';
    const f = (id, label, val, opts = {}) => { const el = opts.area ? textarea({ id, rows: 2 }, val || '') : input({ id, value: val ?? '', type: opts.type || 'text' }); return [el, field({ label, id, control: el, help: opts.help })]; };
    const [tt, tF] = f('pm-t', 'Target role', c.target_title); const [tr, trF] = f('pm-tr', 'Track (if any)', c.target_track); const [rs, rsF] = f('pm-r', 'Next-level responsibilities', c.responsibilities, { area: true });
    const [ev, evF] = f('pm-e', 'Goal and evidence links', c.evidence_links, { area: true }); const [sf, sfF] = f('pm-sf', 'Sustained scope from', c.scope_from, { type: 'date' }); const [stt, stF] = f('pm-st', 'to', c.scope_to, { type: 'date' });
    const [ob, obF] = f('pm-o', 'Independent observations', c.observations, { area: true }); const [ec, ecF] = f('pm-ec', 'Economic justification', c.economic, { area: true });
    const band = select([['', 'Not recorded'], ['1', 'Within band'], ['0', 'Outside band']], { id: 'pm-b' }); band.value = c.pay_within_band == null ? '' : String(c.pay_within_band);
    const [px, pxF] = f('pm-px', 'Authorised exception (if outside band)', c.pay_exception); const [mg, mgF] = f('pm-mg', 'Months in current grade', c.months_in_grade, { type: 'number' });
    const [oa, oaF] = f('pm-oa', 'If no chance yet: concrete assignment', c.opportunity_assignment); const sp = select([['', 'Sponsor…'], ...people.map((p) => [p.id, p.name])], { id: 'pm-sp' }); sp.value = c.sponsor_id || ''; const [ro, roF] = f('pm-ro', 'Review date', c.review_on, { type: 'date' });
    openDrawer({ title: c.id ? `Promotion case — ${c.person}` : 'New promotion case', iconName: 'award', body: h('div', { class: 'stack' },
      field({ label: 'Person', id: 'pm-u', control: who }), field({ label: 'Outcome', id: 'pm-k', control: kind }), tF, trF, rsF, evF, h('div', { class: 'form-grid' }, sfF, stF, mgF), obF, ecF, field({ label: 'Pay after promotion', id: 'pm-b', control: band }), pxF, oaF, field({ label: 'Sponsor', id: 'pm-sp', control: sp }), roF),
    footer: (close) => button('Save case', { variant: 'primary', iconName: 'check', onClick: async () => {
      const body = { user_id: who.value, outcome_kind: kind.value, target_title: tt.value, target_track: tr.value, responsibilities: rs.value, evidence_links: ev.value, scope_from: sf.value || null, scope_to: stt.value || null, observations: ob.value, economic: ec.value,
        pay_within_band: band.value === '' ? null : band.value === '1', pay_exception: px.value, months_in_grade: mg.value === '' ? null : Number(mg.value), opportunity_assignment: oa.value, sponsor_id: sp.value || null, review_on: ro.value || null };
      try { await api(c.id ? `/api/promotions/${c.id}` : '/api/promotions', { method: c.id ? 'PATCH' : 'POST', body }); close(); toast('Saved'); refresh(); } catch (e) { toast(e.message, 'danger'); } } }) });
  }
  const root = h('div', { class: 'stack' },
    banner({ tone: 'info', title: 'A score makes someone eligible for consideration — it never changes a role', text: 'Performance eligibility, next-level readiness and the founders’ approval are separate. Title change, grade movement and probation confirmation are distinct outcomes. An approved case is a decision record; update the roster deliberately.' }),
    h('div', { class: 'toolbar' }, button('New promotion case', { variant: 'primary', iconName: 'plus', onClick: () => edit() })),
    ...(v.cases.length ? v.cases.map((c) => card({ title: `${c.person} → ${c.target_title || '—'}`, iconName: 'award', actions: badge(...READY[c.readiness]),
      body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, `${{ title: 'Title change', grade: 'Grade movement', probation: 'Probation confirmation' }[c.outcome_kind]} · latest score ${c.score || 'none released'}${c.scope_months != null ? ` · ${c.scope_months} months of next-level scope` : ''}`),
        h('ul', { class: 'gate-list' }, c.eligibility.gates.map((g) => h('li', { class: `gate-${g.state}` }, icon(GATE[g.state]), h('strong', {}, g.label), g.why ? h('span', { class: 'muted' }, ` — ${g.why}`) : null))),
        c.readiness_rationale ? h('p', {}, h('strong', {}, 'Readiness: '), c.readiness_rationale) : null,
        c.readiness === 'approved' ? h('p', { class: 'callout' }, `Approved by ${c.approved_by_name}: ${c.approved_title}, effective ${fmt(c.effective_on)}. ${c.approved_scope || ''}${c.override ? ` Override — ${c.override.clause}: ${c.override.reason} (review ${fmt(c.override.review_on)})` : ''}`) : h('div', { class: 'row' },
          button('Edit', { size: 'sm', iconName: 'pencil', onClick: () => edit(c) }),
          ...['ready', 'development', 'deferred'].map((k) => button(READY[k][0], { size: 'sm', variant: 'ghost', onClick: async () => { const why = await promptModal({ title: READY[k][0], label: 'Rationale' }); if (why) act(() => api(`/api/promotions/${c.id}/readiness`, { method: 'POST', body: { readiness: k, rationale: why } }), 'Recorded')(); } })),
          v.founder && c.readiness === 'ready' ? button('Approve role, scope and date', { size: 'sm', variant: 'primary', onClick: () => {
            const t = input({ id: 'ap-t', value: c.target_title || '' }); const sc = textarea({ id: 'ap-s', rows: 2 }, c.responsibilities || ''); const ef = input({ id: 'ap-e', type: 'date' });
            const cl = input({ id: 'ap-c', placeholder: 'Only if a gate failed' }); const rsn = input({ id: 'ap-r' }); const rv = input({ id: 'ap-rv', type: 'date' });
            openDrawer({ title: `Approve — ${c.person}`, iconName: 'check', body: h('div', { class: 'stack' }, field({ label: 'Role', id: 'ap-t', control: t }), field({ label: 'Scope', id: 'ap-s', control: sc }), field({ label: 'Effective date', id: 'ap-e', control: ef }),
              c.eligibility.eligible ? null : banner({ tone: 'warning', title: 'Override needed', text: c.eligibility.blocking.join('; ') || 'Evidence pending' }), c.eligibility.eligible ? null : h('div', { class: 'form-grid' }, field({ label: 'Policy clause', id: 'ap-c', control: cl }), field({ label: 'Reason', id: 'ap-r', control: rsn }), field({ label: 'Review date', id: 'ap-rv', control: rv }))),
            footer: (close) => button('Approve', { variant: 'primary', iconName: 'check', onClick: async () => { try { await api(`/api/promotions/${c.id}/approve`, { method: 'POST', body: { approved_title: t.value, approved_scope: sc.value, effective_on: ef.value, override: c.eligibility.eligible ? null : { clause: cl.value, reason: rsn.value, review_on: rv.value } } }); close(); toast('Approved'); refresh(); } catch (e) { toast(e.message, 'danger'); } } }) });
          } }) : null)) }))
      : [emptyState({ iconName: 'award', title: 'No promotion cases', text: 'Open a case for someone being considered for a title change, a grade movement or probation confirmation.' })]));
  root.modern = true;
  return root;
}

// --------------------------------------------------------- compensation --
export async function compensationScreen({ api, me }) {
  const [v, people] = await Promise.all([api('/api/compensation'), api('/api/people').catch(() => [])]);
  const everyone = [{ id: me.id, name: me.name }, ...people];
  function propose() {
    const who = select([['', 'Person…'], ...everyone.map((p) => [p.id, p.name])], { id: 'cp-u' }); const yr = input({ id: 'cp-y', type: 'number', value: new Date().getFullYear() + 1 });
    const pr = input({ id: 'cp-p', type: 'number', step: '0.001' }); const np = input({ id: 'cp-n', type: 'number', step: '0.001' });
    const bt = select([['none', 'No bonus'], ['months', 'Months of salary'], ['fixed', 'Fixed amount']], { id: 'cp-bt' }); const bm = input({ id: 'cp-bm', type: 'number', step: '0.5' }); const ba = input({ id: 'cp-ba', type: 'number' });
    const bb = select([['new', 'New salary'], ['prior', 'Previous salary']], { id: 'cp-bb' }); const ef = input({ id: 'cp-e', placeholder: 'yyyy-mm' }); const bp = input({ id: 'cp-bp', placeholder: v.bands_configured ? 'e.g. mid-band' : 'Bands not configured' }); const nt = textarea({ id: 'cp-nt', rows: 2 });
    openDrawer({ title: 'Compensation proposal', iconName: 'calculator', body: h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field({ label: 'Person', id: 'cp-u', control: who }), field({ label: 'Year', id: 'cp-y', control: yr }), field({ label: 'Current monthly salary (JOD)', id: 'cp-p', control: pr }), field({ label: 'Proposed monthly salary (JOD)', id: 'cp-n', control: np }),
      field({ label: 'Bonus', id: 'cp-bt', control: bt }), field({ label: 'Bonus months', id: 'cp-bm', control: bm }), field({ label: 'Bonus amount (JOD)', id: 'cp-ba', control: ba }), field({ label: 'Bonus basis', id: 'cp-bb', control: bb }), field({ label: 'Effective', id: 'cp-e', control: ef }), field({ label: 'Band position', id: 'cp-bp', control: bp })), field({ label: 'Note', id: 'cp-nt', control: nt }),
      h('p', { class: 'muted small' }, 'Salary, bonus and promotion are decided independently. Nothing here changes payroll or sends an email.')),
    footer: (close) => button('Save proposal', { variant: 'primary', iconName: 'check', onClick: async () => { try { await api('/api/compensation', { method: 'POST', body: { user_id: who.value, year: Number(yr.value), prior: pr.value, proposed: np.value, bonus_type: bt.value, bonus_months: bm.value, bonus_amount: ba.value, bonus_basis: bb.value, effective: ef.value || null, band_position: bp.value, note: nt.value } }); close(); toast('Saved'); refresh(); } catch (e) { toast(e.message, 'danger'); } } }) });
  }
  const SRC = { email: ['Communicated (email)', 'success'], worksheet: ['Worksheet proposal', 'neutral'], proposal: ['Proposal', 'info'] };
  const root = h('div', { class: 'stack' },
    banner({ tone: 'warning', title: 'Restricted', text: 'Only the founders and named compensation administrators can open this page — the admin role alone cannot. Amounts are encrypted on the server and every view is logged.' }),
    h('div', { class: 'toolbar' }, button('New proposal', { variant: 'primary', iconName: 'plus', onClick: propose }), h('span', { class: 'muted' }, v.bonus_guidance_months != null ? `Bonus guidance: ${v.bonus_guidance_months} months` : 'Bonus guidance not set · bands not configured')),
    v.rows.length ? card({ title: 'Compensation records', iconName: 'calculator', flush: true, body: dataTable({ compact: true, rows: v.rows, columns: [
      { key: 'person', label: 'Person' }, { key: 'year', label: 'Year' }, { key: 'source', label: 'Source', render: (r) => badge(...SRC[r.source]) },
      { key: 'prior', label: 'From', num: true, render: (r) => (r.prior != null ? r.prior.toFixed(0) : '—') }, { key: 'to', label: 'To', num: true, render: (r) => ((r.approved ?? r.proposed) != null ? (r.approved ?? r.proposed).toFixed(0) : '—') },
      { key: 'increase_pct', label: 'Increase', num: true, render: (r) => (r.increase_pct != null ? `${r.increase_pct}%${r.quoted_pct != null && Math.abs(r.quoted_pct - r.increase_pct) > 0.05 ? ` (email said ${r.quoted_pct}%)` : ''}` : '—') },
      { key: 'bonus', label: 'Bonus', render: (r) => (r.bonus_type === 'months' ? `${r.bonus_months} mo${r.bonus_value != null ? ` ≈ ${r.bonus_value.toFixed(0)}` : ''}` : r.bonus_type === 'fixed' ? `${r.bonus_amount}` : '—') },
      { key: 'title', label: 'Title / outcome', render: (r) => [r.title || '', r.outcome_label ? h('div', { class: 'muted small' }, r.outcome_label) : null] },
      { key: 'status', label: 'Status', render: (r) => [badge(r.status, r.status === 'approved' || r.status === 'released' ? 'success' : 'neutral'),
        r.has_message ? button('Email', { size: 'sm', variant: 'ghost', onClick: async () => { const m = await api(`/api/compensation/${r.id}/message`); openDrawer({ title: `Communicated — ${r.person} ${r.year}`, iconName: 'mail', body: h('pre', { class: 'mail-body' }, m.body || '') }); } }) : null,
        r.source === 'proposal' && r.status === 'draft' && me.nav.founder ? button('Approve', { size: 'sm', onClick: act(() => api(`/api/compensation/${r.id}/approve`, { method: 'POST' }), 'Approved') }) : null,
        r.source === 'proposal' && r.status === 'approved' && me.nav.founder && v.employee_release ? button('Release to employee', { size: 'sm', onClick: act(() => api(`/api/compensation/${r.id}/release`, { method: 'POST' }), 'Released privately') }) : null] }] }) })
      : emptyState({ iconName: 'calculator', title: 'No compensation records', text: 'Import the 2025 communicated outcomes under PMS history, or add a proposal.' }));
  root.modern = true;
  return root;
}

// ---------------------------------------------------------- history import --
export async function perfImportScreen({ api, toBase64 }) {
  const batches = await api('/api/performance/imports');
  const root = h('div', { class: 'stack' });
  const result = h('div', { class: 'stack' });
  async function upload(kind, file) {
    if (!file) return;
    const buf = await file.arrayBuffer();
    try { const p = await api(`/api/performance/imports/${kind}?filename=${encodeURIComponent(file.name)}`, { method: 'POST', raw: new Uint8Array(buf) }); show(p); } catch (e) { toast(e.message, 'danger'); }
  }
  function show(p) {
    const maps = {};
    const rows = p.rows.map((r) => {
      let mapCtl = null;
      if (!r.matched && r.status === 'needs mapping') { mapCtl = select([['skip', 'Skip (not imported)'], ...p.people.map((x) => [x.id, x.name])], { 'aria-label': `Map ${r.name_in_source}`, onchange: (e) => { maps[r.key] = e.target.value; } }); maps[r.key] = 'skip'; }
      return h('tr', {}, h('td', {}, r.name_in_source, r.email_in_source ? h('div', { class: 'muted small' }, r.email_in_source) : null), h('td', {}, r.matched ? r.matched.name : mapCtl || '—'), h('td', {}, badge(r.status, r.status === 'ready' ? 'success' : r.status === 'needs mapping' ? 'warning' : 'neutral')),
        h('td', { class: 'num' }, p.kind === 'outcomes' ? `${r.prior ?? '—'} → ${r.new ?? '—'}` : `${r.current ?? '—'} → ${r.proposed ?? '—'}`), h('td', {}, p.kind === 'outcomes' ? `${r.bonus_months ?? '—'} mo` : String(r.bonus ?? '—')),
        h('td', {}, r.title || '', h('div', { class: 'muted small' }, r.outcome || '')), h('td', {}, r.flags.length ? h('ul', { class: 'flag-list' }, r.flags.map((f) => h('li', {}, f))) : h('span', { class: 'muted' }, 'No issues')));
    });
    result.replaceChildren(card({ title: `${p.kind === 'outcomes' ? 'Communicated outcomes' : `Worksheet — ${p.sheet}`}: ${p.filename}${p.duplicate ? ' (already uploaded)' : ''}`, iconName: 'file-spreadsheet',
      body: h('div', { class: 'stack' }, p.ignored_columns?.length ? h('p', { class: 'muted small' }, `Not read: ${p.ignored_columns.join(', ')}.`) : null,
        h('div', { class: 'table-wrap' }, h('table', { class: 'data compact' }, h('thead', {}, h('tr', {}, ['In the file', 'Person', 'Status', 'Salary', 'Bonus', 'Title / outcome', 'To review'].map((t) => h('th', {}, t)))), h('tbody', {}, rows))),
        p.status === 'previewed' ? h('div', { class: 'row' }, button('Import these records', { variant: 'primary', iconName: 'check', onClick: async () => { try { const r = await api(`/api/performance/imports/${p.id}/apply`, { method: 'POST', body: { mappings: maps } }); toast(`Imported ${r.imported}${r.skipped.length ? ` · skipped ${r.skipped.length}` : ''}`); refresh(); } catch (e) { toast(e.message, 'danger'); } } }),
          button('Discard', { onClick: act(() => api(`/api/performance/imports/${p.id}/discard`, { method: 'POST' }), 'Discarded') })) : h('p', { class: 'muted' }, `This file was ${p.status}.`)) }));
  }
  const csv = h('input', { type: 'file', accept: '.csv,text/csv', id: 'imp-csv', onchange: (e) => upload('outcomes', e.target.files[0]) });
  const xl = h('input', { type: 'file', accept: '.xlsx', id: 'imp-xl', onchange: (e) => upload('worksheet', e.target.files[0]) });
  root.append(banner({ tone: 'warning', title: 'Confidential — dry run first', text: 'Upload the files here, not anywhere else. Nothing is saved until you press Import. People are matched by exact work email (or exact full name for worksheets); anyone else is skipped unless you map them. Imported history never changes current profiles, titles or payroll, and sends no email. Age is never read.' }),
    card({ title: '2025 history', iconName: 'cloud-upload', body: h('div', { class: 'stack' },
      field({ label: '2025_PMS_Outcome_Confidential.csv — the outcomes as communicated by email', id: 'imp-csv', control: csv }),
      field({ label: 'Worksheet — the Salaries tab of GB_Team_2025_PMS.xlsx, or Bonuses.xlsx (proposals, kept separately)', id: 'imp-xl', control: xl }),
      h('p', { class: 'muted small' }, 'The 2025 scores (PMS tab) are already in GB People under Earlier reviews, on their original scale.')) }),
    result,
    batches.length ? card({ title: 'Earlier uploads', iconName: 'history', body: h('ul', { class: 'perf-list' }, batches.map((b) => h('li', {}, `${fmt(b.created_at)} — ${b.filename || b.kind} · ${b.status}`))) }) : h('span'));
  root.modern = true;
  return root;
}
