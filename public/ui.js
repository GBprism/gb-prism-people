// GB Prism UI components (framework-free). Every screen is built from these,
// so styling stays consistent. DOM is built with textContent only (no innerHTML).

export function h(tag, attrs = {}, ...kids) {
  const svgTags = new Set(['svg', 'use']);
  const el = svgTags.has(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** Lucide icon from the sprite. Decorative unless a label is given. */
export function icon(name, { size = 'sm', label, spin, flip } = {}) {
  const cls = ['icon', size === 'lg' ? 'icon-lg' : size === 'xl' ? 'icon-xl' : '', spin ? 'spin' : '', flip ? 'flip-rtl' : ''].filter(Boolean).join(' ');
  const svg = h('svg', { class: cls, fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': label ? null : 'true', role: label ? 'img' : null, 'aria-label': label || null, focusable: 'false' });
  svg.append(h('use', { href: `/icons.svg#i-${name}` }));
  return svg;
}

/** Button: variant primary|secondary|ghost|danger, size md|sm, optional icon, loading state. */
export function button(label, { variant = 'secondary', size, iconName, onClick, type = 'button', href, ariaLabel, disabled, title } = {}) {
  const cls = ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', !label ? 'btn-icon' : ''].filter(Boolean).join(' ');
  const kids = [iconName ? icon(iconName) : null, label ? h('span', {}, label) : null];
  const el = href ? h('a', { class: cls, href, 'aria-label': ariaLabel || null, title: title || null }, kids)
    : h('button', { class: cls, type, 'aria-label': ariaLabel || (!label ? title : null) || null, title: title || null, disabled: disabled || null }, kids);
  if (onClick) el.addEventListener('click', async (e) => {
    if (el.classList.contains('is-loading')) return;
    const r = onClick(e);
    if (r && typeof r.then === 'function') {
      el.classList.add('is-loading'); el.setAttribute('aria-busy', 'true');
      const first = el.querySelector('.icon'); const spinner = icon('loader-circle');
      if (first) first.replaceWith(spinner); else el.prepend(spinner);
      try { await r; } finally { el.classList.remove('is-loading'); el.removeAttribute('aria-busy'); spinner.replaceWith(first || ''); }
    }
  });
  return el;
}

const TONE_ICON = { success: 'circle-check', warning: 'triangle-alert', danger: 'circle-x', info: 'info', neutral: 'circle-dot' };
/** Status badge: always icon + text + tint (never colour alone). */
export function badge(text, tone = 'neutral', iconName) {
  return h('span', { class: `badge badge-${tone}` }, icon(iconName || TONE_ICON[tone] || 'circle-dot'), text);
}

export function card({ title, iconName, actions, body, flush } = {}) {
  return h('section', { class: 'card' },
    title ? h('header', { class: 'card-header' }, h('h2', {}, iconName ? icon(iconName, { size: 'lg' }) : null, title), actions ? h('div', { class: 'card-actions' }, actions) : null) : null,
    h('div', { class: `card-body${flush ? ' flush' : ''}` }, body));
}

export function statTile({ iconName, value, label, trend }) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-icon' }, icon(iconName, { size: 'lg' })),
    h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label),
    trend ? h('div', { class: `stat-trend ${trend.dir || ''}` }, icon(trend.dir === 'down' ? 'arrow-down-right' : 'arrow-up-right'), trend.text) : null);
}
export const statStrip = (tiles) => h('div', { class: 'stat-strip' }, tiles.map(statTile));

/** Page header: icon, title, one-line description, primary action, overflow menu. */
export function pageHeader({ iconName, title, description, actions = [] }) {
  return h('header', { class: 'page-header' }, h('div', { class: 'page-icon' }, icon(iconName, { size: 'lg' })),
    h('div', { class: 'page-titles' }, h('h1', {}, title), description ? h('p', { class: 'page-desc' }, description) : null),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null);
}

export function banner({ tone = 'info', title, text, actions }) {
  return h('div', { class: `banner banner-${tone}`, role: tone === 'danger' ? 'alert' : 'status' }, icon(TONE_ICON[tone] || 'info', { size: 'lg' }),
    h('div', { class: 'banner-body' }, title ? h('strong', {}, title) : null, text ? h('span', {}, text) : null), actions || null);
}

export function emptyState({ iconName = 'inbox', title, text, action }) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon(iconName, { size: 'lg' })), h('h3', {}, title), text ? h('p', {}, text) : null, action || null);
}

