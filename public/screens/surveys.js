// Surveys: the anonymous team pulse (everyone answers; partners and People Ops see results once 3+
// people answered) and client feedback links sent after an engagement.
import { h, icon, button, badge, card, emptyState, field, input, textarea, select, toast, openDrawer, statStrip, filterChips } from '/ui.js';

const fmt = (s) => (s ? new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

function scaleControl(q, name) {
  const min = q.nps ? 0 : 1;
  return h('fieldset', { class: 'sv-q-app' }, h('legend', {}, q.text),
    h('div', { class: 'rating-seg' }, Array.from({ length: q.scale - min + 1 }, (_, i) => i + min).map((v) => h('label', {}, h('input', { type: 'radio', name, value: v }), h('span', {}, String(v))))),
    h('div', { class: 'sv-ends-app muted' }, h('span', {}, q.nps ? 'Not at all likely' : 'Strongly disagree'), h('span', {}, q.nps ? 'Extremely likely' : 'Strongly agree')));
}

export async function surveysScreen({ api }) {
  const root = h('div', { class: 'stack' });
  let tab = 'pulse';
  const projects = await api('/api/projects').catch(() => []);

  function answer(v, p) {
    const form = h('form', { class: 'stack', onsubmit: (e) => e.preventDefault() }, ...v.pulse_questions.map((q) => scaleControl(q, `pq_${q.key}`)),
      field({ label: 'Anything else? (optional)', id: 'pq-comment', control: textarea({ id: 'pq-comment', rows: 3 }) }));
    openDrawer({ title: p.title, iconName: 'messages-square', body: h('div', { class: 'stack' }, h('p', { class: 'callout' }, icon('lock'), ' Anonymous. Your answers are stored apart from your name, and results show only once at least 3 people have answered.'), form),
      footer: (close) => button('Send my answers', { variant: 'primary', iconName: 'send', onClick: async () => {
        const answers = Object.fromEntries(v.pulse_questions.map((q) => [q.key, form.querySelector(`input[name="pq_${q.key}"]:checked`)?.value]).filter(([, x]) => x != null));
        try { await api(`/api/surveys/${p.id}/answer`, { method: 'POST', body: { answers, comment: form.querySelector('#pq-comment').value } }); toast('Thank you'); close(); draw(); } catch (e) { toast(e.message, 'danger'); }
      } }) });
  }

  function newClient() {
    const proj = select([['', 'Choose the engagement…'], ...projects.filter((p) => p.kind === 'engagement').map((p) => [p.id, p.name])], { id: 'cs-proj' });
    const name = input({ id: 'cs-name', placeholder: 'e.g. Dr. Rania Haddad' }); const email = input({ id: 'cs-email', type: 'email', placeholder: 'name@client.com' });
    const send = h('input', { type: 'checkbox', id: 'cs-send', checked: true });
    openDrawer({ title: 'Ask a client for feedback', iconName: 'send', body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'The client gets a private link (no sign-in) with six questions; it can be used once and expires in 30 days.'),
      field({ label: 'Engagement', id: 'cs-proj', control: proj, required: true }), field({ label: 'Client contact name', id: 'cs-name', control: name }), field({ label: 'Client contact email', id: 'cs-email', control: email }),
      h('label', { class: 'check-row' }, send, 'Email the link to them now (from GB People)')),
    footer: (close) => button('Create the link', { variant: 'primary', iconName: 'check', onClick: async () => {
      try {
        const r = await api('/api/surveys/client', { method: 'POST', body: { project_id: proj.value, contact_name: name.value, contact_email: email.value, send: send.checked } });
        close();
        const box = input({ value: r.link, readonly: true, id: 'cs-link' });
        openDrawer({ title: 'Survey link ready', iconName: 'check', body: h('div', { class: 'stack' }, h('p', {}, r.emailed ? 'Emailed to the client. You can also copy the link:' : 'Copy the link and send it to the client:'), box,
          button('Copy link', { iconName: 'clipboard-list', onClick: async () => { try { await navigator.clipboard.writeText(r.link); toast('Copied'); } catch { box.select(); } } }),
          h('p', { class: 'muted' }, 'The link is shown only now. If it is lost, create a new one.')) });
        draw();
      } catch (e) { toast(e.message, 'danger'); }
    } }) });
  }

  async function draw() {
    const v = await api('/api/surveys');
    const tabs = filterChips([{ value: 'pulse', label: 'Team pulse', iconName: 'users' }, v.clients.length || v.canManage ? { value: 'client', label: 'Client feedback', iconName: 'building-2' } : null].filter(Boolean), tab, (x) => { tab = x; draw(); });
    const k = v.kpis;
    const kp = k ? statStrip([{ iconName: 'award', value: k.quality ? `${k.quality.avg} / 5` : '—', label: 'deliverable quality (clients, 12 months)' },
      { iconName: 'heart', value: k.nps ? String(k.nps.nps) : '—', label: `client NPS (${k.client_responses} answers)` }, { iconName: 'users', value: k.pulse?.enps ? String(k.pulse.enps.nps) : '—', label: k.pulse ? `team eNPS — ${k.pulse.title}` : 'team eNPS' }]) : null;
    if (tab === 'pulse') {
      const qs = Object.fromEntries(v.pulse_questions.map((q) => [q.key, q.text]));
      root.replaceChildren(h('div', { class: 'toolbar' }, tabs, v.canManage ? button('Open a team pulse', { variant: 'primary', iconName: 'plus', onClick: async () => { try { await api('/api/surveys/pulse', { method: 'POST', body: {} }); toast('Pulse opened — everyone has it in their inbox'); draw(); } catch (e) { toast(e.message, 'danger'); } } }) : null), kp,
        ...(v.pulses.length ? v.pulses.map((p) => card({ title: p.title, iconName: 'messages-square',
          actions: [p.open ? badge(`Open until ${fmt(p.closes_on)}`, 'info') : badge('Closed', 'neutral'), p.answered ? badge('You answered', 'success') : null,
            p.open && !p.answered ? button('Answer — 2 minutes', { size: 'sm', variant: 'primary', onClick: () => answer(v, p) }) : null,
            v.canManage && p.open ? button('Close', { size: 'sm', variant: 'ghost', onClick: async () => { await api(`/api/surveys/${p.id}/close`, { method: 'POST' }); draw(); } }) : null],
          body: v.canManage ? h('div', { class: 'stack' }, h('p', { class: 'muted' }, `${p.responses} answer(s).`), p.hidden_reason ? h('p', { class: 'muted' }, icon('lock'), ` ${p.hidden_reason}.`) : null,
            p.results ? h('ul', { class: 'eng-list' }, Object.entries(p.results).filter(([, r]) => r).map(([key, r]) => h('li', { class: 'kpi-row' }, h('span', {}, qs[key]), h('strong', {}, r.nps != null ? `eNPS ${r.nps}` : `${r.avg} / 5`)))) : null,
            p.comments?.length ? h('div', {}, h('h3', { class: 'kv-head' }, 'Comments (anonymous)'), h('ul', { class: 'bullets' }, p.comments.map((c) => h('li', {}, c)))) : null)
            : h('p', { class: 'muted' }, p.answered ? 'Thank you for answering.' : 'Anonymous, six questions.') }))
          : [emptyState({ iconName: 'messages-square', title: 'No pulse yet', text: v.canManage ? 'Open one each quarter; everyone gets it in their inbox and by email.' : 'You will see it here when one opens.' })]));
      return;
    }
    root.replaceChildren(h('div', { class: 'toolbar' }, tabs, button('Ask a client for feedback', { variant: 'primary', iconName: 'send', onClick: newClient })), kp,
      v.clients.length ? h('ul', { class: 'eng-list' }, v.clients.map((s) => h('li', { class: 'eng-item' }, h('div', { class: 'eng-main' }, h('strong', {}, s.project || s.title),
        h('div', { class: 'eng-meta muted' }, s.contact_name ? h('span', {}, icon('user'), ` ${s.contact_name}`) : null, h('span', {}, `Sent ${fmt(s.created_at)}`), s.answered_at ? h('span', {}, `Answered ${fmt(s.answered_at)}`) : h('span', {}, `Expires ${fmt(s.closes_on)}`)),
        s.answers ? h('p', { class: 'eng-scope' }, v.client_questions.map((q) => (s.answers[q.key] != null ? `${q.key === 'nps' ? 'Recommend' : q.key[0].toUpperCase() + q.key.slice(1)}: ${s.answers[q.key]}${q.nps ? '/10' : '/5'}` : null)).filter(Boolean).join(' · ')) : null,
        s.comment ? h('p', { class: 'eng-scope' }, `“${s.comment}”`) : null),
        h('div', { class: 'eng-side' }, badge(s.answered ? 'Answered' : s.status === 'open' ? 'Waiting' : 'Closed', s.answered ? 'success' : s.status === 'open' ? 'info' : 'neutral')))))
        : emptyState({ iconName: 'building-2', title: 'No client feedback yet', text: 'Send a survey link when an engagement finishes.' }));
  }
  await draw(); root.modern = true;
  return root;
}
