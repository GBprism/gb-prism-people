// Office expenses (kept by the office administrator) and company documents (licences, registrations
// and other government papers with expiry dates). Visible to office administrators, People Ops and partners.
import { h, icon, button, badge, card, emptyState, field, input, select, textarea, toast, confirmModal, openDrawer, statStrip } from '/ui.js';

const money = (x) => `${(x / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} JOD`;
const shift = (m, d) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + d, 1)).toISOString().slice(0, 7); };
const mLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmt = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const PAID = [['company', 'Company (bank / card)'], ['petty_cash', 'Petty cash'], ['employee', 'Employee (to reimburse)']];

function fileButton(id, label, onFile) {
  const inp = h('input', { type: 'file', id, class: 'visually-hidden', accept: 'application/pdf,image/png,image/jpeg,image/webp', onchange: (e) => e.target.files[0] && onFile(e.target.files[0]) });
  return h('span', {}, inp, h('label', { for: id, class: 'btn btn-secondary btn-sm' }, icon('paperclip'), h('span', {}, label)));
}

export async function officeScreen({ api, query = '' }) {
  let month = new URLSearchParams(query).get('m') || new Date().toISOString().slice(0, 7);
  const people = await api('/api/people').catch(() => []);
  const root = h('div', { class: 'stack' });
  const upload = async (id, f) => { try { await api(`/api/office/expenses/${id}/receipt?name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f }); toast('Receipt attached'); draw(); } catch (e) { toast(e.message, 'danger'); } };

  function edit(v, row = null) {
    const d = input({ id: 'of-date', type: 'date', value: row?.spent_on || new Date().toISOString().slice(0, 10) });
    const c = select([['', 'Choose…'], ...v.categories.map((x) => [x, x])], { id: 'of-cat' }); c.value = row?.category || '';
    const vendor = input({ id: 'of-vendor', value: row?.vendor || '', placeholder: 'e.g. JEPCO, Miyahuna, landlord' });
    const desc = input({ id: 'of-desc', value: row?.description || '', placeholder: 'e.g. Electricity bill — October' });
    const amt = input({ id: 'of-amt', type: 'number', min: 0.01, step: 0.01, inputmode: 'decimal', value: row ? (row.amount_x100 / 100).toFixed(2) : '' });
    const paid = select(PAID, { id: 'of-paid' }); paid.value = row?.paid_by || 'company';
    const file = h('input', { type: 'file', id: 'of-file', accept: 'application/pdf,image/png,image/jpeg,image/webp' });
    openDrawer({ title: row ? 'Edit office expense' : 'Add office expense', iconName: 'building-2', body: h('div', { class: 'stack' },
      h('div', { class: 'form-grid' }, field({ label: 'Date', id: 'of-date', control: d, required: true }), field({ label: 'Category', id: 'of-cat', control: c, required: true }),
        field({ label: 'Amount (JOD)', id: 'of-amt', control: amt, required: true }), field({ label: 'Paid by', id: 'of-paid', control: paid })),
      field({ label: 'Supplier', id: 'of-vendor', control: vendor }), field({ label: 'Description', id: 'of-desc', control: desc }),
      row ? null : field({ label: 'Receipt or bill (PDF or photo)', id: 'of-file', control: file })),
    footer: (close) => button('Save', { variant: 'primary', iconName: 'check', onClick: async () => {
      try {
        const body = { spent_on: d.value, category: c.value, vendor: vendor.value, description: desc.value, amount: amt.value, paid_by: paid.value };
        const { id } = row ? await api(`/api/office/expenses/${row.id}`, { method: 'PATCH', body }) : await api('/api/office/expenses', { method: 'POST', body });
        const f = file.files?.[0]; if (f) await api(`/api/office/expenses/${id}/receipt?name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f });
        toast('Saved'); close(); month = d.value.slice(0, 7); draw();
      } catch (e) { toast(e.message, 'danger'); }
    } }) });
  }

  function assign(v) {
    const chosen = new Set(v.admins.map((a) => a.id));
    openDrawer({ title: 'Who keeps the office records', iconName: 'user-check', body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'They can add office expenses and company documents. Partners and People Ops always can.'),
      h('ul', { class: 'check-list' }, people.map((p) => h('li', {}, h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: chosen.has(p.id), onchange: (e) => (e.target.checked ? chosen.add(p.id) : chosen.delete(p.id)) }), p.name))))),
    footer: (close) => button('Save', { variant: 'primary', iconName: 'check', onClick: async () => { await api('/api/office/admins', { method: 'POST', body: { userIds: [...chosen] } }); toast('Saved'); close(); draw(); } }) });
  }

  async function draw() {
    const v = await api(`/api/office?month=${month}`);
    const yearTotal = v.byMonth.reduce((s, m) => s + m.total_x100, 0);
    const max = Math.max(1, ...v.byCategory.map((c) => c.total_x100));
    root.replaceChildren(
      h('div', { class: 'toolbar' }, h('div', { class: 'row' }, button('', { iconName: 'chevron-left', ariaLabel: 'Previous month', onClick: () => { month = shift(month, -1); draw(); } }),
        h('strong', { class: 'month-label' }, mLabel(month)), button('', { iconName: 'chevron-right', ariaLabel: 'Next month', onClick: () => { month = shift(month, 1); draw(); } })),
      h('div', { class: 'row' }, v.canAssign ? button(`Kept by: ${v.admins.map((a) => a.name).join(', ') || 'nobody yet'}`, { iconName: 'user-check', onClick: () => assign(v) }) : h('span', { class: 'muted' }, `Kept by ${v.admins.map((a) => a.name).join(', ') || 'People Ops'}`),
        h('a', { class: 'btn btn-secondary', href: `/api/office/csv/${v.year}` }, icon('download'), h('span', {}, `${v.year} (CSV)`)), button('Add expense', { variant: 'primary', iconName: 'plus', onClick: () => edit(v) }))),
      statStrip([{ iconName: 'receipt', value: money(v.total_x100), label: `spent in ${mLabel(month)}` }, { iconName: 'calendar-days', value: money(yearTotal), label: `spent in ${v.year}` },
        { iconName: 'paperclip', value: String(v.rows.filter((r) => !r.receipt_file_id).length), label: 'without a receipt this month' }]),
      card({ title: `Expenses — ${mLabel(month)}`, iconName: 'receipt', body: v.rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data compact' },
        h('thead', {}, h('tr', {}, ['Date', 'Category', 'Supplier / description', 'Amount', 'Paid by', 'Receipt', ''].map((t) => h('th', { scope: 'col', class: t === 'Amount' ? 'num' : null }, t)))),
        h('tbody', {}, v.rows.map((r) => h('tr', {}, h('td', {}, fmt(r.spent_on)), h('td', {}, r.category), h('td', {}, [r.vendor, r.description].filter(Boolean).join(' — ') || '—'),
          h('td', { class: 'num' }, money(r.amount_x100)), h('td', {}, PAID.find(([k]) => k === r.paid_by)?.[1] || r.paid_by),
          h('td', {}, r.receipt_file_id ? h('a', { href: `/api/office/expenses/${r.id}/receipt`, target: '_blank', rel: 'noopener' }, icon('paperclip'), ' View') : fileButton(`ofr-${r.id}`, 'Upload', (f) => upload(r.id, f))),
          h('td', {}, button('', { size: 'sm', variant: 'ghost', iconName: 'pencil', ariaLabel: 'Edit', onClick: () => edit(v, r) }),
            button('', { size: 'sm', variant: 'ghost', iconName: 'trash-2', ariaLabel: 'Delete', onClick: async () => { if (await confirmModal({ title: 'Delete this expense?', confirmLabel: 'Delete', tone: 'danger' })) { await api(`/api/office/expenses/${r.id}/delete`, { method: 'POST' }); draw(); } } })))))))
        : emptyState({ iconName: 'receipt', title: 'Nothing recorded this month', text: 'Add rent, bills, kitchen and office supplies as they are paid.' }) }),
      card({ title: `By category — ${v.year}`, iconName: 'gauge', body: v.byCategory.length ? h('ul', { class: 'eng-list' }, v.byCategory.map((c) => h('li', { class: 'kpi-row' },
        h('div', { class: 'stack' }, h('strong', {}, c.category), h('div', { class: 'progress', role: 'img', 'aria-label': `${Math.round((c.total_x100 / max) * 100)}% of the largest category` }, h('span', { 'data-w': String(Math.round((c.total_x100 / max) * 100)) }))),
        h('span', {}, `${money(c.total_x100)} · ${c.n} item${c.n === 1 ? '' : 's'}`)))) : emptyState({ iconName: 'gauge', title: 'No costs this year yet' }) }));
    root.querySelectorAll('.progress > span[data-w]').forEach((s) => { s.style.inlineSize = `${s.dataset.w}%`; });
  }
  await draw(); root.modern = true;
  return root;
}

