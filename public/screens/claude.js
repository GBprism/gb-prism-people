// Claude accounts: GB's seats, which are active, who works on each and on what.
import { h, icon, button, badge, card, emptyState, field, input, select, textarea, toast, openDrawer, statStrip, avatar } from '/ui.js';

const ST = { active: ['Active', 'success'], paused: ['Paused', 'warning'], closed: ['Closed', 'neutral'] };

export async function claudeScreen({ api, me }) {
  const [people, projects, team] = await Promise.all([api('/api/people').catch(() => []), api('/api/active-projects').catch(() => []), api('/api/team').catch(() => [])]);
  const everyone = [{ id: me.id, name: me.name }, ...people].sort((a, b) => a.name.localeCompare(b.name));
  const root = h('div', { class: 'stack' });

  function edit(v, a = null) {
    const email = input({ id: 'ca-email', type: 'email', value: a?.seat_email || '', placeholder: 'seat@gb-advisory.com' });
    const plan = input({ id: 'ca-plan', value: a?.plan || 'Team' });
    const status = select([['active', 'Active'], ['paused', 'Paused'], ['closed', 'Closed']], { id: 'ca-status' }); status.value = a?.status || 'active';
    const limit = input({ id: 'ca-limit', value: a?.monthly_limit || '', placeholder: 'e.g. spend limit 50 USD / month' });
    const notes = textarea({ id: 'ca-notes', rows: 2 }, a?.notes || '');
    const rows = (a?.users || []).map((u) => ({ ...u }));
    const list = h('div', { class: 'stack' });
    const drawRows = () => list.replaceChildren(...rows.map((u, i) => {
      const who = select(everyone.map((p) => [p.id, p.name]), { 'aria-label': 'Person', class: 'select select-sm', onchange: (e) => { u.id = e.target.value; } }); who.value = u.id || '';
      const prj = select([['', 'Project…'], ...projects.map((p) => [p.id, p.name])], { 'aria-label': 'Project', class: 'select select-sm', onchange: (e) => { u.project_id = e.target.value; } }); prj.value = u.project_id || '';
      const what = input({ 'aria-label': 'Working on', class: 'input input-sm', value: u.working_on || '', placeholder: 'Working on…', oninput: (e) => { u.working_on = e.target.value; } });
      return h('div', { class: 'row' }, who, prj, what, button('', { size: 'sm', variant: 'ghost', iconName: 'trash-2', ariaLabel: 'Remove', onClick: () => { rows.splice(i, 1); drawRows(); } }));
    }), button('Add person', { size: 'sm', iconName: 'plus', onClick: () => { rows.push({ id: everyone[0]?.id }); drawRows(); } }));
    drawRows();
    openDrawer({ title: a ? a.seat_email : 'Add a Claude account', iconName: 'bot', body: h('div', { class: 'stack' },
      h('div', { class: 'form-grid' }, field({ label: 'Seat email', id: 'ca-email', control: email, required: true }), field({ label: 'Plan', id: 'ca-plan', control: plan }),
        field({ label: 'Status', id: 'ca-status', control: status }), field({ label: 'Limit', id: 'ca-limit', control: limit })),
      field({ label: 'Notes', id: 'ca-notes', control: notes }), h('h3', { class: 'kv-head' }, 'Who uses it and on what'), list),
    footer: (close) => button('Save', { variant: 'primary', iconName: 'check', onClick: async () => {
      const body = { seat_email: email.value, plan: plan.value, status: status.value, monthly_limit: limit.value, notes: notes.value, users: rows.filter((u) => u.id).map((u) => ({ user_id: u.id, project_id: u.project_id || null, working_on: u.working_on || null })) };
      try { await (a ? api(`/api/claude-accounts/${a.id}`, { method: 'PATCH', body }) : api('/api/claude-accounts', { method: 'POST', body })); toast('Saved'); close(); draw(); } catch (e) { toast(e.message, 'danger'); }
    } }) });
  }

  async function myWork(a, u) {
    const prj = select([['', 'No project'], ...projects.map((p) => [p.id, p.name])], { id: 'mw-prj' }); prj.value = u.project_id || '';
    const what = input({ id: 'mw-what', value: u.working_on || '', placeholder: 'e.g. drafting the procurement manual' });
    openDrawer({ title: 'What I use this seat for', iconName: 'bot', body: h('div', { class: 'stack' }, field({ label: 'Project', id: 'mw-prj', control: prj }), field({ label: 'Working on', id: 'mw-what', control: what })),
      footer: (close) => button('Save', { variant: 'primary', iconName: 'check', onClick: async () => { await api(`/api/claude-accounts/${a.id}/my-work`, { method: 'POST', body: { project_id: prj.value || null, working_on: what.value } }); toast('Saved'); close(); draw(); } }) });
  }

  async function draw() {
    const v = await api('/api/claude-accounts');
    const person = (u) => team.find((t) => t.id === u.id) || u;
    root.replaceChildren(
      h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, icon('info'), ' One Claude Project per engagement; start on Sonnet. See Policies → AI and Claude usage.'),
        v.canEdit ? button('Add account', { variant: 'primary', iconName: 'plus', onClick: () => edit(v) }) : null),
      statStrip([{ iconName: 'bot', value: String(v.active), label: 'active accounts' }, { iconName: 'users', value: String(new Set(v.accounts.filter((a) => a.status === 'active').flatMap((a) => a.users.map((u) => u.id))).size), label: 'people with access' },
        { iconName: 'user', value: String(v.without.length), label: 'people without a seat' }]),
      v.accounts.length ? h('div', { class: 'active-grid' }, v.accounts.map((a) => card({ title: a.seat_email, iconName: 'bot',
        actions: [badge(...ST[a.status]), v.canEdit ? button('Edit', { size: 'sm', variant: 'ghost', iconName: 'pencil', onClick: () => edit(v, a) }) : null],
        body: h('div', { class: 'stack' }, h('div', { class: 'eng-meta muted' }, h('span', {}, `${a.plan} plan`), a.monthly_limit ? h('span', {}, a.monthly_limit) : null, h('span', {}, `${a.users.length} ${a.users.length === 1 ? 'person' : 'people'}`)),
          a.users.length ? h('ul', { class: 'eng-list' }, a.users.map((u) => h('li', { class: 'kpi-row' }, h('div', { class: 'team-head' }, avatar(person(u), 'sm'), h('div', {}, h('strong', {}, u.name),
            h('div', { class: 'muted' }, [u.project, u.working_on].filter(Boolean).join(' — ') || 'Not said yet what they are working on'))),
            u.id === me.id ? button('Update', { size: 'sm', variant: 'ghost', iconName: 'pencil', onClick: () => myWork(a, u) }) : null))) : h('p', { class: 'muted' }, 'Nobody assigned'),
          a.notes ? h('p', { class: 'eng-scope' }, a.notes) : null) }))) : emptyState({ iconName: 'bot', title: 'No Claude accounts recorded yet' }),
      v.without.length ? card({ title: 'Without a Claude seat', iconName: 'user', body: h('p', { class: 'muted' }, v.without.map((u) => u.name).join(', ')) }) : null);
  }
  await draw(); root.modern = true;
  return root;
}