export function skeletonLines(n = 3, widths = ['90%', '75%', '60%']) {
  return h('div', { 'aria-busy': 'true', 'aria-label': 'Loading', style: null }, Array.from({ length: n }, (_, i) => {
    const s = h('span', { class: 'skeleton' }); s.style.blockSize = '14px'; s.style.inlineSize = widths[i % widths.length]; s.style.marginBlockEnd = '10px'; return s;
  }));
}

/** Field with label above, helper, inline validation. */
export function field({ label, id, control, help, required, error }) {
  const wrap = h('div', { class: `field${error ? ' is-invalid' : ''}` }, h('label', { class: 'field-label', for: id }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, '*') : null), control,
    help ? h('div', { class: 'field-help', id: `${id}-help` }, help) : null,
    h('div', { class: 'field-error', id: `${id}-err`, 'aria-live': 'polite' }, error ? [icon('circle-alert'), error] : null));
  control.id = id; if (required) control.required = true;
  control.setAttribute('aria-describedby', [help ? `${id}-help` : '', `${id}-err`].filter(Boolean).join(' '));
  return wrap;
}
export function setFieldError(wrap, msg) {
  wrap.classList.toggle('is-invalid', !!msg);
  const e = wrap.querySelector('.field-error'); e.replaceChildren(...(msg ? [icon('circle-alert'), msg] : []));
  wrap.querySelector('input,select,textarea')?.setAttribute('aria-invalid', msg ? 'true' : 'false');
}
export const input = (attrs = {}) => h('input', { class: 'input', ...attrs });
export const select = (options, attrs = {}) => h('select', { class: 'select', ...attrs }, options.map(([v, t]) => h('option', { value: v }, t)));
export const textarea = (attrs = {}, text = '') => h('textarea', { class: 'textarea', ...attrs }, text);

/** Data table: sortable columns, selection with bulk bar, density, row actions. */
export function dataTable({ columns, rows, rowKey = (r) => r.id, selectable = false, bulkActions = [], compact = false, emptyText = 'Nothing here yet', onRowClick }) {
  let sort = null; let dir = 1; const selected = new Set();
  const wrap = h('div', {});
  const bulk = h('div', { class: 'bulk-bar', hidden: true });
  const table = h('table', { class: `data${compact ? ' compact' : ''}` });
  const draw = () => {
    const data = [...rows];
    if (sort) { const c = columns.find((x) => x.key === sort); data.sort((a, b) => { const x = c.sortValue ? c.sortValue(a) : a[c.key]; const y = c.sortValue ? c.sortValue(b) : b[c.key]; return (x > y ? 1 : x < y ? -1 : 0) * dir; }); }
    const head = h('tr', {}, selectable ? h('th', { class: 'col-check' }, h('input', { type: 'checkbox', 'aria-label': 'Select all', checked: selected.size === rows.length && rows.length > 0, onchange: (e) => { rows.forEach((r) => (e.target.checked ? selected.add(rowKey(r)) : selected.delete(rowKey(r)))); draw(); } })) : null,
      columns.map((c) => h('th', { scope: 'col', 'aria-sort': sort === c.key ? (dir === 1 ? 'ascending' : 'descending') : null, class: c.num ? 'num' : null },
        c.sortable === false || !c.label ? c.label : h('button', { class: 'sort-btn', onclick: () => { dir = sort === c.key ? -dir : 1; sort = c.key; draw(); } }, c.label, icon('arrow-up-down')))));
    const body = data.length ? data.map((r) => {
      const k = rowKey(r);
      return h('tr', { 'aria-selected': selected.has(k) ? 'true' : null, onclick: onRowClick ? (e) => { if (!e.target.closest('button,a,input')) onRowClick(r); } : null, style: null },
        selectable ? h('td', { class: 'col-check' }, h('input', { type: 'checkbox', 'aria-label': 'Select row', checked: selected.has(k), onchange: (e) => { e.target.checked ? selected.add(k) : selected.delete(k); draw(); } })) : null,
        columns.map((c) => h('td', { class: c.num ? 'num' : null }, c.render ? c.render(r) : r[c.key])));
    }) : [h('tr', {}, h('td', { colspan: columns.length + (selectable ? 1 : 0) }, emptyState({ iconName: 'inbox', title: emptyText })))];
    table.replaceChildren(h('thead', {}, head), h('tbody', {}, body));
    bulk.hidden = !selected.size;
    bulk.replaceChildren(h('span', {}, `${selected.size} selected`), ...bulkActions.map((a) => button(a.label, { size: 'sm', iconName: a.iconName, onClick: () => a.run([...selected]) })),
      button('Clear', { variant: 'ghost', size: 'sm', onClick: () => { selected.clear(); draw(); } }));
  };
  draw();
  wrap.append(bulk, h('div', { class: 'table-wrap' }, table));
  wrap.setRows = (r) => { rows = r; selected.clear(); draw(); };
  wrap.setCompact = (v) => table.classList.toggle('compact', v);
  return wrap;
}

