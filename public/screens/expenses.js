// Expenses: claims built like GB's expense claim form, with a receipt or invoice on every line.
// The approver approves or returns; People Ops marks approved claims paid.
import { h, icon, button, badge, card, emptyState, filterChips, field, input, select, textarea, toast, promptModal, confirmModal, openDrawer } from '/ui.js';

const money = (x100, cur = 'JOD') => `${(x100 / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
const STATUS = { draft: ['Draft', 'neutral'], submitted: ['Awaiting approval', 'info'], approved: ['Approved', 'success'], rejected: ['Rejected', 'danger'], paid: ['Paid', 'success'] };
const fmt = (s) => (s ? new Date(s.length === 10 ? `${s}T00:00:00` : s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export async function expensesScreen({ api, me, query = '' }) {
  const meta = await api('/api/expenses/meta');
  const canAll = me.roles.includes('partner') || me.roles.includes('people_ops') || me.roles.includes('admin');
  const projects = await api('/api/projects').catch(() => []);
  let tab = new URLSearchParams(query).get('tab') || 'mine';
  const body = h('div', { class: 'stack' });

  const row = (c, onOpen) => h('li', { class: 'eng-item' },
    h('div', { class: 'eng-main' }, h('button', { type: 'button', class: 'link-btn', onclick: onOpen }, h('strong', {}, c.title)),
      h('div', { class: 'eng-meta muted' }, c.employee && tab !== 'mine' ? h('span', {}, icon('user'), ' ', c.employee) : null, h('span', {}, `${c.lines} line${c.lines === 1 ? '' : 's'}`),
        c.submitted_at ? h('span', {}, `Submitted ${fmt(c.submitted_at)}`) : h('span', {}, `Started ${fmt(c.created_at)}`))),
    h('div', { class: 'eng-side' }, h('strong', {}, money(c.total_x100, c.currency)), badge(...(STATUS[c.status] || [c.status, 'neutral']))));

  async function openClaim(id) {
    const c = await api(`/api/expenses/${id}`);
    let close;
    const refresh = () => { close?.(); openClaim(id); };
    const lines = c.lines.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data compact' },
      h('thead', {}, h('tr', {}, ['Date', 'Type', 'Justification', 'Project', 'Receipt amount', 'Reimbursable', 'Receipt', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, c.lines.map((l) => h('tr', {}, h('td', {}, fmt(l.spent_on)), h('td', {}, l.category), h('td', {}, l.description, l.chargeable ? [' ', badge('Chargeable', 'info')] : null),
        h('td', {}, l.project_name || l.project_text || '—'), h('td', { class: 'num' }, `${(l.receipt_amount_x100 / 100).toFixed(2)} ${l.receipt_currency}${l.receipt_currency !== c.currency ? ` × ${l.fx_rate}` : ''}`),
        h('td', { class: 'num' }, money(l.amount_x100, c.currency)),
        h('td', {}, l.receipt_file_id ? h('a', { href: `/api/expenses/${c.id}/lines/${l.id}/receipt`, target: '_blank', rel: 'noopener' }, icon('paperclip'), ' View')
          : c.can.edit ? uploader(c, l, refresh) : badge('Missing', 'warning')),
        h('td', {}, c.can.edit ? button('', { size: 'sm', variant: 'ghost', iconName: 'trash-2', ariaLabel: 'Remove line', onClick: async () => { await api(`/api/expenses/${c.id}/lines/${l.id}/delete`, { method: 'POST' }); refresh(); } }) : null)))),
      h('tfoot', {}, h('tr', {}, h('th', { colspan: 5, scope: 'row' }, 'Total reimbursable'), h('td', { class: 'num' }, h('strong', {}, money(c.total_x100, c.currency))), h('td', { colspan: 2 }))))) : emptyState({ iconName: 'receipt', title: 'No expenses on this claim yet' });
    const add = c.can.edit ? lineForm(c, refresh) : null;
    close = openDrawer({ title: c.title, iconName: 'receipt', body: h('div', { class: 'stack' },
      h('div', { class: 'project-meta' }, badge(...(STATUS[c.status] || [c.status, 'neutral'])), h('span', { class: 'muted' }, c.employee), c.approver ? h('span', { class: 'muted' }, `Approver: ${c.approver}`) : null,
        c.period_from ? h('span', { class: 'muted' }, `${fmt(c.period_from)} – ${fmt(c.period_to)}`) : null),
      c.decision_note ? h('p', { class: 'callout' }, h('strong', {}, `${c.decided_by_name || 'Approver'}: `), c.decision_note) : null,
      lines, add),
    footer: () => [
      c.can.edit ? button('Delete draft', { variant: 'ghost', iconName: 'trash-2', onClick: async () => { if (await confirmModal({ title: 'Delete this draft claim?', confirmLabel: 'Delete', tone: 'danger' })) { await api(`/api/expenses/${c.id}/delete`, { method: 'POST' }); close(); draw(); } } }) : null,
      c.can.edit ? button('Submit for approval', { variant: 'primary', iconName: 'send', onClick: async () => { try { await api(`/api/expenses/${c.id}/submit`, { method: 'POST' }); toast('Submitted for approval'); close(); draw(); } catch (e) { toast(e.message, 'danger'); } } }) : null,
      c.can.decide ? button('Return to employee', { iconName: 'rotate-ccw', onClick: async () => { const note = await promptModal({ title: 'Return the claim', label: 'What needs to change?', confirmLabel: 'Return' }); if (note) { await api(`/api/expenses/${c.id}/decide`, { method: 'POST', body: { decision: 'reject', note } }); toast('Returned'); close(); draw(); } } }) : null,
      c.can.decide ? button('Approve', { variant: 'primary', iconName: 'check', onClick: async () => { await api(`/api/expenses/${c.id}/decide`, { method: 'POST', body: { decision: 'approve' } }); toast('Approved — regular and fair business'); close(); draw(); } }) : null,
      c.can.pay ? button('Mark paid', { variant: 'primary', iconName: 'check', onClick: async () => { await api(`/api/expenses/${c.id}/paid`, { method: 'POST' }); toast('Marked paid'); close(); draw(); } }) : null,
    ].filter(Boolean) });
  }

  function uploader(c, l, done) {
    const inp = h('input', { type: 'file', accept: 'application/pdf,image/png,image/jpeg,image/webp', class: 'visually-hidden', id: `rc-${l.id}`, onchange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { await api(`/api/expenses/${c.id}/lines/${l.id}/receipt?name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f }); toast('Receipt attached'); done(); } catch (err) { toast(err.message, 'danger'); }
    } });
    return h('span', {}, inp, h('label', { for: `rc-${l.id}`, class: 'btn btn-secondary btn-sm' }, icon('paperclip'), h('span', {}, 'Upload')));
  }

  function lineForm(c, done) {
    const id = (k) => `ex-${k}`;
    const date = input({ id: id('date'), type: 'date', max: new Date().toISOString().slice(0, 10) });
    const cat = select([['', 'Choose…'], ...meta.categories.map((x) => [x, x])], { id: id('cat') });
    const desc = input({ id: id('desc'), placeholder: 'e.g. Taxi to client workshop' });
    const prj = select([['', 'No project / internal'], ...projects.filter((p) => p.kind !== 'initiative').map((p) => [p.id, p.name])], { id: id('prj') });
    const charge = h('input', { type: 'checkbox', id: id('chg') });
    const amt = input({ id: id('amt'), type: 'number', min: 0.01, step: 0.01, inputmode: 'decimal' });
    const cur = select(meta.currencies.map((x) => [x, x]), { id: id('cur') }); cur.value = c.currency;
    const rate = input({ id: id('rate'), value: '1', inputmode: 'decimal' });
    const rateWrap = field({ label: `Exchange rate to ${c.currency}`, id: id('rate'), control: rate, help: 'Rate on the receipt date' }); rateWrap.hidden = true;
    cur.onchange = () => { rateWrap.hidden = cur.value === c.currency; if (cur.value === c.currency) rate.value = '1'; };
    const file = h('input', { type: 'file', id: id('file'), accept: 'application/pdf,image/png,image/jpeg,image/webp' });
    return h('form', { class: 'stack carry', onsubmit: (e) => e.preventDefault() }, h('h3', { class: 'kv-head' }, 'Add an expense'),
      h('div', { class: 'form-grid' }, field({ label: 'Date', id: id('date'), control: date, required: true }), field({ label: 'Expense type', id: id('cat'), control: cat, required: true }),
        field({ label: 'Justification', id: id('desc'), control: desc, required: true }), field({ label: 'Project', id: id('prj'), control: prj }),
        field({ label: 'Receipt amount', id: id('amt'), control: amt, required: true }), field({ label: 'Receipt currency', id: id('cur'), control: cur }), rateWrap,
        field({ label: 'Receipt or invoice (PDF or photo, up to 5 MB)', id: id('file'), control: file, required: true })),
      h('label', { class: 'check-row' }, charge, 'Chargeable to the client'),
      button('Add expense', { variant: 'primary', iconName: 'plus', onClick: async () => {
        try {
          const { id: lineId } = await api(`/api/expenses/${c.id}/lines`, { method: 'POST', body: { spent_on: date.value, category: cat.value, description: desc.value, project_id: prj.value || null, chargeable: charge.checked, receipt_amount: amt.value, receipt_currency: cur.value, fx_rate: rate.value } });
          const f = file.files[0];
          if (f) await api(`/api/expenses/${c.id}/lines/${lineId}/receipt?name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f });
          toast(f ? 'Expense added' : 'Expense added — upload its receipt before submitting'); done();
        } catch (e) { toast(e.message, 'danger'); }
      } }));
  }

  async function newClaim() {
    const t = input({ id: 'nc-title', placeholder: 'e.g. Riyadh workshop trip – March' });
    const f = input({ id: 'nc-from', type: 'date' }); const to = input({ id: 'nc-to', type: 'date' });
    openDrawer({ title: 'New expense claim', iconName: 'receipt', body: h('div', { class: 'stack' }, field({ label: 'Title', id: 'nc-title', control: t, required: true }),
      h('div', { class: 'row' }, field({ label: 'Expenses from', id: 'nc-from', control: f }), field({ label: 'to', id: 'nc-to', control: to })),
      h('p', { class: 'muted' }, 'Amounts are reimbursed in JOD. Attach the receipt or invoice to every line.')),
    footer: (close) => button('Create claim', { variant: 'primary', iconName: 'plus', onClick: async () => { try { const { id } = await api('/api/expenses', { method: 'POST', body: { title: t.value, period_from: f.value || null, period_to: to.value || null } }); close(); await draw(); openClaim(id); } catch (e) { toast(e.message, 'danger'); } } }) });
  }

  async function draw() {
    const [mine, todo] = await Promise.all([api('/api/expenses?scope=mine'), api('/api/expenses?scope=approve')]);
    const all = canAll ? await api('/api/expenses?scope=all') : [];
    const tabs = filterChips([{ value: 'mine', label: 'My claims', count: mine.length }, todo.length || canAll ? { value: 'approve', label: 'To approve', count: todo.length } : null,
      canAll ? { value: 'all', label: 'All submitted', count: all.length } : null].filter(Boolean), tab, (v) => { tab = v; draw(); });
    const list = tab === 'approve' ? todo : tab === 'all' ? all : mine;
    body.replaceChildren(h('div', { class: 'toolbar' }, tabs, tab === 'mine' ? button('New claim', { variant: 'primary', iconName: 'plus', onClick: newClaim }) : null),
      list.length ? h('ul', { class: 'eng-list' }, list.map((c) => row(c, () => openClaim(c.id)))) : emptyState({ iconName: 'receipt', title: tab === 'mine' ? 'No claims yet' : 'Nothing waiting', text: tab === 'mine' ? 'Start a claim, add each expense and upload its receipt.' : null }));
  }
  await draw();
  const root = h('div', { class: 'stack' }, body); root.modern = true;
  return root;
}
