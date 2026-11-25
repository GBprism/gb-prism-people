// Messages: direct and group conversations between colleagues. Only members can read them.
import { h, icon, button, badge, emptyState, field, input, select, toast, openDrawer, avatar } from '/ui.js';

const when = (iso) => { const d = new Date(iso); const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };

export async function messagesScreen({ api, me, query = '' }) {
  let current = new URLSearchParams(query).get('c');
  const [people, projects] = await Promise.all([api('/api/people').catch(() => []), api('/api/projects').catch(() => [])]);
  const team = await api('/api/team').catch(() => []);
  const photoOf = (id) => team.find((p) => p.id === id) || { name: people.find((p) => p.id === id)?.name || '?' };
  const listEl = h('ul', { class: 'conv-list', 'aria-label': 'Conversations' });
  const thread = h('div', { class: 'thread', 'aria-live': 'polite' });
  const head = h('div', { class: 'thread-head' });
  const text = h('textarea', { class: 'textarea composer', rows: 2, placeholder: 'Write a message…', 'aria-label': 'Message' });
  let last = null; let convs = []; let timer = null;

  async function loadList() {
    const r = await api('/api/messages'); convs = r.conversations;
    listEl.replaceChildren(...(convs.length ? convs.map((c) => h('li', {}, h('button', { type: 'button', class: `conv${c.id === current ? ' active' : ''}`, 'aria-current': c.id === current ? 'true' : null, onclick: () => open(c.id) },
      c.kind === 'direct' ? avatar(photoOf(c.other_id), 'sm') : h('span', { class: 'conv-group' }, icon('users')),
      h('span', { class: 'conv-text' }, h('strong', {}, c.title), h('span', { class: 'muted' }, c.last_body ? `${c.last_mine ? 'You: ' : ''}${c.last_body}` : 'No messages yet')),
      h('span', { class: 'conv-side' }, h('span', { class: 'muted' }, when(c.last_at)), c.unread ? badge(String(c.unread), 'info') : null))))
      : [h('li', { class: 'muted conv-empty' }, 'No conversations yet. Start one with “New message”.')]));
  }

  const bubble = (m) => h('div', { class: `bubble${m.mine ? ' mine' : ''}` }, m.mine ? null : h('span', { class: 'bubble-who' }, m.sender), h('p', {}, m.body), h('time', { datetime: m.created_at }, when(m.created_at)));
  async function open(id, poll = false) {
    current = id; history.replaceState(null, '', `#/messages?c=${id}`);
    const r = await api(`/api/messages/${id}${poll && last ? `?after=${encodeURIComponent(last)}` : ''}`);
    const c = convs.find((x) => x.id === id);
    if (!poll) {
      head.replaceChildren(h('strong', {}, c?.title || 'Conversation'), c ? h('span', { class: 'muted' }, c.people.map((p) => p.name).join(', ')) : null);
      thread.replaceChildren(...(r.messages.length ? r.messages.map(bubble) : [h('p', { class: 'muted thread-empty' }, 'Say hello 👋')]));
      root.classList.add('has-thread');
    } else if (r.messages.length) { thread.querySelector('.thread-empty')?.remove(); thread.append(...r.messages.map(bubble)); }
    if (r.messages.length) last = r.messages.at(-1).created_at;
    thread.scrollTop = thread.scrollHeight;
    if (!poll) { loadList(); text.focus(); }
  }
  async function send() {
    const body = text.value.trim(); if (!body || !current) return;
    text.value = '';
    try { await api(`/api/messages/${current}`, { method: 'POST', body: { text: body } }); await open(current, true); loadList(); } catch (e) { text.value = body; toast(e.message, 'danger'); }
  }
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  function newMessage() {
    const who = select([['', 'Choose a colleague…'], ...people.map((p) => [p.id, p.name])], { id: 'nm-who' });
    const gname = input({ id: 'nm-name', placeholder: 'e.g. Modon team' });
    const proj = select([['', 'No project'], ...projects.filter((p) => p.kind === 'engagement').map((p) => [p.id, p.name])], { id: 'nm-proj' });
    const picks = new Set();
    const list = h('ul', { class: 'check-list' }, people.map((p) => h('li', {}, h('label', { class: 'check-row' }, h('input', { type: 'checkbox', onchange: (e) => (e.target.checked ? picks.add(p.id) : picks.delete(p.id)) }), p.name))));
    openDrawer({ title: 'New message', iconName: 'messages-square', body: h('div', { class: 'stack' },
      h('h3', { class: 'kv-head' }, 'To one person'), field({ label: 'Colleague', id: 'nm-who', control: who }),
      button('Start conversation', { variant: 'primary', iconName: 'send', onClick: async () => { if (!who.value) return toast('Choose a colleague', 'danger'); const { id } = await api('/api/messages/direct', { method: 'POST', body: { userId: who.value } }); document.querySelector('.drawer header button')?.click(); await loadList(); open(id); } }),
      h('h3', { class: 'kv-head' }, 'Or a group'), field({ label: 'Group name', id: 'nm-name', control: gname }),
      field({ label: 'Add everyone on a project', id: 'nm-proj', control: proj, help: 'Optional — the lead and the team are added' }), list,
      button('Create group', { iconName: 'users', onClick: async () => { try { const { id } = await api('/api/messages/groups', { method: 'POST', body: { title: gname.value, memberIds: [...picks], projectId: proj.value || null } }); document.querySelector('.drawer header button')?.click(); await loadList(); open(id); } catch (e) { toast(e.message, 'danger'); } } })) });
  }

  const root = h('div', { class: 'messages' },
    h('aside', { class: 'conv-pane' }, h('div', { class: 'conv-head' }, h('strong', {}, 'Conversations'), button('New message', { size: 'sm', variant: 'primary', iconName: 'plus', onClick: newMessage })), listEl),
    h('section', { class: 'thread-pane' }, h('div', { class: 'thread-top' }, button('', { iconName: 'chevron-left', ariaLabel: 'Back to conversations', size: 'sm', onClick: () => { root.classList.remove('has-thread'); current = null; } }), head),
      thread, h('div', { class: 'composer-row' }, text, button('Send', { variant: 'primary', iconName: 'send', onClick: send }))));
  await loadList();
  if (current) await open(current); else thread.replaceChildren(emptyState({ iconName: 'messages-square', title: 'Pick a conversation', text: 'Messages are private to the people in the conversation.' }));
  // poll for new messages while this page is open
  timer = setInterval(() => { if (!document.body.contains(root)) return clearInterval(timer); if (document.hidden) return; loadList(); if (current) open(current, true); }, 8000);
  root.modern = true;
  return root;
}