/** Filter chips with counts. */
export function filterChips(options, current, onChange) {
  const g = h('div', { role: 'group', 'aria-label': 'Filter', class: 'chip-group', style: null });
  const draw = (val) => g.replaceChildren(...options.map((o) => h('button', { class: 'chip', 'aria-pressed': String(o.value === val), onclick: () => { draw(o.value); onChange(o.value); } }, o.iconName ? icon(o.iconName) : null, o.label, o.count !== undefined ? h('span', { class: 'count' }, o.count) : null)));
  draw(current); return g;
}

/** Stepper: steps = [{label}], current index, done indexes before current. */
export function stepper(steps, current) {
  return h('ol', { class: 'stepper', 'aria-label': 'Progress' }, steps.map((s, i) => h('li', { class: i < current ? 'done' : null, 'aria-current': i === current ? 'step' : null },
    h('span', { class: 'step-dot' }, i < current ? icon('check') : String(i + 1)), h('span', { class: 'step-label' }, s.label))));
}

// ------------------------------------------------------ overlays & toasts --
let lastFocus = null;
function trap(container, close) {
  lastFocus = document.activeElement;
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') {
      const f = [...container.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    }
  };
  document.addEventListener('keydown', onKey);
  setTimeout(() => (container.querySelector('[autofocus],input,select,textarea,button') || container).focus(), 0);
  return () => { document.removeEventListener('keydown', onKey); lastFocus?.focus?.(); };
}

/** Drawer for editing a record without leaving the list. */
export function openDrawer({ title, iconName, body, footer }) {
  const overlay = h('div', { class: 'overlay' });
  const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' });
  const close = () => { release(); overlay.remove(); panel.remove(); };
  panel.append(h('header', { class: 'drawer-header' }, iconName ? icon(iconName, { size: 'lg' }) : null, h('h2', {}, title), button('', { variant: 'ghost', iconName: 'x', ariaLabel: 'Close', onClick: close })),
    h('div', { class: 'drawer-body' }, body), footer ? h('footer', { class: 'drawer-footer' }, footer(close)) : null);
  overlay.addEventListener('click', close);
  document.body.append(overlay, panel);
  const release = trap(panel, close);
  return close;
}

/** Modal — confirmations only. Resolves true/false. */
export function confirmModal({ title, text, confirmLabel = 'Confirm', tone = 'primary' }) {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'overlay' });
    const m = h('div', { class: 'modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' });
    const done = (v) => { release(); overlay.remove(); m.remove(); resolve(v); };
    m.append(h('header', { class: 'modal-header' }, h('h2', {}, title)), h('div', { class: 'modal-body' }, text),
      h('footer', { class: 'modal-footer' }, button('Cancel', { variant: 'secondary', onClick: () => done(false) }), button(confirmLabel, { variant: tone === 'danger' ? 'danger' : 'primary', onClick: () => done(true) })));
    overlay.addEventListener('click', () => done(false));
    document.body.append(overlay, m);
    const release = trap(m, () => done(false));
  });
}

export function toast(text, tone = 'success') {
  let stack = document.querySelector('.toast-stack');
  if (!stack) { stack = h('div', { class: 'toast-stack', 'aria-live': 'polite' }); document.body.append(stack); }
  const t = h('div', { class: `toast toast-${tone}`, role: tone === 'danger' ? 'alert' : 'status' }, icon(tone === 'danger' ? 'circle-x' : 'circle-check'), h('span', {}, text));
  stack.append(t); setTimeout(() => t.remove(), 4500);
}
