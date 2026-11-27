// Performance (2027 onward): My performance, the review page (manager / founders), Team performance.
import { h, icon, button, badge, card, banner, emptyState, field, input, select, textarea, toast, openDrawer, promptModal, dataTable } from '/ui.js';

const STATE = { goals: ['Setting priorities', 'info'], in_year: ['In the year', 'neutral'], reflection: ['Reflection', 'warning'], manager: ['Manager review', 'warning'], calibration: ['Calibration', 'warning'],
  approval: ['Founders confirming', 'warning'], released: ['Released', 'success'], acknowledged: ['Acknowledged', 'success'], correction: ['Correction requested', 'danger'], closed: ['Closed', 'neutral'] };
const KIND = { delivery: 'Delivery', growth: 'Growth', contribution: 'Firm contribution' };
const RATING = { below: ['Below role expectations', 'danger'], in_line: ['In line with role expectations', 'info'], above: ['Above role expectations', 'success'], insufficient: ['Insufficient observation', 'neutral'] };
const MONTH = (m) => new Date(2000, m - 1, 1).toLocaleDateString('en-GB', { month: 'long' });
const fmt = (s) => (s ? new Date(s.length > 10 ? s : `${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const st = (s) => badge(...(STATE[s] || [s, 'neutral']));
const refresh = () => dispatchEvent(new HashChangeEvent('hashchange'));
const act = (fn, ok) => async () => { try { await fn(); if (ok) toast(ok); refresh(); } catch (e) { toast(e.message, 'danger'); } };

function goalsEditor(api, v, { canEdit, afterAgreed }) {
  const ctrls = {};
  const rows = ['delivery', 'growth', 'contribution'].map((k) => { const g = v.goals.find((x) => x.kind === k); ctrls[k] = textarea({ id: `g-${k}`, rows: 2, readonly: canEdit ? null : true, placeholder: { delivery: 'e.g. Own the N-2 organisation design deliverable on Modon', growth: 'e.g. Facilitate one client workshop end to end', contribution: 'e.g. Build the KPI dictionary template for the toolkit' }[k] }, g?.text || '');
    return field({ label: `${KIND[k]} priority${g?.status === 'proposed' ? ' (proposed change)' : ''}`, id: `g-${k}`, control: ctrls[k] }); });
  const reason = afterAgreed && canEdit ? input({ id: 'g-why', placeholder: 'Why it changes, e.g. assignment moved to Beta in May' }) : null;
  return h('div', { class: 'stack' }, ...rows, reason ? field({ label: 'Reason for the change', id: 'g-why', control: reason, help: 'Your review manager approves changes after priorities are agreed' }) : null,
    canEdit ? button(afterAgreed ? 'Propose the change' : 'Save priorities', { variant: 'primary', iconName: 'check', onClick: act(() => api(`/api/performance/reviews/${v.id}/goals`, { method: 'POST', body: { goals: Object.entries(ctrls).filter(([, c]) => c.value.trim()).map(([kind, c]) => ({ kind, text: c.value })), reason: reason?.value } }), 'Saved') }) : null);
}

function timeline(api, v, { lead }) {
  const kick = v.kickoffs.length ? h('ul', { class: 'perf-list' }, v.kickoffs.map((k) => h('li', {}, h('strong', {}, k.project || k.internal_title), h('span', { class: 'muted' }, [k.role, `owns: ${k.owns}`].filter(Boolean).join(' · ')), h('span', {}, `What good looks like: ${k.good_looks_like}`), k.dependencies ? h('span', { class: 'muted' }, `Depends on: ${k.dependencies}`) : null)))
    : h('p', { class: 'muted' }, 'No assignment kickoffs yet.');
  const addKick = () => {
    const a = select([['', 'Internal assignment (not a client project)'], ...v.kickoff_candidates.map((c) => [c.assignment_id, `${c.project}${c.role ? ` — ${c.role}` : ''}`])], { id: 'k-a' });
    const t = input({ id: 'k-t', placeholder: 'e.g. GB AI toolkit' }); const role = input({ id: 'k-r' }); const owns = textarea({ id: 'k-o', rows: 2 }); const good = textarea({ id: 'k-g', rows: 2 }); const dep = textarea({ id: 'k-d', rows: 2 });
    openDrawer({ title: 'Assignment kickoff', iconName: 'briefcase', body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Two minutes at the start of an assignment: what the person owns and what good looks like. It becomes the evidence trail for the year.'),
      field({ label: 'Assignment', id: 'k-a', control: a }), field({ label: 'Internal assignment name (if not a project)', id: 'k-t', control: t }), field({ label: 'Role', id: 'k-r', control: role }),
      field({ label: 'Owned deliverable or responsibility', id: 'k-o', control: owns }), field({ label: 'What good looks like', id: 'k-g', control: good }), field({ label: 'Dependencies', id: 'k-d', control: dep })),
    footer: (close) => button('Save kickoff', { variant: 'primary', iconName: 'check', onClick: async () => { try { await api('/api/performance/kickoffs', { method: 'POST', body: { user_id: v.user_id, assignment_id: a.value || null, internal_title: t.value, role: role.value, owns: owns.value, good_looks_like: good.value, dependencies: dep.value } }); close(); toast('Saved'); refresh(); } catch (e) { toast(e.message, 'danger'); } } }) });
  };
  const snaps = v.snapshots.length ? h('ul', { class: 'perf-list' }, v.snapshots.map((s) => h('li', {}, h('div', { class: 'row' }, h('strong', {}, s.project), badge(...RATING[s.rating]), h('span', { class: 'muted' }, `${s.observer} · ${fmt(s.submitted_at)}`)),
    s.owned ? h('span', {}, h('strong', {}, 'Owned: '), s.owned) : null, s.example ? h('span', {}, h('strong', {}, 'Example: '), s.example, s.impact ? ` — ${s.impact}` : '') : null, s.development ? h('span', {}, h('strong', {}, 'Development: '), s.development) : null,
    s.employee_context ? h('span', { class: 'callout' }, `${v.relation === 'self' ? 'Your' : 'Employee'} context: ${s.employee_context}${s.correction_requested_at ? ' (correction requested)' : ''}`) : null,
    v.relation === 'self' && !s.employee_context ? h('div', { class: 'row' }, button('Add context', { size: 'sm', onClick: async () => { const c = await promptModal({ title: 'Add context', label: 'Your context', confirmLabel: 'Add' }); if (c) act(() => api(`/api/performance/snapshots/${s.id}/respond`, { method: 'POST', body: { context: c } }), 'Added')(); } }),
      button('Ask for a correction', { size: 'sm', variant: 'ghost', onClick: async () => { const c = await promptModal({ title: 'Ask for a correction', label: 'What should be corrected', confirmLabel: 'Send' }); if (c) act(() => api(`/api/performance/snapshots/${s.id}/respond`, { method: 'POST', body: { context: c, correction: true } }), 'Sent to the observer')(); } })) : null)))
    : h('p', { class: 'muted' }, 'No project snapshots shared yet. They are requested automatically at milestones, roll-off and closure, and once a quarter on long engagements.');
  const coach = v.coaching.length ? h('ul', { class: 'perf-list' }, v.coaching.map((c) => h('li', {}, h('strong', {}, `${MONTH(c.month)}${c.career ? ' — career conversation' : ''}`), h('span', {}, h('strong', {}, 'Strength: '), c.strength), h('span', {}, h('strong', {}, 'Improve: '), c.improvement), h('span', {}, h('strong', {}, 'Next: '), c.next_assignment, c.owner ? ` (owner ${c.owner}${c.due_on ? `, by ${fmt(c.due_on)}` : ''})` : ''))))
    : h('p', { class: 'muted' }, `Coaching happens in ${(v.policy.coaching?.months || [3, 6, 9]).map(MONTH).join(', ')} — no rating, one strength, one improvement and the next stretch.`);
  const addCoach = () => {
    const m = select((v.policy.coaching?.months || [3, 6, 9]).map((x) => [String(x), `${MONTH(x)}${x === v.policy.coaching?.career_month ? ' (career conversation)' : ''}`]), { id: 'c-m' });
    const sg = textarea({ id: 'c-s', rows: 2 }); const im = textarea({ id: 'c-i', rows: 2 }); const nx = textarea({ id: 'c-n', rows: 2, placeholder: 'A concrete next assignment or stretch responsibility' }); const due = input({ id: 'c-d', type: 'date' });
    openDrawer({ title: 'Coaching conversation', iconName: 'messages-square', body: h('div', { class: 'stack' }, field({ label: 'Quarter', id: 'c-m', control: m }), field({ label: 'One strength', id: 'c-s', control: sg }), field({ label: 'One improvement action', id: 'c-i', control: im }), field({ label: 'Next assignment or stretch', id: 'c-n', control: nx }), field({ label: 'Due', id: 'c-d', control: due })),
      footer: (close) => button('Save', { variant: 'primary', iconName: 'check', onClick: async () => { try { await api(`/api/performance/reviews/${v.id}/coaching`, { method: 'POST', body: { month: Number(m.value), strength: sg.value, improvement: im.value, next_assignment: nx.value, due_on: due.value || null } }); close(); toast('Saved'); refresh(); } catch (e) { toast(e.message, 'danger'); } } }) });
  };
  return [
    card({ title: 'Assignments', iconName: 'briefcase', actions: button('Add kickoff', { size: 'sm', iconName: 'plus', onClick: addKick }), body: h('div', { class: 'stack' }, kick, lead && v.conflicts?.length ? banner({ tone: 'warning', title: 'Conflicting deadlines', text: v.conflicts.map((c) => `${c.a.title} (${c.a.project}, ${fmt(c.a.due)}) and ${c.b.title} (${c.b.project}, ${fmt(c.b.due)})`).join(' · ') }) : null) }),
    card({ title: 'Project snapshots', iconName: 'eye', body: snaps }),
    card({ title: 'Coaching', iconName: 'messages-square', actions: lead ? button('Record coaching', { size: 'sm', iconName: 'plus', onClick: addCoach }) : null, body: coach }),
  ];
}

function resultCard(api, v) {
  const r = v.released; if (!r) return null;
  return card({ title: `${v.cycle.year} result`, iconName: 'award', body: h('div', { class: 'stack' },
    r.outcome === 'insufficient' ? banner({ tone: 'info', title: 'Closed without a score', text: r.insufficient_reason || 'Not enough observed evidence this year.' })
      : h('div', { class: 'perf-score' }, h('strong', {}, r.score), h('span', {}, r.band)),
    h('ul', { class: 'perf-list' }, r.dimensions.map((d) => h('li', {}, h('div', { class: 'row' }, h('strong', {}, d.label), h('span', { class: 'muted' }, `${d.weight}%`), d.na ? badge('Not applicable (approved)', 'neutral') : badge(`${d.score} / 5`, 'info')), d.rationale ? h('span', {}, d.rationale) : null, d.growth_action ? h('span', { class: 'muted' }, `Growth: ${d.growth_action}`) : null))),
    v.relation === 'self' && !v.ack ? h('div', { class: 'row' }, button('Acknowledge receipt', { variant: 'primary', iconName: 'check', onClick: act(() => api(`/api/performance/reviews/${v.id}/acknowledge`, { method: 'POST', body: { kind: 'ack' } }), 'Acknowledged') }),
      button('Ask for a correction', { onClick: async () => { const n = await promptModal({ title: 'Ask for a correction', label: 'What should be corrected', confirmLabel: 'Send to the founders' }); if (n) act(() => api(`/api/performance/reviews/${v.id}/acknowledge`, { method: 'POST', body: { kind: 'correction', note: n } }), 'Sent')(); } }),
      h('span', { class: 'muted' }, 'Acknowledging records that you received it, not that you agree.')) : v.ack ? h('p', { class: 'muted' }, `${v.ack.kind === 'correction' ? 'Correction requested' : 'Acknowledged'} on ${fmt(v.ack.at)}${v.ack.note ? `: ${v.ack.note}` : ''}`) : null) });
}

export async function myPerformanceScreen({ api }) {
  const d = await api('/api/performance/me');
  const v = d.current;
  const root = h('div', { class: 'stack' });
  if (!v) {
    root.append(emptyState({ iconName: 'trending-up', title: 'No performance cycle for you yet', text: 'When the founders start a cycle you agree up to three priorities here. Your earlier reviews are under Earlier reviews.', action: button('Earlier reviews', { href: '#/history' }) }));
  } else {
    root.append(h('div', { class: 'perf-head' }, h('div', {}, h('h2', { class: 'section-title' }, v.cycle.name), h('p', { class: 'muted' }, `Review manager: ${v.manager || 'not set'} · ${[v.level, v.track].filter(Boolean).join(' – ')}`)), st(v.state)),
      d.next ? banner({ tone: 'info', title: 'Next', text: d.next }) : null,
      h('p', { class: 'muted' }, icon('lock'), ' Only you, your review manager and the founders see this. Ratings and the result appear here only after both founders confirm them.'));
    const reflection = v.state === 'reflection' ? (() => {
      const acc = [0, 1, 2].map((i) => ({ t: textarea({ rows: 2, 'aria-label': `Accomplishment ${i + 1}` }, v.reflection?.accomplishments?.[i]?.text || ''), l: input({ type: 'url', 'aria-label': `Evidence link ${i + 1}`, placeholder: 'https://docs.google.com/…', value: v.reflection?.accomplishments?.[i]?.link || '' }) }));
      const gr = textarea({ id: 'rf-g', rows: 2 }, v.reflection?.growth || ''); const nx = textarea({ id: 'rf-n', rows: 2 }, v.reflection?.next || '');
      const body = () => ({ accomplishments: acc.map((a) => ({ text: a.t.value, link: a.l.value })), growth: gr.value, next: nx.value });
      return card({ title: 'Your reflection', iconName: 'pencil', body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'One short reflection: up to three accomplishments with evidence, one growth area and the responsibility you want next.'),
        ...acc.map((a, i) => h('div', { class: 'edit-row' }, h('strong', {}, `${i + 1}.`), a.t, a.l)), field({ label: 'One growth area', id: 'rf-g', control: gr }), field({ label: 'Responsibility you would like next', id: 'rf-n', control: nx }),
        h('div', { class: 'row' }, button('Submit to my review manager', { variant: 'primary', iconName: 'send', onClick: act(() => api(`/api/performance/reviews/${v.id}/reflection`, { method: 'POST', body: { ...body(), submit: true } }), 'Submitted') }), button('Save draft', { onClick: act(() => api(`/api/performance/reviews/${v.id}/reflection`, { method: 'POST', body: body() }), 'Saved') }))) });
    })() : v.reflection ? card({ title: 'Your reflection', iconName: 'pencil', body: h('ul', { class: 'perf-list' }, v.reflection.accomplishments.map((a) => h('li', {}, a.text, a.link ? [' ', h('a', { href: a.link, target: '_blank', rel: 'noopener' }, 'evidence')] : null)), h('li', {}, h('strong', {}, 'Growth: '), v.reflection.growth), h('li', {}, h('strong', {}, 'Next: '), v.reflection.next)) }) : null;
    root.append(resultCard(api, v) || h('span'), reflection || h('span'),
      card({ title: 'Priorities', iconName: 'target', actions: v.goals_agreed_at ? badge(`Agreed ${fmt(v.goals_agreed_at)}`, 'success') : null, body: goalsEditor(api, v, { canEdit: ['goals', 'in_year'].includes(v.state), afterAgreed: !!v.goals_agreed_at }) }),
      ...timeline(api, v, { lead: false }));
  }
  if (d.outcome?.promotions?.length || d.outcome?.compensation?.length) root.append(card({ title: 'Confirmed outcome', iconName: 'award', body: h('ul', { class: 'perf-list' },
    d.outcome.promotions.map((p) => h('li', {}, h('strong', {}, p.approved_title), h('span', {}, `Effective ${fmt(p.effective_on)}`), h('span', { class: 'muted' }, p.approved_scope))),
    d.outcome.compensation.map((c) => h('li', {}, h('strong', {}, `${c.year}: ${c.salary?.toFixed(0)} ${c.currency} a month`), h('span', {}, `Effective ${c.effective || '—'}${c.bonus_type === 'months' ? ` · bonus ${c.bonus_months} month(s) of salary` : c.bonus_type === 'fixed' ? ` · bonus ${c.bonus_amount} ${c.currency}` : ''}`),
      c.acknowledged_at ? h('span', { class: 'muted' }, `Acknowledged ${fmt(c.acknowledged_at)}`) : button('Acknowledge', { size: 'sm', onClick: act(() => api(`/api/compensation/${c.id}/acknowledge`, { method: 'POST' }), 'Acknowledged') })))) }));
  if (d.history?.length) root.append(card({ title: 'Released results', iconName: 'history', body: h('ul', { class: 'perf-list' }, d.history.map((x) => h('li', {}, h('strong', {}, String(x.year)), x.outcome === 'insufficient' ? 'Closed without a score' : `${x.score} — ${x.band}`))) }));
  root.append(h('p', { class: 'muted' }, 'Reviews before 2027 (the 2025 and 2026 forms) are under ', h('a', { href: '#/history' }, 'Earlier reviews'), ', on their original scale.'));
  root.modern = true;
  return root;
}

// ---------------------------------------------------------- review page --
export async function perfReviewScreen({ api, id }) {
  const v = await api(`/api/performance/reviews/${encodeURIComponent(id)}`);
  const root = h('div', { class: 'stack' });
  root.area = v.relation === 'self' ? 'growth' : 'manager';
  if (v.relation === 'admin') { root.append(h('h1', {}, v.person), banner({ tone: 'info', title: 'Progress only', text: 'The admin role shows where each review stands. Ratings and notes are for the review manager and the founders.' }), st(v.state)); root.modern = true; return root; }
  const lead = v.relation !== 'self'; const founder = v.relation === 'founder';
  root.append(h('div', { class: 'perf-head' }, h('div', {}, h('h1', {}, v.person), h('p', { class: 'muted' }, `${v.cycle.name} · ${[v.level, v.track].filter(Boolean).join(' – ')} · review manager ${v.manager || '—'}`)), st(v.state)));
  if (v.role_history?.length > 1) root.append(banner({ tone: 'info', title: 'Role changed during the year', text: `${v.role_history.map((r) => `${r.title} from ${fmt(r.from)}`).join(' → ')}. Compare each assignment with the expectations of the role held at the time.` }));
  const rubric = v.policy.rubric?.[v.level];
  if (rubric) root.append(h('p', { class: 'callout' }, h('strong', {}, `${v.level}: `), rubric));
  // priorities
  const pending = v.goal_changes.filter((c) => c.status === 'pending');
  root.append(card({ title: 'Priorities', iconName: 'target', actions: v.state === 'goals' ? button('Agree priorities', { size: 'sm', variant: 'primary', iconName: 'check', onClick: act(() => api(`/api/performance/reviews/${v.id}/goals/agree`, { method: 'POST' }), 'Agreed') }) : v.goals_agreed_at ? badge(`Agreed ${fmt(v.goals_agreed_at)}`, 'success') : null,
    body: h('div', { class: 'stack' }, goalsEditor(api, v, { canEdit: ['goals', 'in_year'].includes(v.state), afterAgreed: !!v.goals_agreed_at }),
      pending.length ? h('ul', { class: 'perf-list' }, pending.map((c) => h('li', {}, h('strong', {}, `${KIND[c.kind]}: `), `${c.before_text || '—'} → ${c.after_text}`, h('span', { class: 'muted' }, `${c.reason} — ${c.requested_by}`),
        h('div', { class: 'row' }, button('Approve', { size: 'sm', onClick: act(() => api(`/api/performance/goal-changes/${c.id}`, { method: 'POST', body: { approve: true } }), 'Approved') }), button('Decline', { size: 'sm', variant: 'ghost', onClick: act(() => api(`/api/performance/goal-changes/${c.id}`, { method: 'POST', body: { approve: false } }), 'Declined') }))))) : null) }));
  root.append(...timeline(api, v, { lead }));
  if (v.reflection) root.append(card({ title: 'Reflection', iconName: 'pencil', body: h('ul', { class: 'perf-list' }, v.reflection.accomplishments.map((a) => h('li', {}, a.text, a.link ? [' ', h('a', { href: a.link, target: '_blank', rel: 'noopener' }, 'evidence')] : null)), h('li', {}, h('strong', {}, 'Growth: '), v.reflection.growth), h('li', {}, h('strong', {}, 'Next: '), v.reflection.next)) }));
  // ratings (manager proposes; founders calibrate)
  if (['manager', 'calibration', 'approval', 'released', 'acknowledged', 'correction', 'closed'].includes(v.state)) {
    const editable = v.state === 'manager'; const calib = founder && v.state === 'calibration';
    const ctrls = {};
    const rows = v.ratings.map((r) => {
      const dim = v.policy.dimensions.find((d) => d.key === r.dimension);
      const sc = select([['', '—'], ...[1, 2, 3, 4, 5].map((n) => [String(n), `${n} — ${v.policy.scale[n]}`])], { 'aria-label': `${r.label} score`, disabled: editable ? null : true }); sc.value = r.proposed_score != null ? String(r.proposed_score) : '';
      const ev = textarea({ rows: 2, 'aria-label': `${r.label} evidence`, readonly: editable ? null : true, placeholder: 'Evidence: snapshots, deliverables, examples' }, r.evidence || '');
      const ra = textarea({ rows: 2, 'aria-label': `${r.label} rationale`, readonly: editable ? null : true }, r.rationale || '');
      const ga = input({ 'aria-label': `${r.label} growth action`, readonly: editable ? null : true, value: r.growth_action || '', placeholder: 'Growth action' });
      const na = h('input', { type: 'checkbox', checked: !!r.na_requested, disabled: editable ? null : true }); const nar = input({ 'aria-label': `${r.label} reason not applicable`, value: r.na_reason || '', readonly: editable ? null : true, placeholder: 'Why it does not apply (the firm did not assign this work)' });
      const ins = h('input', { type: 'checkbox', checked: !!r.insufficient, disabled: editable ? null : true });
      ctrls[r.dimension] = { sc, ev, ra, ga, na, nar, ins };
      const fin = calib ? (() => { const f = select([['', 'Keep'], ...[1, 2, 3, 4, 5].map((n) => [String(n), String(n)])], { 'aria-label': `${r.label} final score` }); const why = input({ 'aria-label': `${r.label} calibration rationale`, placeholder: 'Rationale for the change' });
        return h('div', { class: 'edit-row' }, h('strong', {}, 'Calibrated:'), f, why, button('Set', { size: 'sm', onClick: act(() => api(`/api/performance/reviews/${v.id}/calibrate`, { method: 'POST', body: { dimension: r.dimension, score: Number(f.value), rationale: why.value } }), 'Calibrated') }),
          r.na_requested && !r.na_approved_by ? button('Approve not applicable', { size: 'sm', onClick: act(() => api(`/api/performance/reviews/${v.id}/na/${r.dimension}`, { method: 'POST' }), 'Approved') }) : null); })() : null;
      return h('fieldset', { class: 'hr-group' }, h('legend', {}, `${r.label} — ${r.weight}%`), h('p', { class: 'muted small' }, dim?.examples || ''),
        h('div', { class: 'form-grid' }, field({ label: 'Score', id: '', control: sc }), field({ label: 'Growth action', id: '', control: ga })), field({ label: 'Evidence', id: '', control: ev }), field({ label: 'Rationale', id: '', control: ra }),
        h('div', { class: 'edit-row' }, h('label', { class: 'check-row' }, na, 'Not applicable (founder approval)'), nar, h('label', { class: 'check-row' }, ins, 'Insufficient evidence')),
        r.final_score != null ? h('p', {}, h('strong', {}, `Final: ${r.final_score}`), r.na_approved_by ? ` · N/A approved by ${r.na_approved_by}` : '') : r.na_approved_by ? h('p', {}, `Not applicable — approved by ${r.na_approved_by}`) : null, fin);
    });
    const collect = () => Object.entries(ctrls).map(([dimension, c]) => ({ dimension, score: c.sc.value ? Number(c.sc.value) : null, evidence: c.ev.value, rationale: c.ra.value, growth_action: c.ga.value, na: c.na.checked, na_reason: c.nar.value, insufficient: c.ins.checked }));
    root.append(card({ title: 'Ratings', iconName: 'gauge', actions: v.preview ? h('span', { class: 'perf-preview' }, v.preview.status === 'scored' ? `${v.preview.score} · ${v.preview.band}` : v.preview.status === 'insufficient' ? 'Insufficient evidence' : `Pending: ${v.preview.missing.length} to rate`) : null,
      body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, v.policy.fairness), ...rows,
        editable ? h('div', { class: 'row' }, button('Save', { onClick: act(() => api(`/api/performance/reviews/${v.id}/ratings`, { method: 'POST', body: { ratings: collect() } }), 'Saved') }),
          button('Send to calibration', { variant: 'primary', iconName: 'send', onClick: async () => { try { await api(`/api/performance/reviews/${v.id}/ratings`, { method: 'POST', body: { ratings: collect() } }); await api(`/api/performance/reviews/${v.id}/submit`, { method: 'POST' }); toast('Sent to the founders'); refresh(); } catch (e) { toast(e.message, 'danger'); } } })) : null,
        v.changes?.length ? h('details', {}, h('summary', {}, `Rating changes (${v.changes.length})`), h('ul', {}, v.changes.map((c) => h('li', {}, `${c.dimension}: ${c.from_score ?? '—'} → ${c.to_score} · ${c.stage} · ${c.by_name}: ${c.rationale}`)))) : null) }));
  }
  if (founder) {
    const note = textarea({ id: 'ln', rows: 2 }, v.leadership_note || '');
    root.append(card({ title: 'Founders', iconName: 'shield-check', body: h('div', { class: 'stack' },
      field({ label: 'Leadership note (founders only)', id: 'ln', control: note }), button('Save note', { size: 'sm', onClick: act(() => api(`/api/performance/reviews/${v.id}/note`, { method: 'POST', body: { note: note.value } }), 'Saved') }),
      v.state === 'calibration' ? h('div', { class: 'row' }, button('Finish calibration', { variant: 'primary', iconName: 'check', onClick: act(() => api(`/api/performance/reviews/${v.id}/calibrated`, { method: 'POST', body: {} }), 'Calibrated — now both founders confirm') }),
        button('Close as insufficient evidence', { onClick: async () => { const why = await promptModal({ title: 'Close without a score', label: 'Reason' }); if (why) act(() => api(`/api/performance/reviews/${v.id}/calibrated`, { method: 'POST', body: { insufficientReason: why } }), 'Done')(); } })) : null,
      v.state === 'approval' ? h('div', { class: 'stack' }, h('p', {}, `Version ${v.version}: ${v.stored.outcome === 'insufficient' ? 'closed without a score' : `${v.stored.score} — ${v.stored.band}`}`),
        h('ul', { class: 'perf-list' }, v.approvals.needed.map((a) => h('li', {}, a.approved_at ? icon('circle-check') : icon('clock'), ` ${a.name}: ${a.approved_at ? `confirmed ${fmt(a.approved_at)}` : 'not yet'}`))),
        h('div', { class: 'row' }, button('Confirm this result', { variant: 'primary', iconName: 'check', onClick: act(() => api(`/api/performance/reviews/${v.id}/approve`, { method: 'POST' }), 'Confirmed') }),
          v.approvals.complete ? button('Release to the employee', { iconName: 'send', onClick: act(() => api(`/api/performance/reviews/${v.id}/release`, { method: 'POST' }), 'Released privately') }) : h('span', { class: 'muted' }, 'Released only after both founders confirm.'))) : null,
      ['released', 'acknowledged', 'correction', 'closed'].includes(v.state) ? button('Amend (audited)', { onClick: async () => { const reason = await promptModal({ title: 'Amend the released review', text: 'The amendment is recorded; both founders confirm again before the employee sees it.', label: 'Reason' }); if (reason) act(() => api(`/api/performance/reviews/${v.id}/amend`, { method: 'POST', body: { reason } }), 'Back with the founders for confirmation')(); } }) : null,
      v.amendments?.length ? h('ul', { class: 'perf-list' }, v.amendments.map((a) => h('li', {}, `${fmt(a.at)} — ${a.by_name}: ${a.reason}`))) : null) }));
  }
  const res = resultCard(api, v); if (res) root.append(res);
  root.modern = true;
  return root;
}

// ---------------------------------------------------------- team page --
export async function teamPerformanceScreen({ api, me, query = '' }) {
  const v = await api('/api/performance/team');
  const people = await api('/api/people').catch(() => []);
  function openSnapshot(sid) {
    api(`/api/performance/snapshots/${sid}`).then((s) => {
      const ro = s.status === 'submitted';
      const o = textarea({ id: 's-o', rows: 2, readonly: ro || null }, s.owned || ''); const ex = textarea({ id: 's-e', rows: 2, readonly: ro || null }, s.example || ''); const im = textarea({ id: 's-i', rows: 2, readonly: ro || null }, s.impact || ''); const dv = textarea({ id: 's-d', rows: 2, readonly: ro || null }, s.development || '');
      const rt = select([['', 'Choose…'], ...Object.entries(RATING).map(([k, [l]]) => [k, l])], { id: 's-r', disabled: ro || null }); rt.value = s.rating || '';
      const body = () => ({ owned: o.value, example: ex.value, impact: im.value, development: dv.value, rating: rt.value || null });
      openDrawer({ title: `Snapshot: ${s.person} — ${s.project}`, iconName: 'eye', body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, `One short screen, due ${fmt(s.due_on)}. It is shared with ${s.person} when you submit. No score — it is evidence for the year.`),
        s.employee_context ? banner({ tone: s.correction_requested_at ? 'warning' : 'info', title: s.correction_requested_at ? 'Correction requested' : 'Employee context', text: s.employee_context }) : null,
        field({ label: 'What they owned and delivered', id: 's-o', control: o }), field({ label: 'One example', id: 's-e', control: ex }), field({ label: 'Its impact', id: 's-i', control: im }), field({ label: 'One development action', id: 's-d', control: dv }), field({ label: 'Against role expectations', id: 's-r', control: rt })),
      footer: (close) => (ro ? button('Reopen to correct', { onClick: async () => { await api(`/api/performance/snapshots/${sid}/reopen`, { method: 'POST' }); close(); openSnapshot(sid); } })
        : h('div', { class: 'row' }, button('Save draft', { onClick: async () => { try { await api(`/api/performance/snapshots/${sid}`, { method: 'POST', body: body() }); toast('Saved'); } catch (e) { toast(e.message, 'danger'); } } }),
          button('Submit and share', { variant: 'primary', iconName: 'send', onClick: async () => { try { await api(`/api/performance/snapshots/${sid}`, { method: 'POST', body: { ...body(), submit: true } }); close(); toast('Shared'); refresh(); } catch (e) { toast(e.message, 'danger'); } } }))) });
    }).catch((e) => toast(e.message, 'danger'));
  }
  function requestOne() {
    const who = select([['', 'Person…'], ...v.people.map((p) => [p.user_id, p.name])], { id: 'rq-u' }); const obs = select([['', 'Observer…'], ...people.map((p) => [p.id, p.name])], { id: 'rq-o' });
    openDrawer({ title: 'Request a project snapshot', iconName: 'eye', body: h('div', { class: 'stack' }, field({ label: 'About', id: 'rq-u', control: who }), field({ label: 'From the person who observed the work', id: 'rq-o', control: obs })),
      footer: (close) => button('Request', { variant: 'primary', iconName: 'send', onClick: async () => { try { await api('/api/performance/snapshots', { method: 'POST', body: { user_id: who.value, observer_id: obs.value } }); close(); toast('Requested'); refresh(); } catch (e) { toast(e.message, 'danger'); } } }) });
  }
  const root = h('div', { class: 'stack' },
    card({ title: `Feedback to write (${v.feedback.length})`, iconName: 'eye', body: v.feedback.length ? h('ul', { class: 'attn-list' }, v.feedback.map((s) => h('li', {}, h('button', { type: 'button', class: 'attn-row link-row', onclick: () => openSnapshot(s.id) },
      h('span', { class: 'attn-icon', 'aria-hidden': 'true' }, icon('eye')), h('span', { class: 'attn-text' }, h('strong', {}, `${s.person} — ${s.project}`), h('span', { class: 'muted' }, `${s.trigger === 'manual' ? 'Requested' : { milestone: 'Milestone', rolloff: 'Roll-off', closure: 'Project closed', quarterly: 'Quarterly' }[s.trigger]} · ${s.status === 'draft' ? 'draft saved' : 'not started'}`)),
      h('span', { class: 'due due-neutral' }, `Due ${fmt(s.due_on)}`), icon('chevron-right', { flip: true })))))
      : h('p', { class: 'muted' }, 'Nothing to write. Snapshots are requested at milestones, roll-off and closure, and quarterly on long engagements.') }),
    v.corrections.length ? card({ title: 'Corrections requested', iconName: 'rotate-ccw', body: h('ul', { class: 'perf-list' }, v.corrections.map((s) => h('li', {}, h('button', { type: 'button', class: 'link-btn', onclick: () => openSnapshot(s.id) }, `${s.person} — ${s.project}`), h('span', { class: 'muted' }, s.employee_context)))) }) : h('span'),
    card({ title: v.founder ? 'Everyone in the cycle' : 'Your people', iconName: 'users', actions: v.people.length ? button('Request a snapshot', { size: 'sm', iconName: 'plus', onClick: requestOne }) : null,
      body: v.people.length ? dataTable({ compact: true, rows: v.people, rowKey: (p) => p.review_id, onRowClick: (p) => { location.hash = `#/performance/review/${p.review_id}`; }, columns: [
        { key: 'name', label: 'Person', render: (p) => h('a', { href: `#/performance/review/${p.review_id}` }, p.name) }, { key: 'title', label: 'Role' }, { key: 'state', label: 'Stage', render: (p) => st(p.state) },
        { key: 'evidence', label: 'Evidence', render: (p) => `${p.evidence.kickoffs} kickoffs · ${p.evidence.snapshots} snapshots · ${p.evidence.coaching} coaching` },
        { key: 'tasks', label: 'Next', render: (p) => [p.conflicts ? badge(`${p.conflicts} deadline clash${p.conflicts === 1 ? '' : 'es'}`, 'warning') : null, p.tasks.join(', ') || h('span', { class: 'muted' }, '—')] }] })
        : emptyState({ iconName: 'users', title: 'Nobody allocated to you in an open cycle' }) }));
  const sid = new URLSearchParams(query).get('snapshot'); if (sid) setTimeout(() => openSnapshot(sid), 0);
  root.modern = true;
  return root;
}
