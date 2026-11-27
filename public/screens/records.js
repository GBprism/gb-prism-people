// Admin → Employee records: the HR master file (admin only). Employee's own form: My Growth → My record.
import { h, icon, button, badge, emptyState, field, input, select, textarea, toast, openDrawer, promptModal, banner, dataTable } from '/ui.js';

const GROUPS = ['Job', 'Pay', 'Personal', 'Identity', 'Education', 'Contact', 'Bank'];
const REQ = { requested: ['Asked — waiting', 'warning'], submitted: ['Sent — to review', 'info'], returned: ['Returned for correction', 'danger'], applied: ['Applied', 'success'], cancelled: ['Cancelled', 'neutral'] };
const fmt = (s) => (s ? new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

function control(f, value, { readonly } = {}) {
  const id = `hr-${f.key}`;
  if (f.options) { const s = select([['', '—'], ...f.options.map((o) => [o, o])], { id, disabled: readonly || null }); s.value = value ?? ''; return s; }
  if (f.key === 'certificates' || f.key === 'address') return textarea({ id, rows: 2, dir: f.dir || null, readonly: readonly || null }, value ?? '');
  return input({ id, value: value ?? '', dir: f.dir || null, readonly: readonly || null, inputmode: f.type === 'money' ? 'decimal' : f.type === 'phone' ? 'tel' : null,
    type: f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text', autocomplete: 'off', placeholder: f.type === 'iban' ? 'JO94 CBJO 0010 …' : f.type === 'phone' ? '+962 7…' : null });
}

export async function recordsScreen({ api, query = '' }) {
  const root = h('div', { class: 'stack' });
  let v;
  async function draw() {
    v = await api('/api/hr-records');
    const missing = v.rows.filter((r) => !r.has_record).length;
    const table = dataTable({ compact: true, rows: v.rows, rowKey: (r) => r.user_id, onRowClick: (r) => openRecord(r.user_id), columns: [
      { key: 'code', label: 'Code', render: (r) => r.code || h('span', { class: 'muted' }, '—') },
      { key: 'name', label: 'Name', render: (r) => h('button', { type: 'button', class: 'link-btn', onclick: (e) => { e.stopPropagation(); openRecord(r.user_id); } }, r.name) },
      { key: 'title', label: 'Title' }, { key: 'grade', label: 'Grade', render: (r) => r.grade || '—' },
      { key: 'joining_date', label: 'Joined', render: (r) => fmt(r.joining_date) },
      { key: 'complete', label: 'Complete', num: true, render: (r) => `${r.complete}%` },
      { key: 'request', label: 'Employee details', render: (r) => (r.request ? badge(...(REQ[r.request.status] || [r.request.status, 'neutral'])) : r.missing_employee ? h('span', { class: 'muted' }, `${r.missing_employee} to collect`) : badge('Complete', 'success')) }] });
    root.replaceChildren(
      banner({ tone: 'info', title: 'Admin only', text: 'Only people with the admin role can open these records — not partners, People Ops or managers. Pay, ID numbers and bank details are encrypted on the server, and every view, change and export is logged.' }),
      v.locked ? banner({ tone: 'danger', title: 'Locked', text: 'The server has no HR_DATA_KEY yet, so records cannot be opened or saved. See the setup steps.' }) : null,
      h('div', { class: 'toolbar' },
        button('Ask employees for their details', { variant: 'primary', iconName: 'send', onClick: askEmployees }),
        missing ? button(`Create ${missing} record${missing === 1 ? '' : 's'} from GB People`, { iconName: 'plus', onClick: async () => { const r = await api('/api/hr-records/prefill', { method: 'POST' }); toast(`${r.created} records created`); draw(); } }) : null,
        h('a', { class: 'btn btn-secondary', href: '/api/hr-records/export' }, icon('download'), h('span', {}, 'Download Excel'))),
      v.rows.some((r) => r.has_record) ? h('section', { class: 'card' }, h('div', { class: 'card-body flush' }, table))
        : emptyState({ iconName: 'contact', title: 'No employee records yet', text: 'Create them from what GB People already knows: names, titles in English and Arabic, departments, joining and probation dates, birth dates, education and certificates, and a proposed grade.' }));
  }

  function askEmployees() {
    const picks = new Set(v.rows.filter((r) => r.missing_employee && !['requested', 'submitted'].includes(r.request?.status)).map((r) => r.user_id));
    const list = h('ul', { class: 'check-list' }, v.rows.map((r) => h('li', {}, h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: picks.has(r.user_id), onchange: (e) => (e.target.checked ? picks.add(r.user_id) : picks.delete(r.user_id)) }),
      r.name, r.request ? h('span', { class: 'muted' }, ` · ${REQ[r.request.status]?.[0] || r.request.status}`) : r.missing_employee ? h('span', { class: 'muted' }, ` · ${r.missing_employee} to collect`) : null))));
    openDrawer({ title: 'Ask employees for their details', iconName: 'send', body: h('div', { class: 'stack' },
      h('p', {}, 'Each person gets an email and a task on their Home: “Complete your employee record”. They see and fill only their personal details — name in Arabic, birth date, gender, nationality, religion, marital status, national, social security and passport numbers, education, address and contacts, emergency contact, bank and IBAN. They never see pay or grade.'),
      h('p', { class: 'muted' }, 'What they send waits for you to check and apply.'), list),
    footer: (close) => button('Send the request', { variant: 'primary', iconName: 'send', onClick: async () => { if (!picks.size) return toast('Choose at least one person', 'danger'); const r = await api('/api/hr-records/requests', { method: 'POST', body: { userIds: [...picks] } }); toast(`Asked ${r.asked} ${r.asked === 1 ? 'person' : 'people'}`); close(); draw(); } }) });
  }

  async function openRecord(userId) {
    history.replaceState(null, '', `#/admin/records?u=${userId}`);
    const r = await api(`/api/hr-records/${userId}`);
    const d = { ...(r.suggested || {}), ...r.data };
    const ctrls = {};
    const grossEl = h('strong', {}, r.gross_salary != null ? `${r.gross_salary.toFixed(3)} JOD` : '—');
    const recalc = () => { const n = (k) => Number(ctrls[k].value.replace(/,/g, '')) || 0; const any = ['basic_salary', 'mobile_allowance', 'transport_allowance'].some((k) => ctrls[k].value.trim()); grossEl.textContent = any ? `${(n('basic_salary') + n('mobile_allowance') + n('transport_allowance')).toFixed(3)} JOD` : '—'; };
    const sections = GROUPS.map((g) => h('fieldset', { class: 'hr-group' }, h('legend', {}, g === 'Job' ? 'Job' : g),
      h('div', { class: 'form-grid' }, r.fields.filter((f) => f.group === g).map((f) => {
        const c = control(f, d[f.key]); ctrls[f.key] = c;
        if (f.group === 'Pay') c.addEventListener('input', recalc);
        return field({ label: f.label, id: `hr-${f.key}`, control: c, help: r.sources[f.key] ? `From ${r.sources[f.key]}` : r.suggested?.[f.key] ? 'Suggested from GB People — saved when you save' : f.who === 'employee' ? 'Ask the employee' : null });
      }),
      g === 'Job' ? [field({ label: 'Direct manager title', id: 'hr-mt', control: input({ id: 'hr-mt', value: r.manager.title || '', readonly: true }), help: 'From the org chart (Roster)' }),
        field({ label: 'Direct manager name', id: 'hr-mn', control: input({ id: 'hr-mn', value: r.manager.name || '', readonly: true }), help: 'From the org chart (Roster)' })] : null,
      g === 'Pay' ? h('div', { class: 'gross' }, h('span', { class: 'muted' }, 'Gross salary'), grossEl) : null)));
    const sent = r.submitted ? (() => {
      const take = {};
      const rows = Object.entries(r.submitted.data).filter(([, val]) => val != null).map(([k, val]) => { take[k] = true; const f = r.fields.find((x) => x.key === k);
        return h('li', { class: 'check-row' }, h('input', { type: 'checkbox', checked: true, 'aria-label': `Apply ${f?.label}`, onchange: (e) => { take[k] = e.target.checked; } }),
          h('span', {}, h('strong', {}, f?.label || k), ': ', h('span', { dir: f?.dir || null }, String(val)), r.data[k] != null && r.data[k] !== val ? h('span', { class: 'muted' }, ` (was ${r.data[k]})`) : null)); });
      return h('section', { class: 'review-box' }, h('strong', {}, `${r.user.name} sent their details on ${fmt(r.submitted.at)}`), h('ul', { class: 'check-list' }, rows),
        h('div', { class: 'row' }, button('Apply the ticked details', { variant: 'primary', iconName: 'check', onClick: async () => { await api(`/api/hr-records/requests/${r.submitted.id}/decide`, { method: 'POST', body: { decision: 'apply', values: take } }); toast('Applied'); close(); await draw(); openRecord(userId); } }),
          button('Return for correction', { iconName: 'rotate-ccw', onClick: async () => { const note = await promptModal({ title: 'What needs correcting?', label: 'Note to the employee' }); if (!note) return; await api(`/api/hr-records/requests/${r.submitted.id}/decide`, { method: 'POST', body: { decision: 'return', note } }); toast('Returned'); close(); draw(); } })));
    })() : null;
    const close = openDrawer({ title: `${r.user.name}${d.employee_code ? ` · ${d.employee_code}` : ''}`, iconName: 'contact', body: h('div', { class: 'stack' }, sent, ...sections),
      footer: (c) => button('Save record', { variant: 'primary', iconName: 'check', onClick: async () => {
        const patch = {}; for (const f of r.fields) { const val = ctrls[f.key].value; if ((val || null) !== (r.data[f.key] != null ? String(r.data[f.key]) : null)) patch[f.key] = val; }
        try { await api(`/api/hr-records/${userId}`, { method: 'PATCH', body: patch }); toast('Record saved'); c(); draw(); } catch (e) { toast(e.message, 'danger'); }
      } }) });
    document.querySelector('.drawer')?.classList.add('card-drawer');
  }

  await draw();
  const u = new URLSearchParams(query).get('u'); if (u) setTimeout(() => openRecord(u), 0);
  root.modern = true;
  return root;
}

