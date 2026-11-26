// Offboarding (leaver checklist) and Training (courses, hours, certificates).
import { h, icon, button, badge, card, emptyState, field, input, select, toast, openDrawer, statStrip, filterChips, confirmModal } from '/ui.js';

const fmt = (s) => (s ? new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const OWNER = { leaver: 'Leaver', manager: 'Manager', hr: 'People Ops' };

export async function offboardingScreen({ api, me }) {
  const root = h('div', { class: 'stack' });
  const people = await api('/api/people').catch(() => []);
  function start(v) {
    const who = select([['', 'Choose the person…'], ...people.map((p) => [p.id, p.name])], { id: 'ob-who' });
    const day = input({ id: 'ob-day', type: 'date' }); const kind = select(v.kinds.map((k) => [k, k[0].toUpperCase() + k.slice(1)]), { id: 'ob-kind' });
    openDrawer({ title: 'Start offboarding', iconName: 'log-out', body: h('div', { class: 'stack' }, field({ label: 'Who is leaving', id: 'ob-who', control: who }), field({ label: 'Last working day', id: 'ob-day', control: day }), field({ label: 'Reason', id: 'ob-kind', control: kind }),
      h('p', { class: 'muted' }, 'The leaver and their manager get their steps in the inbox. Nothing about the reason is shown to colleagues.')),
    footer: (close) => button('Start', { variant: 'primary', iconName: 'check', onClick: async () => { try { await api('/api/offboarding', { method: 'POST', body: { user_id: who.value, last_day: day.value, kind: kind.value } }); toast('Offboarding started'); close(); draw(); } catch (e) { toast(e.message, 'danger'); } } }) });
  }
  async function draw() {
    const v = await api('/api/offboarding');
    root.replaceChildren(h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, 'Leaver checklist: handover, equipment, access removal, final settlement. Completing it switches the account off; history is kept.'),
      v.canManage ? button('Start offboarding', { variant: 'primary', iconName: 'plus', onClick: () => start(v) }) : null),
      ...(v.items.length ? v.items.map((o) => { const done = o.steps.filter((s) => s.done_at).length;
        return card({ title: `${o.name} — last day ${fmt(o.last_day)}`, iconName: 'log-out', actions: [badge(o.status === 'open' ? `${done} of ${o.steps.length} done` : o.status, o.status === 'completed' ? 'success' : 'info'),
          v.canManage && o.status === 'open' ? button('Complete and switch the account off', { size: 'sm', variant: 'primary', iconName: 'check', onClick: async () => {
            if (!(await confirmModal({ title: `Switch off ${o.name}’s account?`, text: 'They can no longer sign in. Their reviews, timesheets and history stay.', confirmLabel: 'Complete', tone: 'danger' }))) return;
            try { await api(`/api/offboarding/${o.id}/complete`, { method: 'POST', body: { deactivate: true } }); toast('Offboarding complete'); draw(); } catch (e) { toast(e.message, 'danger'); } } }) : null],
          body: h('ul', { class: 'check-list' }, o.steps.map((s) => h('li', {}, h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!s.done_at, disabled: o.status !== 'open',
            onchange: async (e) => { try { await api(`/api/offboarding/steps/${s.id}`, { method: 'POST', body: { done: e.target.checked } }); draw(); } catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'danger'); } } }),
            h('span', {}, s.title, h('span', { class: 'muted' }, ` · ${OWNER[s.owner]}${s.done_at ? ` · done by ${s.done_by_name} ${fmt(s.done_at)}` : ''}`)))))) }); })
        : [emptyState({ iconName: 'log-out', title: 'No one is leaving', text: v.canManage ? 'Start an offboarding when someone resigns or a contract ends.' : null })]));
  }
  await draw(); root.modern = true;
  return root;
}

