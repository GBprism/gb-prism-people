// Admin → Imports: Upload → Check format → Review & fix → Import.
// Uses only existing endpoints (preview, apply, reverse, opening balances, reconcile).
import { h, icon, button, badge, card, statStrip, banner, emptyState, field, select, input, dataTable, stepper, confirmModal, toast } from '/ui.js';

const STEPS = [{ label: 'Upload' }, { label: 'Check format' }, { label: 'Review & fix' }, { label: 'Import' }];
const MAX_MB = 10;
const SOURCES = [
  { id: 'gb-forms', iconName: 'clipboard-check', title: 'PMS evaluation forms', text: 'GB 2026 Employee Evaluation Form workbooks — select several at once', multi: true },
  { id: 'leaveboard', iconName: 'calendar-days', title: 'LeaveBoard export', text: 'General Situation, Annual Situation, Attendance or Leaves report' },
  { id: 'pms-plans', iconName: 'list-checks', title: 'PMS plan items', text: 'One row per objective or competency', template: '/templates/pms-plan-items-template.xlsx' },
  { id: 'pms-history', iconName: 'history', title: 'PMS history summary', text: 'A past team summary sheet (e.g. 2025)', template: '/templates/pms-history-summary-template.xlsx' },
];
const KIND_LABEL = { pms_gb_form: 'PMS forms', pms_plans: 'PMS plan items', pms_history: 'PMS history', leaveboard_general_situation: 'LeaveBoard · General Situation', leaveboard_annual_situation: 'LeaveBoard · Annual Situation', leaveboard_attendance: 'LeaveBoard · Attendance', leaveboard_leaves: 'LeaveBoard · Leaves' };
const STATUS_TONE = { previewed: ['Ready to import', 'warning', 'clock'], applied: ['Imported', 'success'], reversed: ['Reversed', 'neutral', 'rotate-ccw'], rejected: ['Rejected', 'danger'] };
const fmt = (s) => (s ? new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/** Guess the source from file names so most uploads need no choice. */
export function guessSource(files) {
  const names = files.map((f) => f.name.toLowerCase());
  if (names.length > 1 || names.some((n) => /pms.*form|eval/.test(n))) return 'gb-forms';
  if (names.some((n) => /situation|attendance|leaves/.test(n))) return 'leaveboard';
  if (names.some((n) => /history|summary/.test(n))) return 'pms-history';
  if (names.some((n) => /plan/.test(n))) return 'pms-plans';
  return null;
}

export async function importsScreen({ api, toBase64, render }) {
  const [batches, cycles] = await Promise.all([api('/api/imports'), api('/api/cycles')]);
  const openCycle = cycles.find((c) => c.status === 'open') || cycles[0];
  const st = { step: 0, files: [], source: null, cycleId: openCycle?.id, from: '', to: '', year: String((openCycle?.year || new Date().getFullYear()) - 1), batch: null, result: null };
  const root = h('div', { class: 'imports' });
  const draw = () => root.replaceChildren(stepper(STEPS, st.step), ...[viewUpload, viewCheck, viewReview, viewDone][st.step]().filter(Boolean));
  const go = (step) => { st.step = step; draw(); root.querySelector('.stepper')?.scrollIntoView({ block: 'nearest' }); };

  // ------------------------------------------------------------ 1 Upload --
  function viewUpload() {
    const fileInput = h('input', { type: 'file', accept: '.xlsx', multiple: true, class: 'sr-only', id: 'imp-file', onchange: (e) => take([...e.target.files]) });
    const zone = h('label', { class: 'dropzone', for: 'imp-file', tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } } },
      h('span', { class: 'dropzone-icon' }, icon('cloud-upload', { size: 'xl' })),
      h('strong', {}, 'Drag Excel files here, or click to choose'),
      h('span', { class: 'muted' }, `.xlsx · up to ${MAX_MB} MB per file · PMS forms can be selected together`), fileInput);
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('is-over'); take([...e.dataTransfer.files]); });
    const errorBox = h('div', { 'aria-live': 'polite' });
    function take(files) {
      const bad = files.filter((f) => !/\.xlsx$/i.test(f.name) || f.size > MAX_MB * 1024 * 1024);
      if (!files.length) return;
      if (bad.length) { errorBox.replaceChildren(banner({ tone: 'danger', title: 'Some files can’t be used', text: `${bad.map((f) => f.name).join(', ')} — only .xlsx files up to ${MAX_MB} MB.` })); return; }
      st.files = files; st.source = guessSource(files); st.batch = null; st.result = null;
      if (st.source === 'leaveboard' && files.some((f) => /general-situation/i.test(f.name))) { st.from = st.from || `${new Date().getFullYear()}-01-01`; }
      go(1);
    }
    const recent = batches.length ? dataTable({ rows: batches.slice(0, 20), compact: true, onRowClick: (b) => openBatch(b.id), columns: [
      { key: 'filename', label: 'File', render: (b) => h('span', { class: 'cell-file' }, icon('file-spreadsheet'), b.filename) },
      { key: 'kind', label: 'Type', render: (b) => KIND_LABEL[b.kind] || b.kind },
      { key: 'created_by_name', label: 'By' },
      { key: 'created_at', label: 'When', render: (b) => fmt(b.created_at), sortValue: (b) => b.created_at },
      { key: 'row_count', label: 'Rows', num: true },
      { key: 'status', label: 'Status', render: (b) => { const [t, tone, ic] = STATUS_TONE[b.status] || [b.status, 'neutral']; return badge(t, tone, ic); } },
      { key: 'open', label: '', sortable: false, render: (b) => h('div', { class: 'row-actions' }, button('Open', { variant: 'ghost', size: 'sm', iconName: 'arrow-right', onClick: () => openBatch(b.id) })) }] })
      : emptyState({ iconName: 'cloud-upload', title: 'No imports yet', text: 'Upload your first file above. Nothing is saved until you review it.' });
    return [card({ body: h('div', { class: 'upload-grid' }, zone, h('div', { class: 'upload-side' },
        h('h3', {}, 'What you can import'),
        h('ul', { class: 'source-list' }, SOURCES.map((s) => h('li', {}, icon(s.iconName), h('div', {}, h('strong', {}, s.title), h('span', { class: 'muted' }, s.text),
          s.template ? h('a', { href: s.template, download: '' }, icon('download'), 'Download template') : null)))),
        h('p', { class: 'muted small-note' }, icon('shield-check'), ' Salary, bonus and personal columns are never read.'))) }),
      errorBox,
      card({ title: 'Recent imports', iconName: 'history', flush: true, body: recent })];
  }

  // ------------------------------------------------------- 2 Check format --
  function viewCheck() {
    const src = SOURCES.find((s) => s.id === st.source);
    const choice = h('div', { class: 'source-cards', role: 'radiogroup', 'aria-label': 'What are you importing?' },
      SOURCES.map((s) => h('button', { type: 'button', class: 'source-card', role: 'radio', 'aria-checked': String(s.id === st.source), onclick: () => { st.source = s.id; draw(); } },
        h('span', { class: 'source-card-icon' }, icon(s.iconName, { size: 'lg' })), h('strong', {}, s.title), h('span', { class: 'muted' }, s.text))));
    const opts = [];
    if (st.source === 'gb-forms' || st.source === 'pms-plans') {
      const sel = select(cycles.map((c) => [c.id, `${c.name}${c.status === 'open' ? ' (open)' : ''}`]), { onchange: (e) => { st.cycleId = e.target.value; } }); sel.value = st.cycleId;
      opts.push(field({ label: 'Cycle the plans belong to', id: 'imp-cycle', control: sel, help: 'Defaults to the open cycle.', required: true }));
    }
    if (st.source === 'leaveboard' && st.files.some((f) => /general-situation/i.test(f.name))) {
      opts.push(field({ label: 'Report start', id: 'imp-from', control: input({ type: 'date', value: st.from, oninput: (e) => { st.from = e.target.value; } }), help: 'The General Situation file has no date range — enter what you selected in LeaveBoard.', required: true }));
      opts.push(field({ label: 'Report end', id: 'imp-to', control: input({ type: 'date', value: st.to, oninput: (e) => { st.to = e.target.value; } }), required: true }));
    }
    if (st.source === 'pms-history') opts.push(field({ label: 'Year of the reviews', id: 'imp-year', control: input({ type: 'number', min: '2015', max: '2100', value: st.year, oninput: (e) => { st.year = e.target.value; } }), required: true }));
    const msg = h('div', { 'aria-live': 'polite' });
    const multiOk = !(st.files.length > 1 && !src?.multi);
    return [
      card({ title: `${st.files.length} file${st.files.length === 1 ? '' : 's'} selected`, iconName: 'file-spreadsheet', actions: [button('Change files', { variant: 'ghost', size: 'sm', iconName: 'pencil', onClick: () => go(0) })],
        body: h('ul', { class: 'file-chips' }, st.files.map((f) => h('li', {}, icon('file-spreadsheet'), f.name, h('span', { class: 'muted' }, `${Math.max(1, Math.round(f.size / 1024))} KB`)))) }),
      card({ title: st.source ? 'Detected format — change it if this is wrong' : 'What are you importing?', iconName: 'search', body: choice }),
      opts.length ? card({ title: 'Just these details', iconName: 'pencil', body: h('div', { class: 'form-grid' }, opts) }) : null,
      !multiOk ? banner({ tone: 'warning', title: 'One file at a time for this format', text: 'Only PMS evaluation forms can be uploaded together. Go back and choose a single file.' }) : null,
      msg,
      h('div', { class: 'step-actions' }, button('Back', { variant: 'ghost', iconName: 'chevron-left', onClick: () => go(0) }),
        button('Check file', { variant: 'primary', iconName: 'arrow-right', disabled: !st.source || !multiOk, onClick: async () => {
          msg.replaceChildren();
          if (st.source === 'leaveboard' && st.files.some((f) => /general-situation/i.test(f.name)) && (!st.from || !st.to)) { msg.replaceChildren(banner({ tone: 'warning', title: 'Add the report dates', text: 'Enter the start and end dates you selected in LeaveBoard.' })); return; }
          try { st.batch = await preview(); go(2); } catch (e) {
            // the browser could not read the chosen file: it was moved, replaced or is still open elsewhere
            const unreadable = ['NotFoundError', 'NotReadableError', 'SecurityError'].includes(e.name);
            msg.replaceChildren(banner({ tone: 'danger', title: unreadable ? 'Your browser could not read the file' : 'The file could not be checked',
              text: unreadable ? 'It changed or moved after you chose it, or it is still open in Excel. Close it, click “Change files” and choose it again from your Downloads folder.'
                : `${e.message}${e.details?.length ? ' — ' + e.details.map((d) => d.message || d).join('; ') : ''}` }));
          }
        } })),
    ];
  }

  async function preview() {
    const f = st.files[0];
    if (st.source === 'gb-forms') return api('/api/imports/gb-forms', { method: 'POST', body: { cycleId: st.cycleId, files: await Promise.all(st.files.map(async (x) => ({ filename: x.name, base64: await toBase64(x) }))) } });
    const qs = new URLSearchParams({ filename: f.name });
    if (st.source === 'pms-plans') qs.set('cycleId', st.cycleId);
    if (st.source === 'pms-history') qs.set('year', st.year);
    if (st.source === 'leaveboard' && st.from && st.to) { qs.set('from', st.from); qs.set('to', st.to); }
    return api(`/api/imports/${st.source}?${qs}`, { method: 'POST', raw: await f.arrayBuffer() });
  }

  async function openBatch(id) {
    st.batch = await api(`/api/imports/${id}`); st.files = [];
    st.result = null; go(st.batch.status === 'previewed' ? 2 : 3);
  }

  // ------------------------------------------------------- 3 Review & fix --
  const isReady = (r) => ['insert', 'update', 'unchanged'].includes(r.action);
  const needsAttention = (r) => ['reject', 'review'].includes(r.action);
  function counts(b) {
    const ready = b.rows.filter(isReady).length; const attention = b.rows.filter(needsAttention).length; const skipped = b.rows.filter((r) => r.action === 'skip').length;
    return { ready, attention, skipped, unit: b.kind === 'pms_gb_form' ? 'form' : 'row' };
  }
  function errorReport(b) {
    const esc = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [['Sheet/file', 'Row', 'Key', 'Action', 'Issues'].join(',')];
    for (const r of b.rows) if (r.issues.length || needsAttention(r)) lines.push([r.sheet, r.row_no, r.source_key, r.action, r.issues.join(' | ')].map(esc).join(','));
    const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: `${b.filename.replace(/\.xlsx$/i, '')}-error-report.csv` }); a.click();
  }
  function rowsTable(b) {
    const sorted = [...b.rows].sort((x, y) => Number(needsAttention(y)) - Number(needsAttention(x)) || (y.issues.length - x.issues.length));
    const actionBadge = (r) => (r.action === 'reject' ? badge('Not imported', 'danger') : r.action === 'review' ? badge('Needs matching', 'warning', 'user') : r.action === 'skip' ? badge('Skipped', 'neutral', 'circle-dot') : r.action === 'unchanged' ? badge('No change', 'neutral', 'check') : badge(r.action === 'update' ? 'Will update' : 'Ready', 'success'));
    const who = (r) => r.raw?.plan?.person || r.raw?.Employee || r.raw?.name || r.raw?.email || r.source_key;
    return dataTable({ rows: sorted, compact: true, rowKey: (r) => r.id, columns: [
      { key: 'action', label: 'Status', render: actionBadge, sortValue: (r) => (needsAttention(r) ? 0 : 1) },
      { key: 'who', label: b.kind === 'pms_gb_form' ? 'Form' : 'Person / key', render: (r) => h('strong', {}, String(who(r))), sortValue: who },
      { key: 'row_no', label: 'Row', num: true },
      { key: 'match_status', label: 'Matched by', render: (r) => (r.match_status === 'n/a' ? '—' : r.match_status) },
      { key: 'issues', label: 'What to fix', sortable: false, render: (r) => (r.issues.length ? h('ul', { class: 'issue-list' }, r.issues.map((i) => h('li', {}, i))) : h('span', { class: 'muted' }, '—')) }] });
  }
  function viewReview() {
    const b = st.batch; const s = b.summary || {}; const c = counts(b);
    const blocking = s.blocking || [];
    const extra = [];
    if (s.checksum) extra.push(card({ title: 'Totals check', iconName: 'calculator', flush: true, body: dataTable({ compact: true, rowKey: (r) => r.col, rows: Object.entries(s.checksum).map(([col, x]) => ({ col, ...x })), columns: [
      { key: 'col', label: 'Column' }, { key: 'rows', label: 'Sum of rows', num: true }, { key: 'source_total', label: 'Totals row', num: true },
      { key: 'ok', label: '', render: (r) => (r.ok ? badge('Reconciled', 'success') : badge('Mismatch', 'danger')) }] }) }));
    if (b.kind === 'pms_gb_form' && s.plans) extra.push(card({ title: 'Forms', iconName: 'clipboard-check', body: h('div', { class: 'form-cards' }, s.plans.map((p) => h('article', { class: 'form-card' },
      h('header', {}, h('strong', {}, p.person), h('span', { class: 'muted' }, ` · ${p.position || ''}`), p.user_id ? badge('Matched', 'success', 'user-check') : badge('Needs matching', 'warning', 'user')),
      h('p', { class: 'muted' }, `${p.items} items · weights ${Object.entries(p.category_weights).map(([k, v]) => `${k} ${v}%`).join(' · ')}`),
      [...p.blocking, ...p.issues, ...p.weight_errors].length ? h('ul', { class: 'issue-list' }, [...p.blocking, ...p.issues, ...p.weight_errors].map((x) => h('li', {}, x))) : null,
      p.formula_issues.length ? h('details', {}, h('summary', {}, `${p.formula_issues.length} spreadsheet formula problem(s) — Prism recalculates instead`), h('ul', { class: 'issue-list' }, p.formula_issues.map((x) => h('li', {}, x)))) : null))) }));
    const applied = b.status !== 'previewed';
    return [
      b.duplicateOf ? banner({ tone: 'info', title: 'This exact file was uploaded before', text: 'Showing the earlier check. Nothing new was saved.' }) : null,
      h('div', { class: 'summary-bar', role: 'status' }, icon(c.attention ? 'triangle-alert' : 'circle-check', { size: 'lg' }),
        h('span', {}, h('strong', { class: 'num' }, `${c.ready} ${c.unit}${c.ready === 1 ? '' : 's'} ready`), ' · ', h('span', { class: c.attention ? 'text-warning' : '' }, `${c.attention} need${c.attention === 1 ? 's' : ''} attention`), c.skipped ? ` · ${c.skipped} skipped (totals/blank)` : ''),
        h('span', { class: 'muted' }, `${KIND_LABEL[b.kind] || b.kind} · ${b.filename}`)),
      blocking.length ? banner({ tone: 'danger', title: 'This file can’t be imported yet', text: blocking.join(' · ') + ' — fix the export and upload it again.' }) : null,
      (s.warnings || []).length ? banner({ tone: 'info', title: 'Good to know', text: s.warnings.join(' · ') }) : null,
      (s.excluded_columns || s.excluded_fields || []).length ? banner({ tone: 'info', title: 'Ignored on purpose', text: `Never read: ${(s.excluded_columns || s.excluded_fields).join(', ')}` }) : null,
      ...extra,
      card({ title: 'Rows', iconName: 'table', flush: true, actions: [button('Download error report', { variant: 'secondary', size: 'sm', iconName: 'download', onClick: () => errorReport(b) })], body: rowsTable(b) }),
      h('div', { class: 'step-actions' },
        button('Upload a corrected file', { variant: 'ghost', iconName: 'upload', onClick: () => go(0) }),
        applied ? button('See result', { variant: 'primary', iconName: 'arrow-right', onClick: () => go(3) })
          : button(c.attention ? `Import ${c.ready} valid ${c.unit}${c.ready === 1 ? '' : 's'} only` : `Import ${c.ready} ${c.unit}${c.ready === 1 ? '' : 's'}`, { variant: 'primary', iconName: 'check', disabled: blocking.length > 0 || c.ready === 0, onClick: async () => {
            try { st.result = await api(`/api/imports/${b.id}/apply`, { method: 'POST', body: {} }); st.batch = await api(`/api/imports/${b.id}`); toast('Import finished'); go(3); }
            catch (e) { toast(e.message, 'danger'); }
          } })),
    ];
  }

  // ------------------------------------------------------------ 4 Import --
  function viewDone() {
    const b = st.batch; const r = st.result; const c = counts(b);
    const tiles = [{ iconName: 'circle-check', value: String(c.ready), label: `${c.unit}s imported` }, { iconName: 'triangle-alert', value: String(c.attention), label: 'not imported' }];
    if (r) for (const [k, v] of Object.entries(r)) if (typeof v === 'number' && !['ready'].includes(k)) tiles.push({ iconName: 'hash', value: String(v), label: k.replace(/_/g, ' ') });
    const next = [];
    if (b.kind === 'leaveboard_annual_situation' && b.status === 'applied') {
      const cut = input({ type: 'date', 'aria-label': 'Cutover date' }); const out = h('div', {});
      next.push(card({ title: 'Next: opening balances', iconName: 'calendar-check', body: h('div', { class: 'grid-gap' },
        h('p', { class: 'muted' }, 'Only do this on the agreed switch-over date. LeaveBoard stays the official record until then.'),
        h('div', { class: 'inline-form' }, field({ label: 'Switch-over date', id: 'imp-cut', control: cut }), button('Post opening balances', { variant: 'secondary', iconName: 'check', onClick: async () => {
          if (!cut.value) return toast('Choose the switch-over date first', 'danger');
          if (!(await confirmModal({ title: 'Post opening balances?', text: `Balances from this snapshot become the starting point in Prism on ${cut.value}. Running it again changes nothing.`, confirmLabel: 'Post balances' }))) return;
          const x = await api(`/api/imports/${b.id}/opening-balances`, { method: 'POST', body: { cutover: cut.value } }); toast(`${x.posted} balances posted · ${x.already} already there`);
        } }), button('Reconcile', { variant: 'ghost', iconName: 'scale', onClick: async () => {
          const rec = await api(`/api/imports/${b.id}/reconcile`);
          out.replaceChildren(dataTable({ compact: true, rowKey: (x) => `${x.vendor_name}${x.category}`, rows: rec, columns: [{ key: 'vendor_name', label: 'Person' }, { key: 'category', label: 'Category' }, { key: 'vendor_available', label: 'LeaveBoard', num: true }, { key: 'prism_posted', label: 'Prism', num: true }, { key: 'status', label: 'Status', render: (x) => (x.status === 'match' ? badge('Match', 'success') : badge(x.status.replace(/_/g, ' '), x.status === 'difference' ? 'danger' : 'neutral')) }] }));
        } })), out) }));
    }
    return [
      b.status === 'reversed' ? banner({ tone: 'info', title: 'This import was reversed', text: b.reversal_reason || '' })
        : banner({ tone: 'success', title: 'Import finished', text: `${KIND_LABEL[b.kind] || b.kind} · ${b.filename} · ${fmt(b.applied_at)}` }),
      statStrip(tiles.slice(0, 6)),
      ...next,
      h('div', { class: 'step-actions' },
        b.status === 'applied' ? button('Reverse import', { variant: 'danger', iconName: 'rotate-ccw', onClick: async () => {
          if (!(await confirmModal({ title: 'Reverse this import?', text: 'Rows written by this batch are removed (balances get compensating entries). Released or closed reviews are never touched. An audit record is kept.', confirmLabel: 'Reverse', tone: 'danger' }))) return;
          await api(`/api/imports/${b.id}/reverse`, { method: 'POST', body: { reason: 'Reversed from the import screen' } }); toast('Import reversed'); render();
        } }) : null,
        button('Download error report', { variant: 'secondary', iconName: 'download', onClick: () => errorReport(b) }),
        button('Import another file', { variant: 'primary', iconName: 'upload', onClick: () => render() })),
    ];
  }

  draw();
  root.pageActions = [button('Upload file', { variant: 'primary', iconName: 'upload', onClick: () => { if (st.step !== 0) go(0); root.querySelector('#imp-file')?.click(); } })];
  root.modern = true;
  return root;
}