export async function myRecordScreen({ api }) {
  const v = await api('/api/my-record');
  const ctrls = {};
  const st = v.request?.status;
  const groups = [...new Set(v.fields.map((f) => f.group))];
  const form = groups.map((g) => h('fieldset', { class: 'hr-group' }, h('legend', {}, g), h('div', { class: 'form-grid' }, v.fields.filter((f) => f.group === g).map((f) => { const c = control(f, v.values[f.key]); ctrls[f.key] = c; return field({ label: f.label, id: `hr-${f.key}`, control: c }); }))));
  const root = h('div', { class: 'stack' },
    st === 'returned' ? banner({ tone: 'warning', title: 'Please correct your record', text: v.request.note }) : st === 'submitted' ? banner({ tone: 'success', title: 'Sent to the admin', text: 'Thank you. The admin checks and applies your details. You can still correct them and send again.' })
      : st === 'requested' ? banner({ tone: 'info', title: 'The admin asked you to complete your employee record', text: 'Fill in what applies to you and send it. Fields you leave empty stay empty.' }) : null,
    h('p', { class: 'muted' }, icon('lock'), ' Only the GB admin can see these details. They are encrypted on the server and are not visible to your manager, colleagues or partners.'),
    h('dl', { class: 'proj-facts' }, h('div', {}, h('dt', {}, 'Employee code'), h('dd', {}, v.code || 'Not assigned yet')), h('div', {}, h('dt', {}, 'Name'), h('dd', {}, v.name_en)), h('div', {}, h('dt', {}, 'Title'), h('dd', {}, v.title_en || '—'))),
    ...form,
    h('div', { class: 'row' }, button('Send to the admin', { variant: 'primary', iconName: 'send', onClick: async () => {
      const values = Object.fromEntries(Object.entries(ctrls).map(([k, c]) => [k, c.value]));
      try { await api('/api/my-record', { method: 'POST', body: { values } }); toast('Sent to the admin'); dispatchEvent(new HashChangeEvent('hashchange')); } catch (e) { toast(e.message, 'danger'); }
    } })));
  root.modern = true;
  return root;
}