const DSTATUS = { expired: ['Expired', 'danger'], expiring: ['Renew soon', 'warning'], valid: ['Valid', 'success'], no_expiry: ['No expiry', 'neutral'] };
export async function documentsScreen({ api }) {
  const people = await api('/api/people').catch(() => []);
  const root = h('div', { class: 'stack' });
  function edit(v, d = null) {
    const kind = select([['', 'Choose…'], ...v.kinds.map((k) => [k, k])], { id: 'dc-kind' }); kind.value = d?.kind || '';
    const title = input({ id: 'dc-title', value: d?.title || '', placeholder: 'e.g. Professional licence 2026' });
    const num = input({ id: 'dc-num', value: d?.number || '' }); const issuer = input({ id: 'dc-issuer', value: d?.issuer || '', placeholder: 'e.g. Greater Amman Municipality' });
    const iss = input({ id: 'dc-iss', type: 'date', value: d?.issued_on || '' }); const exp = input({ id: 'dc-exp', type: 'date', value: d?.expires_on || '' });
    const owner = select([['', 'Nobody yet'], ...people.map((p) => [p.id, p.name])], { id: 'dc-owner' }); owner.value = d?.renewal_owner_id || '';
    const drive = input({ id: 'dc-drive', type: 'url', value: d?.drive_url || '', placeholder: 'https://drive.google.com/…' });
    const notes = textarea({ id: 'dc-notes', rows: 3 }, d?.notes || '');
    const file = h('input', { type: 'file', id: 'dc-file', accept: 'application/pdf,image/png,image/jpeg,image/webp' });
    openDrawer({ title: d ? d.title : 'Add a company document', iconName: 'file-check-2', body: h('div', { class: 'stack' },
      field({ label: 'Type', id: 'dc-kind', control: kind, required: true }), field({ label: 'Title', id: 'dc-title', control: title }),
      h('div', { class: 'form-grid' }, field({ label: 'Number', id: 'dc-num', control: num }), field({ label: 'Issued by', id: 'dc-issuer', control: issuer }),
        field({ label: 'Issued on', id: 'dc-iss', control: iss }), field({ label: 'Expires on', id: 'dc-exp', control: exp, help: `Reminders start ${v.warn_days} days before` })),
      field({ label: 'Who renews it', id: 'dc-owner', control: owner }), field({ label: 'Drive link (optional)', id: 'dc-drive', control: drive }),
      field({ label: 'Scan (PDF or photo, up to 10 MB)', id: 'dc-file', control: file }), field({ label: 'Notes', id: 'dc-notes', control: notes })),
    footer: (close) => [d ? button('Archive', { variant: 'ghost', iconName: 'trash-2', onClick: async () => { if (await confirmModal({ title: 'Archive this document?', text: 'Use this when it is replaced by a new one.', confirmLabel: 'Archive' })) { await api(`/api/documents/${d.id}/archive`, { method: 'POST' }); close(); draw(); } } }) : null,
      button('Save', { variant: 'primary', iconName: 'check', onClick: async () => {
        try {
          const body = { kind: kind.value, title: title.value, number: num.value, issuer: issuer.value, issued_on: iss.value || null, expires_on: exp.value || null, renewal_owner_id: owner.value || null, drive_url: drive.value, notes: notes.value };
          const { id } = d ? await api(`/api/documents/${d.id}`, { method: 'PATCH', body }) : await api('/api/documents', { method: 'POST', body });
          const f = file.files?.[0]; if (f) await api(`/api/documents/${id}/file?name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f });
          toast('Saved'); close(); draw();
        } catch (e) { toast(e.message, 'danger'); }
      } })].filter(Boolean) });
  }
  async function draw() {
    const v = await api('/api/documents');
    const n = (s) => v.docs.filter((d) => d.status === s).length;
    root.replaceChildren(
      h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, 'Licences, registrations and other government papers. Expired and soon-to-expire documents appear in the inbox of whoever keeps the records.'),
        button('Add document', { variant: 'primary', iconName: 'plus', onClick: () => edit(v) })),
      statStrip([{ iconName: 'file-check-2', value: String(v.docs.length), label: 'documents on file' }, { iconName: 'triangle-alert', value: String(n('expiring')), label: `expiring within ${v.warn_days} days` },
        { iconName: 'circle-x', value: String(n('expired')), label: 'expired' }]),
      v.docs.length ? h('ul', { class: 'eng-list' }, v.docs.map((d) => h('li', { class: 'eng-item' },
        h('div', { class: 'eng-main' }, h('div', { class: 'eng-title' }, h('button', { type: 'button', class: 'link-btn', onclick: () => edit(v, d) }, h('strong', {}, d.title)), h('span', { class: 'muted' }, ` — ${d.kind}`)),
          h('div', { class: 'eng-meta muted' }, d.number ? h('span', {}, icon('hash'), ' ', d.number) : null, d.issuer ? h('span', {}, icon('building-2'), ' ', d.issuer) : null,
            h('span', {}, icon('calendar-days'), ` ${d.issued_on ? fmt(d.issued_on) : '—'} → ${d.expires_on ? fmt(d.expires_on) : 'no expiry'}`), d.renewal_owner ? h('span', {}, icon('user'), ' ', d.renewal_owner) : null),
          d.notes ? h('p', { class: 'eng-scope' }, d.notes) : null),
        h('div', { class: 'eng-side' }, badge(...DSTATUS[d.status]), d.file_id ? h('a', { class: 'btn btn-secondary btn-sm', href: `/api/documents/${d.id}/file`, target: '_blank', rel: 'noopener' }, icon('eye'), h('span', {}, 'Scan')) : null,
          d.drive_url ? h('a', { class: 'btn btn-ghost btn-sm', href: d.drive_url, target: '_blank', rel: 'noopener' }, icon('folder-open'), h('span', {}, 'Drive')) : null))))
        : emptyState({ iconName: 'file-check-2', title: 'No documents yet', text: 'Start with the commercial registration and the professional licence.' }));
  }
  await draw(); root.modern = true;
  return root;
}
