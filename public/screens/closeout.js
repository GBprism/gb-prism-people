// Engagement close-out (lessons learned and reusable assets) and the Toolkit of reusable assets.
import { h, icon, button, badge, emptyState, field, input, select, textarea, toast, openDrawer, statStrip } from '/ui.js';

const KINDS = [['template', 'Template'], ['tool', 'Tool'], ['framework', 'Framework'], ['model', 'Model (Excel)'], ['training', 'Training material'], ['other', 'Other']];

export async function openCloseout(api, engagementId, onSaved) {
  const v = await api(`/api/closeouts/${engagementId}`);
  const c = v.closeout || {};
  const ro = !v.canEdit;
  const ta = (id, val, ph) => textarea({ id, rows: 4, placeholder: ph, readonly: ro || null }, val || '');
  const well = ta('co-well', c.went_well, 'What worked: approach, tools, how we worked with the client');
  const improve = ta('co-imp', c.to_improve, 'What we would do differently next time');
  const client = ta('co-cli', c.client_feedback, 'What the client said (from the close meeting or the survey)');
  const tags = input({ id: 'co-tags', value: c.tags || '', placeholder: 'e.g. KPI cascade; banking; Arabic delivery', readonly: ro || null });
  const assets = (v.assets || []).map((a) => ({ ...a }));
  const list = h('div', { class: 'stack' });
  const drawAssets = () => list.replaceChildren(...assets.map((a, i) => {
    const t = input({ 'aria-label': 'Asset title', class: 'input input-sm', value: a.title || '', placeholder: 'e.g. KPI dictionary template', oninput: (e) => { a.title = e.target.value; }, readonly: ro || null });
    const k = select(KINDS, { 'aria-label': 'Type', class: 'select select-sm', onchange: (e) => { a.kind = e.target.value; }, disabled: ro || null }); k.value = a.kind || 'template'; a.kind = k.value;
    const u = input({ 'aria-label': 'Drive link', class: 'input input-sm', type: 'url', value: a.drive_url || '', placeholder: 'https://drive.google.com/…', oninput: (e) => { a.drive_url = e.target.value; }, readonly: ro || null });
    return h('div', { class: 'row' }, t, k, u, ro ? h('a', { href: a.drive_url, target: '_blank', rel: 'noopener', class: 'btn btn-ghost btn-sm' }, icon('external-link')) : button('', { size: 'sm', variant: 'ghost', iconName: 'trash-2', ariaLabel: 'Remove asset', onClick: () => { assets.splice(i, 1); drawAssets(); } }));
  }), ro ? null : button('Add a reusable asset', { size: 'sm', iconName: 'plus', onClick: () => { assets.push({ kind: 'template' }); drawAssets(); } }));
  drawAssets();
  openDrawer({ title: `Close-out — ${v.engagement.client}: ${v.engagement.title}`, iconName: 'lightbulb', body: h('div', { class: 'stack' },
    c.submitted_by_name ? h('p', { class: 'muted' }, `Written by ${c.submitted_by_name}.`) : h('p', { class: 'muted' }, 'Ten minutes at the end of an engagement saves the next team days. Reusable assets appear in the Library’s Toolkit.'),
    field({ label: 'What went well', id: 'co-well', control: well }), field({ label: 'What to improve', id: 'co-imp', control: improve }), field({ label: 'Client feedback', id: 'co-cli', control: client }),
    field({ label: 'Tags', id: 'co-tags', control: tags }), h('h3', { class: 'kv-head' }, 'Reusable assets'), list),
  footer: ro ? null : (close) => button('Save close-out', { variant: 'primary', iconName: 'check', onClick: async () => {
    try { await api(`/api/closeouts/${engagementId}`, { method: 'POST', body: { went_well: well.value, to_improve: improve.value, client_feedback: client.value, tags: tags.value, assets: assets.filter((a) => a.title || a.drive_url) } }); toast('Close-out saved'); close(); onSaved?.(); } catch (e) { toast(e.message, 'danger'); }
  } }) });
}

export async function toolkitPanel(api) {
  const v = await api('/api/toolkit');
  let q = ''; let kind = '';
  const list = h('ul', { class: 'eng-list' });
  const draw = () => { const rows = v.assets.filter((a) => (!kind || a.kind === kind) && (!q || `${a.title} ${a.description || ''} ${a.engagement} ${a.client}`.toLowerCase().includes(q)));
    list.replaceChildren(...(rows.length ? rows.map((a) => h('li', { class: 'eng-item' }, h('div', { class: 'eng-main' }, h('strong', {}, a.title), h('div', { class: 'eng-meta muted' }, h('span', {}, KINDS.find(([k]) => k === a.kind)?.[1]), h('span', {}, `${a.client} — ${a.engagement}`), a.added_by_name ? h('span', {}, `Added by ${a.added_by_name}`) : null), a.description ? h('p', { class: 'eng-scope' }, a.description) : null),
      h('div', { class: 'eng-side' }, h('a', { class: 'btn btn-secondary btn-sm', href: a.drive_url, target: '_blank', rel: 'noopener' }, icon('folder-open'), h('span', {}, 'Open'))))) : [h('li', {}, emptyState({ iconName: 'lightbulb', title: v.assets.length ? 'No assets match' : 'The toolkit is empty', text: 'Assets are added in each engagement’s close-out.' }))])); };
  draw();
  const k = v.kpi;
  return [statStrip([{ iconName: 'lightbulb', value: String(k.assets), label: 'reusable assets' }, { iconName: 'percent', value: k.pct == null ? '—' : `${k.pct}%`, label: `completed engagements with a close-out (${k.with_closeout} of ${k.done}, since 2025)` }]),
    h('div', { class: 'filter-row' }, input({ type: 'search', class: 'input input-sm library-search', placeholder: 'Search templates, tools, frameworks', 'aria-label': 'Search the toolkit', oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } }),
      select([['', 'All types'], ...KINDS], { 'aria-label': 'Type', class: 'select select-sm', onchange: (e) => { kind = e.target.value; draw(); } })), list];
}
