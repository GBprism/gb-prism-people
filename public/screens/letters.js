// Letters and requests: anyone asks for an experience letter, internship letter or another letter;
// People Ops checks the facts, prints it on GB letterhead (or saves as PDF) and marks it issued.
// Pay fields, if a template has any, are typed at print time and never saved.
import { h, icon, button, badge, card, emptyState, field, input, select, textarea, toast, promptModal, openDrawer } from '/ui.js';

const KINDS = [['experience_letter', 'Experience letter'], ['internship_letter', 'Internship completion letter'], ['employment_certificate', 'Employment certificate (to whom it may concern)'], ['other', 'Other letter or HR request']];
const kindLabel = (k) => KINDS.find(([v]) => v === k)?.[1] || k;
const STATUS = { requested: ['Requested', 'info'], issued: ['Issued', 'success'], rejected: ['Declined', 'danger'], cancelled: ['Cancelled', 'neutral'] };
const fmt = (s) => (s ? new Date(s.length === 10 ? `${s}T00:00:00` : s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const PAY = /salary|pay|allowance|compensation|amount/i;

export async function lettersScreen({ api }) {
  const body = h('div', { class: 'stack' });
  const printArea = h('div', { class: 'print-area', 'aria-hidden': 'true' });

  const row = (r, ops) => h('li', { class: 'eng-item' },
    h('div', { class: 'eng-main' }, h('strong', {}, kindLabel(r.kind)), h('div', { class: 'eng-meta muted' }, ops ? h('span', {}, icon('user'), ' ', r.employee) : null,
      h('span', {}, `For: ${r.addressee || 'To whom it may concern'}`), r.needed_by ? h('span', {}, `Needed by ${fmt(r.needed_by)}`) : null, h('span', {}, `Asked ${fmt(r.created_at)}`)),
      r.purpose ? h('p', { class: 'eng-scope' }, r.purpose) : null, r.note ? h('p', { class: 'eng-scope muted' }, r.note) : null),
    h('div', { class: 'eng-side' }, badge(...(STATUS[r.status] || [r.status, 'neutral'])),
      ops && r.status === 'requested' ? button('Prepare', { size: 'sm', variant: 'primary', iconName: 'printer', onClick: () => prepare(r.id) }) : null,
      !ops && r.status === 'requested' ? button('Cancel', { size: 'sm', variant: 'ghost', onClick: async () => { await api(`/api/letters/${r.id}/cancel`, { method: 'POST' }); draw(); } }) : null));

  function requestForm(templates) {
    const kind = select(KINDS, { id: 'lr-kind' }); const to = input({ id: 'lr-to', placeholder: 'To whom it may concern' });
    const why = textarea({ id: 'lr-why', rows: 2, placeholder: 'e.g. for a visa application at the UK embassy' }); const by = input({ id: 'lr-by', type: 'date' });
    const lang = select([['en', 'English'], ['ar', 'Arabic']], { id: 'lr-lang' });
    return card({ title: 'Ask for a letter', iconName: 'mail-check', body: h('form', { class: 'stack', onsubmit: (e) => e.preventDefault() },
      h('div', { class: 'form-grid' }, field({ label: 'Letter', id: 'lr-kind', control: kind }), field({ label: 'Addressed to', id: 'lr-to', control: to }),
        field({ label: 'Language', id: 'lr-lang', control: lang }), field({ label: 'Needed by', id: 'lr-by', control: by })),
      field({ label: 'What is it for?', id: 'lr-why', control: why, help: templates.length ? `Templates on file: ${templates.map((t) => t.title).join(', ')}.` : null }),
      button('Send request', { variant: 'primary', iconName: 'send', onClick: async () => {
        try { await api('/api/letters', { method: 'POST', body: { kind: kind.value, addressee: to.value, purpose: why.value, language: lang.value, needed_by: by.value || null } }); toast('Request sent to People Ops'); draw(); } catch (e) { toast(e.message, 'danger'); }
      } })) });
  }

  async function prepare(id) {
    const d = await api(`/api/letters/${id}/draft`);
    const fields = d.template?.fields || ['today', 'addressee', 'employee_name', 'title', 'join_date', 'end_date'];
    const inputs = Object.fromEntries(fields.map((f) => [f, input({ id: `lf-${f}`, value: d.known[f] ?? '', autocomplete: 'off' })]));
    const freeText = d.template ? null : textarea({ id: 'lf-body', rows: 10 }, `${d.known.today}\n\n${d.known.addressee},\n\nThis is to certify that ${d.known.employee_name} works at GB Advisory as ${d.known.title} since ${d.known.join_date}.\n\n${d.request.purpose || ''}\n\nSincerely,\n\nGhaith Al-Battikhi\nManaging Director – GB Advisory`);
    const fill = () => (d.template ? d.template.body.replace(/\{\{(\w+)\}\}/g, (_, k) => inputs[k]?.value || '') : freeText.value);
    const preview = h('div', { class: 'letter-preview' });
    const render = () => preview.replaceChildren(...fill().split('\n').map((l) => h('p', {}, l || ' ')));
    Object.values(inputs).forEach((i) => i.addEventListener('input', render)); freeText?.addEventListener('input', render); render();
    openDrawer({ title: `${kindLabel(d.request.kind)} — ${d.known.employee_name}`, iconName: 'printer', body: h('div', { class: 'stack' },
      d.request.purpose ? h('p', { class: 'callout' }, h('strong', {}, 'Request: '), d.request.purpose) : null,
      d.template?.has_compensation ? h('p', { class: 'muted' }, icon('lock'), ' Pay fields are only used for printing and are not saved.') : null,
      h('div', { class: 'form-grid' }, fields.map((f) => field({ label: f.replace(/_/g, ' ') + (PAY.test(f) ? ' (not saved)' : ''), id: `lf-${f}`, control: inputs[f] }))),
      freeText ? field({ label: 'Letter text', id: 'lf-body', control: freeText }) : null,
      h('h3', { class: 'kv-head' }, 'Preview'), preview),
    footer: (close) => [
      button('Decline', { variant: 'ghost', onClick: async () => { const note = await promptModal({ title: 'Decline this request', label: 'Reason (shown to the employee)', confirmLabel: 'Decline' }); if (note) { await api(`/api/letters/${id}/decide`, { method: 'POST', body: { decision: 'reject', note } }); close(); draw(); } } }),
      button('Print / save as PDF', { iconName: 'printer', onClick: () => {
        printArea.replaceChildren(h('img', { src: '/brand/gb-logo.png', alt: 'GB Advisory', class: 'letter-logo' }), ...fill().split('\n').map((l) => h('p', {}, l || ' ')),
          h('p', { class: 'letter-foot' }, 'GB Advisory · شركة البعد الخامس للاستشارات الادارية'));
        window.print();
      } }),
      button('Mark issued', { variant: 'primary', iconName: 'check', onClick: async () => { await api(`/api/letters/${id}/decide`, { method: 'POST', body: { decision: 'issue', fields: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value])) } }); toast('Marked issued'); close(); draw(); } }),
    ] });
  }

  async function draw() {
    const v = await api('/api/letters');
    body.replaceChildren(requestForm(v.templates),
      card({ title: 'My requests', iconName: 'inbox', body: v.mine.length ? h('ul', { class: 'eng-list' }, v.mine.map((r) => row(r, false))) : emptyState({ iconName: 'mail-check', title: 'No requests yet' }) }),
      v.canIssue ? card({ title: 'Requests to handle', iconName: 'user-check', actions: badge(`${v.queue.filter((r) => r.status === 'requested').length} open`, 'info'),
        body: v.queue.length ? h('ul', { class: 'eng-list' }, v.queue.map((r) => row(r, true))) : emptyState({ iconName: 'inbox', title: 'Nothing to handle' }) }) : null);
  }
  await draw();
  const root = h('div', { class: 'stack' }, body, printArea); root.modern = true;
  return root;
}
