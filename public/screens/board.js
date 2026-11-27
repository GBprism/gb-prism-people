// Engagement board: To do → In progress → Internal review → Ready to send → Done.
// Cards are the project's deliverables. Drag a card, or use its Status control (keyboard and phone),
// or Alt+←/→ on a focused card. Every move is saved with the card's revision; if the save fails the
// board goes back to the saved state and says why.
import { h, icon, button, badge, emptyState, filterChips, select, input, textarea, field, toast, openDrawer, avatar } from '/ui.js';
import { engagementHeader } from '/screens/project.js';
import { composer, renderRich } from '/rich.js';

const d0 = (s) => new Date(`${s}T00:00:00`);
const fmtShort = (s) => d0(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const toneOf = (key) => { let x = 0; for (const c of String(key || '')) x = (x * 31 + c.charCodeAt(0)) % 997; return `block-${(x % 6) + 1}`; };
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(new Date());

export async function boardScreen({ api, me, id, query = '' }) {
  const [overview, team] = await Promise.all([api(`/api/projects/${encodeURIComponent(id)}/overview`), api('/api/team').catch(() => [])]);
  let v = await api(`/api/projects/${encodeURIComponent(id)}/board`);
  const today = todayIso();
  const params = new URLSearchParams(query);
  let filter = params.get('filter') || 'all'; let ws = '';
  const status = h('div', { class: 'board-status', role: 'status', 'aria-live': 'polite' });
  const boardEl = h('div', { class: 'board', role: 'region', 'aria-label': 'Board' });
  const photo = (uid) => team.find((p) => p.id === uid) || { name: v.people.find((p) => p.id === uid)?.name || '?' };
  const col = (k) => v.columns.find((c) => c.key === k);
  const needsAttention = (c) => !!c.blocked || (c.due_date && c.due_date < today && c.status !== 'accepted') || (c.status === 'submitted' && c.reviewer_id === me.id);
  const shown = (c) => (filter === 'all' || (filter === 'mine' ? c.owner_id === me.id || c.reviewer_id === me.id : needsAttention(c))) && (!ws || c.workstream === ws);

  const say = (text, tone = 'info') => { status.replaceChildren(h('div', { class: `banner banner-${tone}` }, icon(tone === 'danger' ? 'circle-alert' : 'info'), h('span', {}, text))); setTimeout(() => status.replaceChildren(), 8000); };
  async function reload() { v = await api(`/api/projects/${encodeURIComponent(id)}/board`); draw(); }

  /** Save a move; on failure restore the saved board and explain. */
  async function move(card, to, { before = null, after = null } = {}) {
    const saved = v.cards.map((c) => ({ ...c }));
    const c = v.cards.find((x) => x.id === card.id); const from = c.status; const rev = c.rev; // the revision the board last saw
    c.status = to; draw(); // optimistic
    try {
      const r = await api(`/api/cards/${card.id}/move`, { method: 'POST', body: { status: to, before_id: before, after_id: after, rev } });
      Object.assign(c, r);
      if (from !== to) toast(`Moved to ${col(to).label}`);
      await reload();
      document.querySelector(`[data-card="${card.id}"]`)?.focus();
    } catch (e) {
      v.cards = saved; draw();
      say(`${c.title} stayed in ${col(from).label}: ${e.message}`, 'danger');
      if (e.status === 409) await reload();
    }
  }

  function cardEl(c) {
    const overdue = c.due_date && c.due_date < today && c.status !== 'accepted';
    const el = h('li', { class: 'board-card-wrap' }, h('div', { role: 'button', tabindex: '0', class: `board-card${c.blocked ? ' is-blocked' : ''}`, draggable: v.can.edit ? 'true' : null, 'data-card': c.id,
      'aria-label': `${c.title}. ${col(c.status).label}${c.owner ? `, owner ${c.owner}` : ''}${c.due_date ? `, due ${fmtShort(c.due_date)}` : ''}${c.blocked ? `, blocked: ${c.blocked.reason}` : ''}. Press Enter to open; Alt and arrow keys to move.`,
      onclick: () => openCard(c.id),
      onkeydown: (e) => { if (!e.altKey && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openCard(c.id); return; } if (!e.altKey || !v.can.edit) return; const i = v.columns.findIndex((k) => k.key === c.status); const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : -1; if (n >= 0 && n < v.columns.length && n !== i) { e.preventDefault(); move(c, v.columns[n].key); } },
      ondragstart: (e) => { e.dataTransfer.setData('text/plain', c.id); e.dataTransfer.effectAllowed = 'move'; el.classList.add('is-dragging'); },
      ondragend: () => el.classList.remove('is-dragging') },
    c.workstream || c.blocked ? h('span', { class: 'card-tags' }, c.workstream ? h('span', { class: `ws-chip ${toneOf(c.workstream)}` }, c.workstream) : null, c.blocked ? h('span', { class: 'blocked-chip' }, icon('triangle-alert'), 'Blocked') : null) : null,
    h('span', { class: 'card-title' }, c.title),
    c.blocked ? h('span', { class: 'card-block-reason' }, c.blocked.reason) : null,
    h('span', { class: 'card-foot' },
      c.due_date ? h('span', { class: `card-due${overdue ? ' is-late' : ''}` }, icon('clock'), overdue ? `Overdue · ${fmtShort(c.due_date)}` : fmtShort(c.due_date)) : null,
      c.checklist.total ? h('span', { class: `card-meta${c.checklist.done === c.checklist.total ? ' is-done' : ''}`, title: 'Checklist' }, icon('list-checks'), `${c.checklist.done}/${c.checklist.total}`) : null,
      c.links ? h('span', { class: 'card-meta', title: 'Linked files' }, icon('paperclip'), String(c.links)) : null,
      c.comments ? h('span', { class: 'card-meta', title: 'Comments' }, icon('messages-square'), String(c.comments)) : null,
      c.status === 'submitted' && c.reviewer ? h('span', { class: 'card-meta', title: `Reviewer: ${c.reviewer}` }, icon('eye'), c.reviewer.split(' ')[0]) : null,
      h('span', { class: 'card-owner' }, c.owner ? avatar(photo(c.owner_id), 'sm') : h('span', { class: 'muted' }, 'No owner')))));
    return el;
  }

  function columnEl(k) {
    const cards = v.cards.filter((c) => c.status === k.key && shown(c));
    const list = h('ul', { class: 'board-list', 'aria-label': k.label });
    list.append(...cards.map(cardEl));
    // drop target: place the card before the card under the pointer
    list.addEventListener('dragover', (e) => { if (!v.can.edit) return; e.preventDefault(); list.classList.add('is-over'); });
    list.addEventListener('dragleave', () => list.classList.remove('is-over'));
    list.addEventListener('drop', (e) => {
      e.preventDefault(); list.classList.remove('is-over');
      const cid = e.dataTransfer.getData('text/plain'); const card = v.cards.find((x) => x.id === cid); if (!card) return;
      const others = [...list.querySelectorAll('.board-card')].filter((b) => b.dataset.card !== cid);
      const next = others.find((b) => { const r = b.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
      const idx = next ? others.indexOf(next) : others.length;
      move(card, k.key, { before: next?.dataset.card || null, after: !next && others.length ? others.at(-1).dataset.card : idx > 0 ? others[idx - 1].dataset.card : null });
    });
    const add = v.can.edit && ['todo', 'in_progress'].includes(k.key) ? (() => {
      const box = h('div', { class: 'add-task' });
      const open = () => {
        const t = input({ class: 'input input-sm', placeholder: 'Task title', 'aria-label': `New task in ${k.label}` });
        const save = async () => { if (!t.value.trim()) return reset(); try { await api(`/api/projects/${id}/cards`, { method: 'POST', body: { title: t.value, status: k.key, owner_id: filter === 'mine' ? me.id : null, workstream: ws || null } }); toast('Task added'); await reload(); } catch (e) { toast(e.message, 'danger'); } };
        t.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') reset(); });
        box.replaceChildren(t, h('div', { class: 'row' }, button('Add', { size: 'sm', variant: 'primary', onClick: save }), button('Cancel', { size: 'sm', variant: 'ghost', onClick: () => reset() }))); t.focus();
      };
      const reset = () => box.replaceChildren(h('button', { type: 'button', class: 'add-task-btn', onclick: open }, icon('plus'), 'Add task'));
      reset(); return box;
    })() : null;
    return h('section', { class: `board-col col-${k.key}`, 'aria-label': `${k.label}, ${cards.length} card${cards.length === 1 ? '' : 's'}` },
      h('header', { class: 'board-col-head' }, h('h2', {}, k.label), h('span', { class: 'col-count' }, String(cards.length))), list, add);
  }

  function draw() {
    boardEl.replaceChildren(...v.columns.map(columnEl));
    const mine = v.cards.filter((c) => c.owner_id === me.id || c.reviewer_id === me.id).length; const attn = v.cards.filter(needsAttention).length;
    chipsBox.replaceChildren(filterChips([{ value: 'all', label: 'All', count: v.cards.length }, { value: 'mine', label: 'My tasks', count: mine }, { value: 'attention', label: 'Needs attention', count: attn }], filter, (x) => { filter = x; draw(); }));
  }
  const chipsBox = h('div');
  const wsSel = select([['', 'All workstreams'], ...v.workstreams.map((w) => [w, w])], { class: 'select select-sm', 'aria-label': 'Workstream', onchange: (e) => { ws = e.target.value; draw(); } });

  // ------------------------------------------------------------- card detail --
  async function openCard(cardId) {
    let d;
    try { d = await api(`/api/cards/${cardId}`); } catch (e) { return say(e.status === 404 ? 'That card does not exist or is not on a project you can open.' : e.message, 'danger'); }
    history.replaceState(null, '', `#/project/${id}/board?card=${cardId}`);
    let close;
    const refresh = async () => { close?.(); await reload(); openCard(cardId); };
    const patch = async (body) => { try { const r = await api(`/api/cards/${cardId}`, { method: 'PATCH', body: { ...body, rev: v.cards.find((x) => x.id === cardId)?.rev ?? d.rev } }); d.rev = r.rev; await reload(); toast('Saved'); } catch (e) { toast(e.message, 'danger'); if (e.status === 409) refresh(); } };
    const ro = !d.can.edit;
    const people = [['', '— none —'], ...v.people.map((p) => [p.id, p.name])];
    const title = input({ id: 'cd-title', value: d.title, readonly: ro || null, onchange: (e) => patch({ title: e.target.value }) });
    const st = select(v.columns.map((k) => [k.key, k.label]), { id: 'cd-status', disabled: ro || null, onchange: async (e) => { const to = e.target.value; e.target.value = d.status; close(); await move(d, to); openCard(cardId); } }); st.value = d.status;
    const owner = select(people, { id: 'cd-owner', disabled: ro || null, onchange: (e) => patch({ owner_id: e.target.value || null }) }); owner.value = d.owner_id || '';
    const reviewer = select([['', `Project lead${v.project.lead ? ` (${v.project.lead})` : ''}`], ...v.people.map((p) => [p.id, p.name])], { id: 'cd-reviewer', disabled: ro || null, onchange: (e) => patch({ reviewer_id: e.target.value || null }) }); reviewer.value = d.reviewer_id || '';
    const due = input({ id: 'cd-due', type: 'date', value: d.due_date || '', readonly: ro || null, onchange: (e) => patch({ due_date: e.target.value || null }) });
    const wsIn = input({ id: 'cd-ws', value: d.workstream || '', list: 'ws-list', readonly: ro || null, placeholder: 'e.g. Organisation design', onchange: (e) => patch({ workstream: e.target.value }) });
    const ms = input({ id: 'cd-ms', value: d.milestone || '', readonly: ro || null, placeholder: 'e.g. Client workshop 2', onchange: (e) => patch({ milestone: e.target.value }) });
    const desc = textarea({ id: 'cd-desc', rows: 3, readonly: ro || null, placeholder: 'What the task is and the context', onchange: (e) => patch({ description: e.target.value }) }, d.description || '');
    const outp = textarea({ id: 'cd-out', rows: 2, readonly: ro || null, placeholder: 'What “done” looks like, e.g. N-2 chart with role descriptions', onchange: (e) => patch({ expected_output: e.target.value }) }, d.expected_output || '');
    // blocked flag
    const blockBox = h('div', { class: 'block-box' });
    const drawBlock = () => blockBox.replaceChildren(...(d.blocked ? [h('div', { class: 'banner banner-danger' }, icon('triangle-alert'), h('span', {}, h('strong', {}, 'Blocked: '), d.blocked.reason, d.blocked.by ? ` — ${d.blocked.by}` : '')),
      ro ? null : button('Clear blocker', { size: 'sm', iconName: 'check', onClick: async () => { await api(`/api/cards/${cardId}/block`, { method: 'POST', body: {} }); refresh(); } })]
      : ro ? [] : [button('Flag as blocked', { size: 'sm', variant: 'ghost', iconName: 'triangle-alert', onClick: () => {
        const r = input({ class: 'input input-sm', placeholder: 'What is holding it up?', 'aria-label': 'Why is it blocked' });
        blockBox.replaceChildren(r, button('Flag', { size: 'sm', variant: 'primary', onClick: async () => { if (!r.value.trim()) return toast('Say what is blocking it', 'danger'); await api(`/api/cards/${cardId}/block`, { method: 'POST', body: { reason: r.value } }); refresh(); } })); r.focus(); } })]));
    drawBlock();
    // checklist
    const chk = h('ul', { class: 'card-checklist' }, d.checklist_items.map((i) => h('li', {}, h('label', { class: 'check-row' },
      h('input', { type: 'checkbox', checked: !!i.done_at, disabled: ro || null, onchange: async (e) => { try { await api(`/api/checklist/${i.id}`, { method: 'PATCH', body: { done: e.target.checked } }); await reload(); } catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'danger'); } } }),
      h('span', {}, i.text), i.done_at ? h('span', { class: 'muted' }, ` · ${i.done_by_name}`) : null))));
    const newItem = input({ class: 'input input-sm', placeholder: 'Add an item, e.g. Numbers tie to the source', 'aria-label': 'New checklist item' });
    newItem.addEventListener('keydown', async (e) => { if (e.key === 'Enter' && newItem.value.trim()) { await api(`/api/cards/${cardId}/checklist`, { method: 'POST', body: { text: newItem.value } }); refresh(); } });
    // files
    const fileUrl = input({ class: 'input input-sm', type: 'url', placeholder: 'https://docs.google.com/…', 'aria-label': 'Drive link' });
    const fileLabel = input({ class: 'input input-sm', placeholder: 'Label, e.g. Working draft', 'aria-label': 'Link label' });
    const files = h('ul', { class: 'card-files' },
      d.drive_url ? h('li', {}, h('a', { href: d.drive_url, target: '_blank', rel: 'noopener' }, icon('folder-open'), ' Working file'), ro ? null : button('', { size: 'sm', variant: 'ghost', iconName: 'x', ariaLabel: 'Remove working file', onClick: () => patch({ drive_url: null }).then(refresh) })) : null,
      d.link_items.map((l) => h('li', {}, h('a', { href: l.url, target: '_blank', rel: 'noopener' }, icon('external-link'), ` ${l.label || 'Linked file'}`), ro ? null : button('', { size: 'sm', variant: 'ghost', iconName: 'x', ariaLabel: `Remove ${l.label || 'link'}`, onClick: async () => { await api(`/api/card-links/${l.id}/delete`, { method: 'POST' }); refresh(); } }))));
    // comments
    const box = composer({ people: v.people.filter((p) => p.id !== me.id), cards: v.cards.filter((c) => c.id !== cardId), placeholder: 'Feedback or a question about this deliverable. @ to mention, # to link a card', label: 'Comment' });
    const comments = h('ol', { class: 'card-comments' }, d.comment_items.map((k) => h('li', { id: `comment-${k.id}` }, h('div', { class: 'comment-head' }, avatar(photo(k.author_id), 'sm'), h('strong', {}, k.author), h('time', { class: 'muted' }, when(k.created_at))), h('p', {}, renderRich(k.body, { people: v.people })))));
    const reviewBox = d.status === 'submitted' ? (d.can.review && d.owner_id !== me.id ? h('div', { class: 'review-box' }, h('strong', {}, 'Your review'), h('p', { class: 'muted' }, 'Comment with your feedback, then pass the review or send it back for changes.'),
      h('div', { class: 'row' }, button('Pass review — ready to send', { variant: 'primary', iconName: 'check', onClick: async () => { close(); await move(d, 'ready'); openCard(cardId); } }), button('Send back for changes', { iconName: 'rotate-ccw', onClick: async () => { close(); await move(d, 'in_progress'); openCard(cardId); } })))
      : h('p', { class: 'callout' }, `In internal review with ${d.reviewer || 'the project lead'}.`)) : d.review ? h('p', { class: 'callout' }, icon('circle-check'), ` Review passed by ${d.review.by}, ${when(d.review.at)}. Sending to the client happens outside the board.`) : null;

    close = openDrawer({ title: d.title, iconName: 'list-checks', body: h('div', { class: 'stack card-detail' },
      reviewBox, blockBox,
      field({ label: 'Title', id: 'cd-title', control: title }),
      h('div', { class: 'form-grid' }, field({ label: 'Status', id: 'cd-status', control: st, help: 'Moves only change the internal workflow' }), field({ label: 'Due date', id: 'cd-due', control: due }),
        field({ label: 'Owner', id: 'cd-owner', control: owner }), field({ label: 'Reviewer', id: 'cd-reviewer', control: reviewer, help: 'Reviews it before Ready to send' }),
        field({ label: 'Workstream', id: 'cd-ws', control: wsIn }), field({ label: 'Milestone', id: 'cd-ms', control: ms })),
      h('datalist', { id: 'ws-list' }, v.workstreams.map((w) => h('option', { value: w }))),
      field({ label: 'Description', id: 'cd-desc', control: desc }), field({ label: 'Expected output', id: 'cd-out', control: outp }),
      d.source ? h('p', { class: 'callout' }, icon('messages-square'), ' From the discussion: “', d.source.text, '” — ', d.source.sender, ' ', h('a', { href: d.source.link }, 'Open the message')) : null,
      h('h3', { class: 'kv-head' }, `Checklist ${d.checklist.total ? `(${d.checklist.done} of ${d.checklist.total})` : ''}`), chk, ro ? null : newItem,
      h('h3', { class: 'kv-head' }, 'Files'), files, ro ? null : h('div', { class: 'edit-row' }, fileUrl, fileLabel, button('Link', { size: 'sm', iconName: 'paperclip', onClick: async () => {
        try { if (!d.drive_url && !fileLabel.value) await patch({ drive_url: fileUrl.value }); else await api(`/api/cards/${cardId}/links`, { method: 'POST', body: { url: fileUrl.value, label: fileLabel.value } }); refresh(); } catch (e) { toast(e.message, 'danger'); } } })),
      h('p', { class: 'muted small' }, 'Links open in Google Drive with the file’s own sharing settings.'),
      h('h3', { class: 'kv-head' }, 'Comments'), comments, box.el,
      h('div', { class: 'row' }, button('Comment', { variant: 'primary', iconName: 'send', onClick: async () => { const body = box.value(); if (!body) return; try { await api(`/api/cards/${cardId}/comments`, { method: 'POST', body: { body, mentions: box.mentions() } }); box.clear(); refresh(); } catch (e) { toast(e.message, 'danger'); } } })),
      h('details', { class: 'card-activity' }, h('summary', {}, 'Activity'), h('ul', {}, d.activity.map((a) => h('li', {}, h('strong', {}, a.actor || 'GB People'), ` ${a.action}${a.detail ? `: ${a.detail}` : ''} `, h('time', { class: 'muted' }, when(a.created_at))))))) });
    document.querySelector('.drawer')?.classList.add('card-drawer');
    const cm = new URLSearchParams(location.hash.split('?')[1] || '').get('comment');
    if (cm) document.getElementById(`comment-${cm}`)?.scrollIntoView({ block: 'center' });
  }

  const root = h('div', { class: 'project-page' }, engagementHeader(overview, 'board', team),
    h('div', { class: 'toolbar board-tools' }, chipsBox, v.workstreams.length ? wsSel : null, h('span', { class: 'muted board-hint' }, v.can.edit ? 'Drag cards, or open one and change its status. Alt + ← / → moves a focused card.' : 'You can view this board.')),
    status, boardEl);
  draw();
  if (params.get('card')) setTimeout(() => openCard(params.get('card')), 0);
  root.modern = true; root.noHeader = true; root.area = 'work';
  return root;
}