const KIND = { course: 'Course', certification: 'Certification', workshop: 'Workshop', conference: 'Conference', self_study: 'Self-study' };
export async function trainingScreen({ api, me }) {
  const root = h('div', { class: 'stack' });
  const canAll = me.roles.includes('partner') || me.roles.includes('people_ops') || me.roles.includes('admin');
  let tab = 'mine';
  function edit(t = null) {
    const title = input({ id: 'tr-title', value: t?.title || '', placeholder: 'e.g. PMP certification, Power BI course' }); const prov = input({ id: 'tr-prov', value: t?.provider || '', placeholder: 'e.g. PMI, Coursera' });
    const kind = select(Object.entries(KIND), { id: 'tr-kind' }); kind.value = t?.kind || 'course';
    const s = input({ id: 'tr-s', type: 'date', value: t?.start_on || '' }); const e = input({ id: 'tr-e', type: 'date', value: t?.end_on || '' });
    const hrs = input({ id: 'tr-h', type: 'number', min: 0, step: 0.5, value: t ? t.hours_x100 / 100 : '' }); const exp = input({ id: 'tr-x', type: 'date', value: t?.expires_on || '' });
    const file = h('input', { type: 'file', id: 'tr-f', accept: 'application/pdf,image/png,image/jpeg,image/webp' });
    openDrawer({ title: t ? 'Edit training' : 'Add training', iconName: 'award', body: h('div', { class: 'stack' }, field({ label: 'Title', id: 'tr-title', control: title }),
      h('div', { class: 'form-grid' }, field({ label: 'Type', id: 'tr-kind', control: kind }), field({ label: 'Provider', id: 'tr-prov', control: prov }), field({ label: 'Started', id: 'tr-s', control: s }), field({ label: 'Finished', id: 'tr-e', control: e }),
        field({ label: 'Hours', id: 'tr-h', control: hrs }), field({ label: 'Certificate expires', id: 'tr-x', control: exp, help: 'You get a reminder 60 days before' })),
      field({ label: 'Certificate or proof (PDF or photo, optional)', id: 'tr-f', control: file })),
    footer: (close) => button('Save', { variant: 'primary', iconName: 'check', onClick: async () => {
      const q = new URLSearchParams({ ...(t ? { id: t.id } : {}), title: title.value, provider: prov.value, kind: kind.value, start_on: s.value, end_on: e.value, hours: hrs.value, expires_on: exp.value, name: file.files[0]?.name || '' });
      try { await api(`/api/training?${q}`, { method: 'POST', raw: file.files[0] || new Blob([]) }); toast('Saved'); close(); draw(); } catch (err) { toast(err.message, 'danger'); }
    } }) });
  }
  async function person(p) {
    const v = await api(`/api/training/${p.id}`);
    openDrawer({ title: `${p.name} — training`, iconName: 'award', body: v.rows.length ? h('ul', { class: 'eng-list' }, v.rows.map((t) => h('li', { class: 'kpi-row' },
      h('div', {}, h('strong', {}, t.title), h('div', { class: 'muted' }, [KIND[t.kind], t.provider, `${t.hours_x100 / 100} h`, t.expires_on ? `expires ${fmt(t.expires_on)}` : null].filter(Boolean).join(' · '))),
      h('div', { class: 'eng-side' }, t.has_file ? h('a', { class: 'btn btn-ghost btn-sm', href: `/api/training/${t.id}/file`, target: '_blank', rel: 'noopener' }, icon('paperclip'), h('span', {}, 'Proof')) : null,
        t.verified_at ? badge('Verified', 'success') : v.canVerify ? button('Verify', { size: 'sm', iconName: 'check', onClick: async () => { await api(`/api/training/${t.id}/verify`, { method: 'POST' }); toast('Verified'); document.querySelector('.drawer header .btn')?.click(); person(p); } }) : null)))) : emptyState({ iconName: 'award', title: 'Nothing recorded' }) });
  }
  async function draw() {
    const tabs = canAll ? filterChips([{ value: 'mine', label: 'My training' }, { value: 'team', label: 'Team overview' }], tab, (x) => { tab = x; draw(); }) : null;
    if (tab === 'team') {
      const o = await api('/api/training/overview');
      root.replaceChildren(h('div', { class: 'toolbar' }, tabs), h('div', { class: 'report-grid' },
        card({ title: `Training hours ${new Date().getFullYear()}`, iconName: 'award', body: h('ul', { class: 'eng-list' }, o.people.map((p) => h('li', { class: 'kpi-row' },
          h('button', { type: 'button', class: 'link-btn', onclick: () => person(p) }, p.name), h('strong', {}, `${Math.round(p.hours_x100 / 100)} h · ${p.records} record${p.records === 1 ? '' : 's'}`)))) }),
        card({ title: 'Certificates expiring in 90 days', iconName: 'triangle-alert', body: o.expiring.length ? h('ul', { class: 'bullets' }, o.expiring.map((x) => h('li', {}, `${x.name} — ${x.title}: ${fmt(x.expires_on)}`))) : h('p', { class: 'muted' }, 'None.') })));
      return;
    }
    const v = await api('/api/training/me');
    root.replaceChildren(h('div', { class: 'toolbar' }, tabs, button('Add training', { variant: 'primary', iconName: 'plus', onClick: () => edit() })),
      statStrip([{ iconName: 'award', value: `${Math.round(v.hours_this_year_x100 / 100)} h`, label: `training this year` }, { iconName: 'file-check-2', value: String(v.rows.filter((r) => r.kind === 'certification').length), label: 'certifications' }]),
      v.rows.length ? h('ul', { class: 'eng-list' }, v.rows.map((t) => h('li', { class: 'eng-item' }, h('div', { class: 'eng-main' }, h('strong', {}, t.title),
        h('div', { class: 'eng-meta muted' }, h('span', {}, KIND[t.kind]), t.provider ? h('span', {}, t.provider) : null, h('span', {}, `${t.hours_x100 / 100} h`), t.end_on ? h('span', {}, `Finished ${fmt(t.end_on)}`) : null,
          t.expires_on ? h('span', {}, `Expires ${fmt(t.expires_on)}`) : null)),
        h('div', { class: 'eng-side' }, t.verified_at ? badge('Verified', 'success') : badge('Not verified yet', 'neutral'), t.has_file ? h('a', { class: 'btn btn-ghost btn-sm', href: `/api/training/${t.id}/file`, target: '_blank', rel: 'noopener' }, icon('paperclip'), h('span', {}, 'Proof')) : null,
          button('', { size: 'sm', variant: 'ghost', iconName: 'pencil', ariaLabel: `Edit ${t.title}`, onClick: () => edit(t) }),
          button('', { size: 'sm', variant: 'ghost', iconName: 'trash-2', ariaLabel: `Delete ${t.title}`, onClick: async () => { if (await confirmModal({ title: `Delete “${t.title}”?`, confirmLabel: 'Delete', tone: 'danger' })) { await api(`/api/training/${t.id}/delete`, { method: 'POST' }); draw(); } } })))))
        : emptyState({ iconName: 'award', title: 'No training recorded yet', text: 'Add courses, workshops and certifications — with hours and expiry dates.' }));
  }
  await draw(); root.modern = true;
  return root;
}
