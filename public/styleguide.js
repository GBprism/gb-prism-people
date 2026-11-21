// Style guide: renders every base component and both sidebar options.
import { h, icon, button, badge, card, statStrip, pageHeader, banner, emptyState, skeletonLines, field, setFieldError, input, select, textarea, dataTable, filterChips, stepper, openDrawer, confirmModal, toast } from '/ui.js';

const sg = document.getElementById('sg');
sg.className = 'sg';

const swatch = (cls, name, hex, note) => h('div', { class: 'sg-swatch' }, h('div', { class: `chip-color ${cls}` }), h('div', { class: 'meta' }, h('strong', {}, name), h('br'), h('code', {}, hex), note ? h('div', { class: 'muted' }, note) : null));

function navItem(iconName, label, current, count) {
  return h('a', { class: 'nav-item', href: '#', 'aria-current': current ? 'page' : null }, icon(iconName, { size: 'lg' }), h('span', { class: 'nav-label' }, label), count ? h('span', { class: 'nav-count' }, count) : null);
}
function miniShell(theme, collapsed) {
  const logo = theme === 'light' ? '/brand/gb-logo.png' : '/brand/gb-logo-white.png';
  return h('div', { class: 'sg-shell', 'data-sidebar': theme === 'light' ? 'light' : null },
    h('div', { class: `app-shell${collapsed ? ' collapsed' : ''}` },
      h('nav', { class: 'sidebar', 'aria-label': `Sidebar preview ${theme}` },
        h('div', { class: 'sidebar-logo' }, h('img', { class: 'full', src: logo, alt: 'GB Advisory' }), h('img', { class: 'mark', src: '/brand/gb-mark.png', alt: 'GB Advisory' })),
        h('div', { class: 'nav-group' }, h('div', { class: 'nav-group-label' }, 'Workspace'), navItem('house', 'Home', true), navItem('inbox', 'Team inbox', false, '6'), navItem('calendar-days', 'Time off')),
        h('div', { class: 'nav-group' }, h('div', { class: 'nav-group-label' }, 'People'), navItem('clipboard-check', 'My reviews'), navItem('folder-kanban', 'Projects'), navItem('sparkles', 'AI examples')),
        h('div', { class: 'nav-group' }, h('div', { class: 'nav-group-label' }, 'Admin'), navItem('layout-dashboard', 'Completion'), navItem('cloud-upload', 'Imports'))),
      h('div', { class: 'main' },
        h('div', { class: 'topbar' }, h('nav', { class: 'breadcrumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: '#' }, 'Workspace'), icon('chevron-right', { flip: true }), h('span', { 'aria-current': 'page' }, 'Home')),
          h('div', { class: 'topbar-actions' }, h('button', { class: 'search-trigger', type: 'button' }, icon('search'), h('span', { class: 'label' }, 'Search'), h('kbd', {}, '⌘K')), h('span', { class: 'avatar' }, 'LA'))),
        h('div', { class: 'page' }, pageHeader({ iconName: 'house', title: 'Hello, Layan', description: '3 things need your attention' }),
          statStrip([{ iconName: 'clipboard-check', value: '12', label: 'Plans to approve' }, { iconName: 'calendar-days', value: '14', label: 'Leave days left' }])))));
}

// ---- header
sg.append(pageHeader({ iconName: 'layout-dashboard', title: 'GB Prism style guide', description: 'Tokens and components for every screen. Brand colours measured from the official GB Advisory logo.',
  actions: [button('Toggle RTL preview', { variant: 'secondary', iconName: 'arrow-right', onClick: () => { document.documentElement.dir = document.documentElement.dir === 'rtl' ? 'ltr' : 'rtl'; } })] }));

// ---- sidebar options
sg.append(card({ title: 'Sidebar options', iconName: 'layout-dashboard', body: h('div', { class: 'sg-shells' },
  h('div', {}, h('h3', {}, 'A · Midnight sidebar, white logo'), h('p', { class: 'muted' }, 'Strongest brand presence; cyan active marker.'), miniShell('dark')),
  h('div', {}, h('h3', {}, 'B · White sidebar, dark logo'), h('p', { class: 'muted' }, 'Lighter, closer to Rippling; navy active state.'), miniShell('light')),
  h('div', {}, h('h3', {}, 'Collapsed icon rail (64px)'), h('p', { class: 'muted' }, 'Either option collapses to the chevron mark.'), miniShell('dark', true))) }));

// ---- colours
sg.append(card({ title: 'Colour', iconName: 'sun', body: h('div', { class: 'sg-swatches' },
  swatch('c-navy', 'Navy · primary', '#004281', 'Buttons, links, focus · white 10.3:1'), swatch('c-blue', 'Blue', '#0080B2', 'Icons, emphasis'), swatch('c-cyan', 'Cyan · accent', '#00B6DA', 'Markers & charts only'),
  swatch('c-sky', 'Sky', '#86D3E5', 'Charts, highlights'), swatch('c-midnight', 'Midnight', '#010624', 'Dark surfaces'), swatch('c-canvas', 'Canvas', '#F6F7F9'), swatch('c-border', 'Border', '#E3E6EB'), swatch('c-text', 'Text', '#15181D')) }));

// ---- type
sg.append(card({ title: 'Type', iconName: 'file-text', body: h('div', { class: 'sg-type' },
  h('div', { class: 't-3xl' }, '30 · Poppins 600 — display'), h('div', { class: 't-2xl' }, '24 · Poppins 600 — page title'), h('div', { class: 't-xl' }, '20 · Inter 600 — section'),
  h('div', { class: 't-lg' }, '17 · Inter — card title'), h('div', { class: 't-md' }, '15 · Inter — emphasis'), h('div', { class: 't-base' }, '14 · Inter — body (base)'),
  h('div', { class: 't-sm' }, '13 · Inter — secondary'), h('div', { class: 't-xs' }, '12 · Inter — captions'), h('div', { class: 'num' }, 'Tabular numerals: 1,204.50 · 0,987.25')) }));

// ---- buttons
sg.append(card({ title: 'Buttons', iconName: 'command', body: h('div', { class: 'sg-row' },
  button('Upload file', { variant: 'primary', iconName: 'upload' }), button('Download template', { variant: 'secondary', iconName: 'download' }), button('Cancel', { variant: 'ghost' }), button('Delete', { variant: 'danger', iconName: 'trash-2' }),
  button('Small', { variant: 'primary', size: 'sm', iconName: 'check' }), button('', { variant: 'secondary', iconName: 'ellipsis', ariaLabel: 'More actions' }),
  button('Save (click: loading)', { variant: 'primary', iconName: 'check', onClick: () => new Promise((r) => setTimeout(r, 1500)) }), button('Disabled', { variant: 'primary', disabled: true })) }));

// ---- form with inline validation
const email = input({ type: 'email', placeholder: 'name@gb-advisory.com' });
const emailField = field({ label: 'Work email', id: 'sg-email', control: email, help: 'Only @gb-advisory.com accounts can sign in.', required: true });
email.addEventListener('input', () => setFieldError(emailField, email.value && !/@gb-advisory\.com$/i.test(email.value) ? 'Use your @gb-advisory.com address' : ''));
sg.append(card({ title: 'Form fields', iconName: 'pencil', body: h('div', { class: 'form-grid' }, emailField,
  field({ label: 'Request type', id: 'sg-type', control: select([['AV', 'Annual vacation'], ['SL', 'Sick leave'], ['WFH', 'Work from home']]) }),
  field({ label: 'First day', id: 'sg-date', control: input({ type: 'date' }), required: true }),
  field({ label: 'Reason', id: 'sg-reason', control: textarea({ placeholder: 'Only you, your approver and People Ops see this' }), help: 'Optional' })) }));

// ---- badges, banners, stats
sg.append(card({ title: 'Status', iconName: 'circle-check', body: h('div', { class: 'sg-type' },
  h('div', { class: 'sg-row' }, badge('Approved', 'success'), badge('Waiting for you', 'warning', 'clock'), badge('Declined', 'danger'), badge('Self-assessment', 'info', 'clipboard-check'), badge('Draft', 'neutral', 'pencil')),
  banner({ tone: 'success', title: 'Import finished', text: '13 rows imported. 0 need attention.' }),
  banner({ tone: 'warning', title: 'Policy awaiting GB approval', text: 'Requests stay closed until a partner approves the leave policy.' }),
  banner({ tone: 'danger', title: 'Totals do not reconcile', text: 'Column "Worked" sums to 452.5 but the totals row says 452. Fix the export and upload again.' })) }));
sg.append(statStrip([{ iconName: 'clipboard-check', value: '12', label: 'Plans to approve', trend: { dir: 'up', text: '5 this week' } }, { iconName: 'users', value: '14', label: 'People in workspace' },
  { iconName: 'calendar-days', value: '101', label: 'Leave days available' }, { iconName: 'triangle-alert', value: '2', label: 'Negative balances', trend: { dir: 'down', text: 'review' } }]));

// ---- table
const people = [
  { id: 1, name: 'Eli Employee', role: 'Consultant', stage: 'Self-assessment', due: '2026-12-15', score: 3.8 },
  { id: 2, name: 'Sara Senior', role: 'Senior Consultant', stage: 'Manager review', due: '2026-12-22', score: 4.1 },
  { id: 3, name: 'Adam Assistant', role: 'Assistant Manager', stage: 'Plan approved', due: '2026-12-15', score: 3.2 },
  { id: 4, name: 'Leo Lead', role: 'Senior Consultant', stage: 'Released', due: '—', score: 4.6 },
];
const tone = { 'Self-assessment': 'info', 'Manager review': 'warning', 'Plan approved': 'neutral', Released: 'success' };
const table = dataTable({ selectable: true, bulkActions: [{ label: 'Send reminder', iconName: 'send', run: (ids) => toast(`Reminder queued for ${ids.length}`) }], rows: people, columns: [
  { key: 'name', label: 'Person', render: (r) => h('strong', {}, r.name) }, { key: 'role', label: 'Role' },
  { key: 'stage', label: 'Stage', render: (r) => badge(r.stage, tone[r.stage]) }, { key: 'due', label: 'Due' }, { key: 'score', label: 'Score', num: true, render: (r) => r.score.toFixed(1) },
  { key: 'act', label: '', sortable: false, render: () => h('div', { class: 'row-actions' }, button('', { variant: 'ghost', size: 'sm', iconName: 'eye', ariaLabel: 'Open' }), button('', { variant: 'ghost', size: 'sm', iconName: 'ellipsis', ariaLabel: 'More' })) }] });
let compact = false;
sg.append(card({ title: 'Table', iconName: 'table', flush: true, actions: [button('Density', { size: 'sm', iconName: 'rows-3', onClick: () => { compact = !compact; table.setCompact(compact); } })],
  body: h('div', {}, h('div', { class: 'table-toolbar' }, filterChips([{ value: 'all', label: 'All', count: 4 }, { value: 'review', label: 'Manager review', count: 1 }, { value: 'self', label: 'Self-assessment', count: 1 }], 'all', (v) => table.setRows(v === 'all' ? people : people.filter((p) => (v === 'review' ? p.stage === 'Manager review' : p.stage === 'Self-assessment')))),
    h('span', { class: 'spacer' }), button('Filter', { variant: 'ghost', size: 'sm', iconName: 'filter' })), table, h('div', { class: 'table-footer' }, h('span', {}, '4 people'), h('span', {}, 'Page 1 of 1'))) }));

// ---- stepper, empty, skeleton, overlays
sg.append(card({ title: 'Stepper', iconName: 'list-checks', body: stepper([{ label: 'Upload' }, { label: 'Check format' }, { label: 'Review & fix' }, { label: 'Import' }], 2) }));
sg.append(h('div', { class: 'split' },
  card({ title: 'Empty state', iconName: 'inbox', body: emptyState({ iconName: 'cloud-upload', title: 'No imports yet', text: 'Upload a LeaveBoard export or the PMS forms to get started.', action: button('Upload file', { variant: 'primary', iconName: 'upload' }) }) }),
  card({ title: 'Loading', iconName: 'loader-circle', body: skeletonLines(4) })));
sg.append(card({ title: 'Drawer, modal, toast', iconName: 'messages-square', body: h('div', { class: 'sg-row' },
  button('Open drawer', { iconName: 'pencil', onClick: () => openDrawer({ title: 'Edit request', iconName: 'calendar-days', body: [field({ label: 'First day', id: 'd1', control: input({ type: 'date' }) }), field({ label: 'Note', id: 'd2', control: textarea() })], footer: (close) => [button('Cancel', { variant: 'ghost', onClick: close }), button('Save', { variant: 'primary', iconName: 'check', onClick: () => { close(); toast('Saved'); } })] }) }),
  button('Confirm (modal)', { iconName: 'trash-2', variant: 'danger', onClick: async () => { if (await confirmModal({ title: 'Reverse this import?', text: 'Rows written by this batch are removed and an audit record is kept.', confirmLabel: 'Reverse', tone: 'danger' })) toast('Import reversed'); } }),
  button('Show toast', { iconName: 'bell', onClick: () => toast('Plan approved') }),
  button('Error toast', { iconName: 'circle-x', onClick: () => toast('Could not save — check your connection', 'danger') })) }));
