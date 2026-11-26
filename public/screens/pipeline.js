// Pipeline: opportunities by stage, with value, probability, owner and next step; weighted forecast by
// quarter; hit rate and why we lose. Partners and People Ops see all; others see the ones they own.
import { h, icon, button, badge, card, emptyState, field, input, select, textarea, toast, openDrawer, statStrip, filterChips } from '/ui.js';

const M = (x, cur = 'JOD') => (x == null ? '—' : `${Math.round(x / 100).toLocaleString('en-GB')} ${cur || 'JOD'}`);
const fmt = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—');
const OPEN = ['lead', 'qualifying', 'proposal', 'submitted', 'negotiation'];

export async function pipelineScreen({ api, me }) {
  const people = await api('/api/people').catch(() => []);
  const lib = await api('/api/library').catch(() => ({ clients: [] }));
  const everyone = [{ id: me.id, name: me.name }, ...people].sort((a, b) => a.name.localeCompare(b.name));
  const root = h('div', { class: 'stack' });
  let view = 'board'; let v;

  async function edit(o = null) {
    const isNew = !o;
    const clientSel = select([['', 'Choose a client…'], ...lib.clients.map((c) => [c.id, c.name_en]), ['__new', 'New client…']], { id: 'op-client' });
    const newClient = input({ id: 'op-newclient', placeholder: 'Client name' }); const newWrap = field({ label: 'New client', id: 'op-newclient', control: newClient }); newWrap.hidden = true;
    clientSel.onchange = () => { newWrap.hidden = clientSel.value !== '__new'; };
    const title = input({ id: 'op-title', value: o?.title_en || '', placeholder: 'e.g. Five-year strategy and KPI cascade' });
    const stage = select(v.stages.map((s) => [s.key, s.label]), { id: 'op-stage' }); stage.value = o?.stage || 'lead';
    const value = input({ id: 'op-value', type: 'number', min: 0, step: 1000, value: o?.value_x100 != null ? o.value_x100 / 100 : '' });
    const cur = select(['JOD', 'USD', 'SAR', 'AED', 'EUR', 'IQD'].map((c) => [c, c]), { id: 'op-cur' }); cur.value = o?.currency || 'JOD';
    const prob = input({ id: 'op-prob', type: 'number', min: 0, max: 100, step: 5, value: o?.probability ?? '' });
    stage.addEventListener('change', () => { prob.value = v.stages.find((s) => s.key === stage.value).probability; lostWrap.hidden = stage.value !== 'lost'; });
    const owner = select([['', 'Nobody yet'], ...everyone.map((p) => [p.id, p.name])], { id: 'op-owner' }); owner.value = o?.owner_user_id || '';
    const next = input({ id: 'op-next', value: o?.next_step || '', placeholder: 'e.g. Call Mr. X to confirm the scope' }); const nextOn = input({ id: 'op-nexton', type: 'date', value: o?.next_step_on || '' });
    const close_ = input({ id: 'op-close', type: 'date', value: o?.expected_close || '' }); const start = input({ id: 'op-start', type: 'date', value: o?.expected_start || '' });
    const drive = input({ id: 'op-drive', type: 'url', value: o?.drive_url || '', placeholder: 'https://drive.google.com/…' });
    const lost = select([['', 'Why was it lost?'], ...v.lost_reasons.map((r) => [r, r])], { id: 'op-lost' }); lost.value = o?.lost_reason || '';
    const lostWrap = field({ label: 'Lost because', id: 'op-lost', control: lost }); lostWrap.hidden = stage.value !== 'lost';
    let contactSel = null;
    if (o) {
      const cs = await api(`/api/clients/${o.client_id}/contacts`).catch(() => []);
      contactSel = select([['', 'No contact'], ...cs.map((c) => [c.id, `${c.name}${c.role ? ` — ${c.role}` : ''}`])], { id: 'op-contact' }); contactSel.value = o.contact_id || '';
    }
    const cName = input({ id: 'ct-name', placeholder: 'Name' }); const cRole = input({ id: 'ct-role', placeholder: 'Role' }); const cEmail = input({ id: 'ct-email', type: 'email', placeholder: 'Email' }); const cPhone = input({ id: 'ct-phone', placeholder: 'Phone' });
    openDrawer({ title: isNew ? 'New opportunity' : `${o.client_short || o.client} — ${o.title_en}`, iconName: 'trending-up', body: h('div', { class: 'stack' },
      isNew ? [field({ label: 'Client', id: 'op-client', control: clientSel, required: true }), newWrap] : null,
      field({ label: 'Opportunity', id: 'op-title', control: title, required: true }),
      h('div', { class: 'form-grid' }, field({ label: 'Stage', id: 'op-stage', control: stage }), field({ label: 'Probability %', id: 'op-prob', control: prob }), field({ label: 'Value (fee)', id: 'op-value', control: value }), field({ label: 'Currency', id: 'op-cur', control: cur }),
        field({ label: 'Owner', id: 'op-owner', control: owner }), field({ label: 'Expected decision', id: 'op-close', control: close_ }), field({ label: 'Expected start', id: 'op-start', control: start }), lostWrap),
      h('div', { class: 'form-grid' }, field({ label: 'Next step', id: 'op-next', control: next }), field({ label: 'By', id: 'op-nexton', control: nextOn })),
      field({ label: 'Proposal folder (Drive)', id: 'op-drive', control: drive }),
      contactSel ? [field({ label: 'Client contact', id: 'op-contact', control: contactSel }), h('details', {}, h('summary', {}, 'Add a contact at this client'),
        h('div', { class: 'form-grid' }, cName, cRole, cEmail, cPhone), button('Add contact', { size: 'sm', iconName: 'plus', onClick: async () => { try { await api('/api/contacts', { method: 'POST', body: { client_id: o.client_id, name: cName.value, role: cRole.value, email: cEmail.value, phone: cPhone.value } }); toast('Contact added'); document.querySelector('.drawer header .btn')?.click(); draw(); edit(v.rows.find((x) => x.id === o.id)); } catch (e) { toast(e.message, 'danger'); } } }))] : null,
      o?.stage === 'won' && v.canAll ? h('p', { class: 'callout' }, icon('party-popper'), ' Won. Create the project to start the team, timesheets and the Library record.', ' ',
        button('Create the project', { size: 'sm', variant: 'primary', iconName: 'briefcase', onClick: async () => { try { const r = await api(`/api/pipeline/${o.id}/project`, { method: 'POST' }); toast(r.existing ? 'The project already exists' : 'Project created'); location.hash = `#/projects?p=${r.project_id}`; } catch (e) { toast(e.message, 'danger'); } } })) : null),
    footer: (close) => button(isNew ? 'Add' : 'Save', { variant: 'primary', iconName: 'check', onClick: async () => {
      const body = { title_en: title.value, stage: stage.value, probability: prob.value === '' ? undefined : prob.value, value: value.value, currency: cur.value, owner_user_id: owner.value || null,
        next_step: next.value, next_step_on: nextOn.value || null, expected_close: close_.value || null, expected_start: start.value || null, drive_url: drive.value, ...(stage.value === 'lost' ? { lost_reason: lost.value } : {}),
        ...(contactSel ? { contact_id: contactSel.value || null } : {}), ...(isNew ? (clientSel.value === '__new' ? { clientName: newClient.value } : { clientId: clientSel.value }) : {}) };
      if (body.probability === undefined) delete body.probability;
      try { await (isNew ? api('/api/pipeline', { method: 'POST', body }) : api(`/api/pipeline/${o.id}`, { method: 'PATCH', body })); toast('Saved'); close(); draw(); } catch (e) { toast(e.message, 'danger'); }
    } }) });
  }

  const cardFor = (o) => h('button', { type: 'button', class: `opp${o.next_overdue ? ' overdue' : ''}`, onclick: () => edit(o) },
    h('span', { class: 'opp-client' }, o.client_short || o.client), h('strong', {}, o.title_en),
    h('span', { class: 'opp-meta' }, h('span', {}, o.value_x100 ? M(o.value_x100, o.currency) : 'No value'), h('span', {}, `${o.probability}%`)),
    o.next_step ? h('span', { class: `opp-next${o.next_overdue ? ' late' : ''}` }, icon(o.next_overdue ? 'triangle-alert' : 'arrow-right'), ` ${o.next_step}${o.next_step_on ? ` · ${fmt(o.next_step_on)}` : ''}`) : h('span', { class: 'opp-next muted' }, 'No next step'),
    h('span', { class: 'muted opp-owner' }, o.owner_name || o.owner || 'No owner'));

  async function draw() {
    v = await api('/api/pipeline'); const t = v.totals;
    const open = v.rows.filter((r) => OPEN.includes(r.stage));
    const board = h('div', { class: 'board' }, OPEN.map((k) => { const s = v.stages.find((x) => x.key === k); const items = open.filter((r) => r.stage === k);
      return h('section', { class: 'board-col', 'aria-label': s.label }, h('header', {}, h('strong', {}, s.label), h('span', { class: 'muted' }, `${items.length} · ${M(items.reduce((a, r) => a + (r.value_x100 || 0), 0))}`)), ...items.map(cardFor)); }));
    const closed = v.rows.filter((r) => !OPEN.includes(r.stage)).slice(0, 40);
    root.replaceChildren(
      h('div', { class: 'toolbar' }, filterChips([{ value: 'board', label: 'Open opportunities', count: open.length }, { value: 'closed', label: 'Won and lost', count: v.rows.length - open.length }], view, (x) => { view = x; draw(); }),
        v.canAll ? button('New opportunity', { variant: 'primary', iconName: 'plus', onClick: () => edit() }) : null),
      statStrip([{ iconName: 'trending-up', value: M(t.open_value_x100), label: `open pipeline (${t.open})` }, { iconName: 'percent', value: M(t.weighted_x100), label: 'weighted by probability' },
        { iconName: 'trophy', value: t.hit_rate == null ? '—' : `${t.hit_rate}%`, label: `hit rate ${t.year}` }, { iconName: 'triangle-alert', value: String(t.overdue_next_steps), label: 'overdue next steps' }]),
      t.no_value ? h('p', { class: 'callout' }, `${t.no_value} open opportunit${t.no_value === 1 ? 'y has' : 'ies have'} no value yet — add one to make the forecast meaningful.`) : null,
      view === 'board' ? (open.length ? board : emptyState({ iconName: 'trending-up', title: 'No open opportunities', text: v.canAll ? 'Add the first one with “New opportunity”.' : 'Opportunities you own appear here.' }))
        : card({ title: 'Won and lost', iconName: 'trophy', body: closed.length ? h('ul', { class: 'eng-list' }, closed.map((o) => h('li', { class: 'eng-item' }, h('div', { class: 'eng-main' }, h('strong', {}, `${o.client_short || o.client} — ${o.title_en}`),
          h('div', { class: 'eng-meta muted' }, h('span', {}, M(o.value_x100, o.currency)), o.decided_on ? h('span', {}, `Decided ${fmt(o.decided_on)}`) : null, o.lost_reason ? h('span', {}, o.lost_reason) : null)),
          h('div', { class: 'eng-side' }, badge(v.stages.find((s) => s.key === o.stage).label, o.stage === 'won' ? 'success' : o.stage === 'lost' ? 'danger' : 'neutral'), button('Open', { size: 'sm', variant: 'ghost', onClick: () => edit(o) }))))) : h('p', { class: 'muted' }, 'Nothing decided yet.') }),
      h('div', { class: 'report-grid' },
        card({ title: 'Forecast by expected decision', iconName: 'calendar-days', body: v.by_quarter.length ? h('ul', { class: 'bullets' }, v.by_quarter.map((q) => h('li', {}, `${q.quarter}: ${M(q.value_x100)} open, ${M(q.weighted_x100)} weighted (${q.n})`))) : h('p', { class: 'muted' }, 'No open opportunities.') }),
        card({ title: 'Why we lose', iconName: 'circle-x', body: Object.keys(v.lost_reasons_count).length ? h('ul', { class: 'bullets' }, Object.entries(v.lost_reasons_count).sort((a, b) => b[1] - a[1]).map(([r, n]) => h('li', {}, `${r}: ${n}`))) : h('p', { class: 'muted' }, 'Record a reason when you mark an opportunity lost.') })));
  }
  await draw(); root.modern = true;
  return root;
}
