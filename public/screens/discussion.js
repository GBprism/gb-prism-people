// Project discussion: the engagement's shared conversation (the same conversation as in Messages).
// Project-wide updates and coordination; replies go in threads; @mentions and #card links; the lead
// pins decisions; any message can become a task on the board, which links back to it.
import { h, icon, button, emptyState, field, input, select, toast, openDrawer, avatar } from '/ui.js';
import { engagementHeader } from '/screens/project.js';
import { composer, renderRich } from '/rich.js';

const when = (iso) => { const d = new Date(iso); const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };

export async function discussionScreen({ api, me, id, query = '' }) {
  const [overview, team, conv] = await Promise.all([api(`/api/projects/${encodeURIComponent(id)}/overview`), api('/api/team').catch(() => []), api(`/api/projects/${encodeURIComponent(id)}/discussion`)]);
  const [people, board] = await Promise.all([api(`/api/projects/${id}/people`), api(`/api/projects/${id}/board`)]);
  const focus = new URLSearchParams(query).get('m');
  const photo = (uid) => team.find((p) => p.id === uid) || { name: people.find((p) => p.id === uid)?.name || '?' };
  const others = people.filter((p) => p.id !== me.id);
  const list = h('ol', { class: 'disc-list', 'aria-label': 'Messages' });
  const pinnedBox = h('div');
  let data; let timer;

  function menu(m) {
    const items = [
      ['Reply in thread', 'messages-square', () => openThread(m.id)],
      board.can.edit ? ['Create task from message', 'list-checks', () => createTask(m)] : null,
      data.can?.pin ? [m.pinned ? 'Unpin' : 'Pin as a decision', 'target', async () => { await api(`/api/messages/${conv.id}/pin/${m.id}`, { method: 'POST', body: { pin: !m.pinned } }); toast(m.pinned ? 'Unpinned' : 'Pinned for the team'); load(); }] : null,
      ['Copy link', 'external-link', async () => { const url = `${location.origin}/#/project/${id}/discussion?m=${m.id}`; try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); } }],
    ].filter(Boolean);
    const pop = h('div', { class: 'menu', role: 'menu', hidden: true }, items.map(([label, ic, fn]) => h('button', { type: 'button', class: 'menu-item', role: 'menuitem', onclick: () => { pop.hidden = true; fn(); } }, icon(ic), label)));
    const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': `Actions for the message from ${m.sender}`, 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); document.querySelectorAll('.disc-msg .menu').forEach((x) => { if (x !== pop) x.hidden = true; }); pop.hidden = !pop.hidden; if (!pop.hidden) pop.querySelector('button')?.focus(); } });
    btn.append(icon('ellipsis'));
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { pop.hidden = true; btn.focus(); } });
    return h('div', { class: 'menu-anchor' }, btn, pop);
  }

  const msgEl = (m, { inThread = false } = {}) => h('li', { class: `disc-msg${m.id === focus ? ' is-focus' : ''}`, id: `m-${m.id}` },
    avatar(photo(m.sender_id), 'sm'),
    h('div', { class: 'disc-body' },
      h('div', { class: 'disc-head' }, h('strong', {}, m.sender), h('time', { class: 'muted', datetime: m.created_at }, when(m.created_at)), m.pinned ? h('span', { class: 'pin-flag' }, icon('target'), `Pinned by ${m.pinned.by}`) : null),
      h('p', {}, renderRich(m.body, { people })),
      m.tasks?.length ? h('div', { class: 'disc-tasks' }, m.tasks.map((t) => h('a', { class: 'chip-link', href: `#/project/${t.project_id}/board?card=${t.id}` }, icon('list-checks'), h('span', {}, `Task: ${t.title}`)))) : null,
      !inThread ? h('div', { class: 'disc-actions' }, h('button', { type: 'button', class: 'text-link', onclick: () => openThread(m.id) }, m.replies ? `${m.replies} repl${m.replies === 1 ? 'y' : 'ies'}` : 'Reply')) : null),
    inThread ? null : menu(m));

  async function load() {
    data = await api(`/api/messages/${conv.id}`);
    pinnedBox.replaceChildren(...(data.pinned?.length ? [h('section', { class: 'pinned', 'aria-labelledby': 'pin-h' }, h('h2', { id: 'pin-h' }, icon('target'), 'Pinned decisions'),
      h('ul', {}, data.pinned.map((m) => h('li', {}, h('a', { href: `#/project/${id}/discussion?m=${m.id}`, onclick: (e) => { e.preventDefault(); document.getElementById(`m-${m.id}`)?.scrollIntoView({ block: 'center' }); } }, renderRich(m.body.slice(0, 160), { people })), h('span', { class: 'muted' }, ` — ${m.sender}, ${when(m.created_at)}`)))))] : []));
    list.replaceChildren(...(data.messages.length ? data.messages.map((m) => msgEl(m)) : [h('li', {}, emptyState({ iconName: 'messages-square', title: 'No messages yet', text: 'Post project-wide updates here. Feedback on one deliverable goes in that card’s comments.' }))]));
  }

  const box = composer({ people: others, cards: board.cards, placeholder: `Message the ${overview.name} team. @ to mention, # to link a card`, label: 'Message the team', onSubmit: () => send() });
  async function send() {
    const text = box.value(); if (!text) return;
    try { await api(`/api/messages/${conv.id}`, { method: 'POST', body: { text, mentions: box.mentions() } }); box.clear(); await load(); list.lastElementChild?.scrollIntoView({ block: 'end' }); } catch (e) { toast(e.message, 'danger'); }
  }

  async function openThread(mid) {
    const t = await api(`/api/messages/${conv.id}?thread=${mid}`);
    const reply = composer({ people: others, cards: board.cards, placeholder: 'Reply in thread…', label: 'Reply', onSubmit: () => sendReply() });
    const ol = h('ol', { class: 'disc-list thread-list' }, t.messages.map((m, i) => { const el = msgEl(m, { inThread: true }); if (i === 0) el.classList.add('thread-root'); return el; }));
    let close;
    async function sendReply() {
      const text = reply.value(); if (!text) return;
      try { await api(`/api/messages/${conv.id}`, { method: 'POST', body: { text, mentions: reply.mentions(), parentId: mid } }); close(); await load(); openThread(mid); } catch (e) { toast(e.message, 'danger'); }
    }
    close = openDrawer({ title: 'Thread', iconName: 'messages-square', body: h('div', { class: 'stack' }, ol, reply.el), footer: () => button('Reply', { variant: 'primary', iconName: 'send', onClick: sendReply }) });
    document.querySelector('.drawer')?.classList.add('card-drawer');
  }

  function createTask(m) {
    const plain = m.body.replace(/\[\[card:[^|\]]+\|([^\]]+)\]\]/g, '$1').replace(/\s+/g, ' ').trim();
    const title = input({ id: 'tm-title', value: plain.slice(0, 120) });
    const owner = select([['', 'No owner yet'], ...people.map((p) => [p.id, p.name])], { id: 'tm-owner' });
    const due = input({ id: 'tm-due', type: 'date' });
    openDrawer({ title: 'Create task from message', iconName: 'list-checks', body: h('div', { class: 'stack' },
      h('p', { class: 'callout' }, `“${plain.slice(0, 200)}” — ${m.sender}`),
      field({ label: 'Task title', id: 'tm-title', control: title }), h('div', { class: 'form-grid' }, field({ label: 'Owner', id: 'tm-owner', control: owner }), field({ label: 'Due date', id: 'tm-due', control: due })),
      h('p', { class: 'muted' }, 'The task goes to To do on the board and keeps a link back to this message. To record a decision instead, pin the message.')),
    footer: (close) => button('Create task', { variant: 'primary', iconName: 'plus', onClick: async () => {
      try { const c = await api(`/api/projects/${id}/cards`, { method: 'POST', body: { title: title.value, owner_id: owner.value || null, due_date: due.value || null, source_message_id: m.id } });
        close(); toast('Task created on the board'); await load();
        document.getElementById(`m-${m.id}`)?.querySelector('.disc-tasks a')?.focus(); board.cards.push(c);
      } catch (e) { toast(e.message, 'danger'); } } }) });
  }

  await load();
  document.addEventListener('click', (e) => { if (!e.target.closest?.('.disc-msg .menu-anchor')) document.querySelectorAll('.disc-msg .menu').forEach((x) => { x.hidden = true; }); });
  const root = h('div', { class: 'project-page' }, engagementHeader(overview, 'discussion', team),
    h('div', { class: 'disc-intro' }, h('p', { class: 'muted' }, `Visible to the ${people.length} people on this engagement${overview.lead ? `, led by ${overview.lead.name}` : ''}. Feedback on one deliverable belongs in that card’s comments.`),
      h('a', { class: 'text-link', href: `#/messages?c=${conv.id}` }, 'Open in Messages', icon('arrow-right'))),
    pinnedBox, h('section', { class: 'card disc-card' }, h('div', { class: 'card-body' }, list), h('div', { class: 'disc-composer' }, box.el, button('Send', { variant: 'primary', iconName: 'send', onClick: send }))));
  if (focus) setTimeout(() => { const el = document.getElementById(`m-${focus}`); if (el) { el.scrollIntoView({ block: 'center' }); const d = data.messages.find((x) => x.id === focus); if (d?.replies) openThread(focus); } else openThread(focus).catch(() => {}); }, 50);
  timer = setInterval(() => { if (!document.body.contains(root)) return clearInterval(timer); if (!document.hidden && !document.querySelector('.drawer')) load(); }, 10000);
  root.modern = true; root.noHeader = true; root.area = 'work';
  return root;
}
