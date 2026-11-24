// Library: every client GB has worked with, what we did (English / Arabic), who worked on it,
// the Drive folder, what is running or completed, proposals won and lost, and GB's strategy KPIs.
// Everyone can read; partners and People Ops edit status, links, scope and proposal outcomes.
import { h, icon, button, badge, card, emptyState, filterChips, input, select, textarea, field, openDrawer, statStrip, toast } from '/ui.js';

const T = {
  en: { clients: 'Clients', engagements: 'Engagements', proposals: 'Proposals', strategy: 'Strategy KPIs', search: 'Search client, work or person', allSectors: 'All sectors', allCountries: 'All countries',
    allLines: 'All service lines', allDomains: 'All types of work', anyone: 'Anyone', anyYear: 'Any year', client: 'Client', work: 'What we did', domain: 'Type of work', years: 'Years', status: 'Status',
    lead: 'Lead', team: 'Who worked on it', drive: 'Drive', sector: 'Sector', country: 'Country', open: 'Open folder', submitted: 'Submitted', owner: 'Owner', outcome: 'Outcome',
    running: 'Running', completed: 'Completed', on_hold: 'On hold', all: 'All', won: 'Won', lost: 'Lost', drafting: 'Drafting', submittedO: 'Awaiting decision', withdrawn: 'Withdrawn', no_go: 'No-go',
    servedT: 'clients served', engT: 'engagements', runT: 'running now', hitT: 'proposal hit rate', noArabic: '', toConfirm: 'to confirm', via: 'Delivered with', none: 'Nothing matches these filters',
    scope: 'Scope', proposalsFor: 'Proposals', engagementsFor: 'Engagements', newEng: 'New engagement', newProp: 'New proposal' },
  ar: { clients: 'العملاء', engagements: 'المشاريع', proposals: 'العروض', strategy: 'مؤشرات الاستراتيجية', search: 'ابحث عن عميل أو عمل أو شخص', allSectors: 'كل القطاعات', allCountries: 'كل الدول',
    allLines: 'كل خطوط الخدمة', allDomains: 'كل أنواع العمل', anyone: 'أي شخص', anyYear: 'أي سنة', client: 'العميل', work: 'ما أنجزناه', domain: 'نوع العمل', years: 'السنوات', status: 'الحالة',
    lead: 'المسؤول', team: 'فريق العمل', drive: 'درايف', sector: 'القطاع', country: 'البلد', open: 'فتح المجلد', submitted: 'تاريخ التقديم', owner: 'المسؤول', outcome: 'النتيجة',
    running: 'قيد التنفيذ', completed: 'منجز', on_hold: 'متوقف مؤقتاً', all: 'الكل', won: 'فزنا به', lost: 'لم نفز به', drafting: 'قيد الإعداد', submittedO: 'بانتظار القرار', withdrawn: 'مسحوب', no_go: 'لم نتقدم',
    servedT: 'عميلاً خدمناهم', engT: 'مشروعاً', runT: 'قيد التنفيذ الآن', hitT: 'نسبة الفوز بالعروض', toConfirm: 'بانتظار التأكيد', via: 'بالشراكة مع', none: 'لا توجد نتائج مطابقة',
    scope: 'نطاق العمل', proposalsFor: 'العروض', engagementsFor: 'المشاريع', newEng: 'مشروع جديد', newProp: 'عرض جديد' },
};
const LINES_AR = { 'Strategic Planning and Growth': 'التخطيط الاستراتيجي والنمو', 'Business Process Re-engineering': 'إعادة هندسة العمليات', 'HR Transformation': 'تحول الموارد البشرية',
  'Operating Model and Governance': 'النموذج التشغيلي والحوكمة', 'AI Readiness and Strategy': 'جاهزية واستراتيجية الذكاء الاصطناعي' };
const COUNTRY_AR = { Jordan: 'الأردن', 'Saudi Arabia': 'السعودية', UAE: 'الإمارات', Iraq: 'العراق', Palestine: 'فلسطين', Syria: 'سوريا', Libya: 'ليبيا', Oman: 'سلطنة عُمان', Egypt: 'مصر', Yemen: 'اليمن', Qatar: 'قطر', Regional: 'إقليمي' };
const STATUS_TONE = { running: 'info', completed: 'success', on_hold: 'warning' };
const OUT_TONE = { won: 'success', lost: 'danger', submitted: 'info', drafting: 'neutral', withdrawn: 'neutral', no_go: 'neutral' };
const years = (a, b) => (a ? (b && b !== a ? `${a}–${b}` : String(a)) : '—');
const store = { get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

export async function libraryScreen({ api, query = '' }) {
  let data = await api('/api/library');
  let strategy = null;
  const params = new URLSearchParams(query);
  let lang = store.get('gb.library.lang', 'en');
  let tab = params.get('tab') || 'engagements';
  const f = { q: '', sector: '', country: '', line: '', domain: '', person: '', year: '', status: 'all', outcome: 'all' };
  const t = (k) => T[lang][k] ?? T.en[k];
  // bilingual text: show Arabic when chosen and present, otherwise English marked as such for screen readers
  const bi = (en, ar) => (lang === 'ar' && ar ? h('span', { lang: 'ar' }, ar) : h('span', { lang: 'en' }, en || '—'));
  const cname = (c) => (c ? bi(c.name_en, c.name_ar) : '—');
  const country = (c) => (lang === 'ar' ? COUNTRY_AR[c] || c : c) || '—';
  const lineLabel = (l) => (lang === 'ar' ? LINES_AR[l] || l : l);
  const statusBadge = (s) => badge(t(s), STATUS_TONE[s] || 'neutral');
  const outcomeBadge = (o) => badge(t(o === 'submitted' ? 'submittedO' : o), OUT_TONE[o] || 'neutral');
  const driveLink = (u) => (u ? h('a', { href: u, target: '_blank', rel: 'noopener', class: 'drive-link', 'aria-label': t('open') }, icon('folder-open'), ' ', t('drive')) : h('span', { class: 'muted' }, '—'));
  const teamText = (e) => (e.team.length ? h('span', {}, e.team.map((m, i) => [i ? ', ' : '', m.confirmed ? m.name : h('span', { class: 'muted', title: t('toConfirm') }, `${m.name}*`)])) : h('span', { class: 'muted' }, '—'));
  const reload = async () => { data = await api('/api/library'); draw(); };

  const root = h('div', { class: 'stack library' });
  const body = h('div', { class: 'stack' });

  const opts = (vals, all) => [['', all], ...[...new Set(vals.filter(Boolean))].sort().map((v) => [v, v])];
  function filters() {
    const sel = (key, options, label) => { const s = select(options, { 'aria-label': label, class: 'select select-sm', onchange: (e) => { f[key] = e.target.value; draw(); } }); s.value = f[key]; return s; };
    const people = [...new Set(data.engagements.flatMap((e) => e.team.map((m) => m.name)).concat(data.engagements.map((e) => e.lead_name)))].filter(Boolean).sort();
    const yrs = [...new Set(data.engagements.flatMap((e) => (e.year_from ? Array.from({ length: (e.year_to || e.year_from) - e.year_from + 1 }, (_, i) => e.year_from + i) : [])))].sort((a, b) => b - a);
    const q = input({ type: 'search', placeholder: t('search'), 'aria-label': t('search'), value: f.q, class: 'input input-sm library-search', oninput: (e) => { f.q = e.target.value; drawList(); } });
    return h('div', { class: 'filter-row' }, q,
      sel('sector', opts(data.clients.map((c) => c.sector), t('allSectors')), t('sector')),
      sel('country', [['', t('allCountries')], ...[...new Set(data.clients.map((c) => c.country).filter(Boolean))].sort().map((c) => [c, country(c)])], t('country')),
      tab !== 'clients' ? sel('line', [['', t('allLines')], ...[...new Set(data.engagements.map((e) => e.service_line).filter(Boolean))].sort().map((l) => [l, lineLabel(l)])], t('domain')) : null,
      tab === 'engagements' ? sel('domain', opts(data.engagements.flatMap((e) => String(e.domain || '').split('; ')), t('allDomains')), t('domain')) : null,
      tab !== 'proposals' ? sel('person', opts(people, t('anyone')), t('team')) : null,
      tab !== 'proposals' ? sel('year', [['', t('anyYear')], ...yrs.map((y) => [String(y), String(y)])], t('years')) : null);
  }
  const textOf = (e) => [e.title_en, e.title_ar, e.scope_en, e.scope_ar, e.domain, e.lead_name, e.client?.name_en, e.client?.name_ar, e.client?.short, ...(e.team || []).map((m) => m.name)].join(' ').toLowerCase();
  const matchClient = (c) => (!f.sector || c?.sector === f.sector) && (!f.country || c?.country === f.country);
  const matchEng = (e) => matchClient(e.client) && (!f.line || e.service_line === f.line) && (!f.domain || String(e.domain || '').split('; ').includes(f.domain))
    && (!f.person || e.lead_name === f.person || e.team.some((m) => m.name === f.person))
    && (!f.year || (e.year_from && +f.year >= e.year_from && +f.year <= (e.year_to || e.year_from))) && (!f.q || textOf(e).includes(f.q.toLowerCase()));

  const list = h('div', { class: 'stack' });
  function drawList() {
    if (tab === 'strategy') return;
    if (tab === 'clients') {
      const eByClient = (c) => data.engagements.filter((e) => e.client_id === c.id && matchEng(e));
      const rows = data.clients.filter((c) => matchClient(c) && (eByClient(c).length || (!f.line && !f.domain && !f.person && !f.year && (!f.q || `${c.name_en} ${c.name_ar} ${c.short}`.toLowerCase().includes(f.q.toLowerCase())))));
      list.replaceChildren(rows.length ? h('div', { class: 'client-grid' }, rows.map((c) => {
        const es = eByClient(c);
        return h('button', { type: 'button', class: 'client-card', onclick: () => openClient(c) },
          h('div', { class: 'client-card-head' }, h('strong', {}, cname(c)), c.running ? badge(t('running'), 'info') : null),
          h('span', { class: 'muted' }, [c.sector, country(c.country)].filter(Boolean).join(' · ') || '—'),
          h('span', { class: 'muted' }, `${years(c.first_year, c.last_year)} · ${es.length || c.engagements} ${t('engT')}${c.proposals ? ` · ${c.proposals} ${t('proposals').toLowerCase()}` : ''}`));
      })) : emptyState({ iconName: 'search', title: t('none') }));
      return;
    }
    if (tab === 'engagements') {
      const rows = data.engagements.filter((e) => matchEng(e) && (f.status === 'all' || e.status === f.status));
      list.replaceChildren(rows.length ? h('ul', { class: 'eng-list' }, rows.map(engRow)) : emptyState({ iconName: 'search', title: t('none') }));
      return;
    }
    const rows = data.proposals.filter((p) => matchClient(p.client) && (f.outcome === 'all' || p.outcome === f.outcome || (f.outcome === 'open' && ['drafting', 'submitted'].includes(p.outcome)))
      && (!f.line || LINE_OF(p.domain) === f.line) && (!f.q || [p.title_en, p.title_ar, p.owner_name, p.client?.name_en, p.client?.name_ar, p.client?.short].join(' ').toLowerCase().includes(f.q.toLowerCase())));
    list.replaceChildren(rows.length ? h('ul', { class: 'eng-list' }, rows.map(propRow)) : emptyState({ iconName: 'search', title: t('none') }));
  }
  const LINE_OF = (domain) => data.engagements.find((e) => e.domain && String(e.domain).split('; ')[0] === domain)?.service_line || null;

  function engRow(e) {
    return h('li', { class: 'eng-item' },
      h('div', { class: 'eng-main' },
        h('div', { class: 'eng-title' }, h('button', { type: 'button', class: 'link-btn', onclick: () => openEngagement(e) }, h('strong', {}, cname(e.client))), h('span', { class: 'muted' }, ' — '), bi(e.title_en, e.title_ar)),
        h('p', { class: 'eng-scope' }, bi(e.scope_en, e.scope_ar)),
        h('div', { class: 'eng-meta muted' }, h('span', {}, icon('calendar-days'), ' ', years(e.year_from, e.year_to)), e.client?.country ? h('span', {}, icon('map-pin'), ' ', country(e.client.country)) : null,
          e.lead_name ? h('span', {}, icon('user'), ' ', e.lead_name) : null, e.team.length ? h('span', {}, icon('users'), ' ', teamText(e)) : null,
          e.subcontractor ? h('span', {}, `${t('via')} ${e.subcontractor}`) : null)),
      h('div', { class: 'eng-side' }, statusBadge(e.status), e.service_line ? badge(lineLabel(e.service_line), 'neutral') : null, driveLink(e.drive_url)));
  }
  function propRow(p) {
    const ctl = data.canEdit ? select(data.outcomes.map((o) => [o, t(o === 'submitted' ? 'submittedO' : o)]), { class: 'select select-sm', 'aria-label': `${t('outcome')}: ${p.title_en}`,
      onchange: async (ev) => { try { await api(`/api/library/proposals/${p.id}`, { method: 'PATCH', body: { outcome: ev.target.value } }); toast('Outcome saved'); await reload(); } catch (err) { toast(err.message, 'danger'); } } }) : null;
    if (ctl) ctl.value = p.outcome;
    return h('li', { class: 'eng-item' },
      h('div', { class: 'eng-main' },
        h('div', { class: 'eng-title' }, h('strong', {}, cname(p.client)), h('span', { class: 'muted' }, ' — '), bi(p.title_en, p.title_ar)),
        p.outcome_note ? h('p', { class: 'eng-scope muted' }, p.outcome_note) : null,
        h('div', { class: 'eng-meta muted' }, p.submitted_on ? h('span', {}, icon('send'), ' ', new Date(`${p.submitted_on}T00:00:00`).toLocaleDateString(lang === 'ar' ? 'ar-JO' : 'en-GB', { month: 'short', year: 'numeric' })) : null,
          p.owner_name ? h('span', {}, icon('user'), ' ', p.owner_name) : null, p.domain ? h('span', {}, p.domain) : null)),
      h('div', { class: 'eng-side' }, ctl || outcomeBadge(p.outcome), driveLink(p.drive_url)));
  }

  function openClient(c) {
    const es = data.engagements.filter((e) => e.client_id === c.id); const ps = data.proposals.filter((p) => p.client_id === c.id);
    openDrawer({ title: lang === 'ar' && c.name_ar ? c.name_ar : c.name_en, iconName: 'building-2', body: h('div', { class: 'stack', dir: lang === 'ar' ? 'rtl' : 'ltr' },
      h('dl', { class: 'kv' }, h('dt', {}, t('sector')), h('dd', {}, c.sector || '—'), h('dt', {}, t('country')), h('dd', {}, country(c.country)), h('dt', {}, t('years')), h('dd', {}, years(c.first_year, c.last_year)),
        h('dt', {}, t('team')), h('dd', {}, c.people.join(', ') || '—'), h('dt', {}, t('drive')), h('dd', {}, driveLink(c.drive_url))),
      es.length ? h('div', {}, h('h3', { class: 'kv-head' }, t('engagementsFor')), h('ul', { class: 'eng-list' }, es.map(engRow))) : null,
      ps.length ? h('div', {}, h('h3', { class: 'kv-head' }, t('proposalsFor')), h('ul', { class: 'eng-list' }, ps.map(propRow))) : null) });
  }

  function openEngagement(e) {
    const edit = data.canEdit;
    const st = select(data.statuses.map((s) => [s, t(s)]), { id: 'e-status' }); st.value = e.status;
    const dr = input({ id: 'e-drive', type: 'url', value: e.drive_url || '', placeholder: 'https://drive.google.com/…' });
    const sen = textarea({ id: 'e-scope-en', rows: 4 }, e.scope_en || ''); const sar = textarea({ id: 'e-scope-ar', rows: 4, dir: 'rtl', lang: 'ar' }, e.scope_ar || '');
    const tar = input({ id: 'e-title-ar', value: e.title_ar || '', dir: 'rtl', lang: 'ar' });
    const team = input({ id: 'e-team', value: e.team_names || '', placeholder: 'Names, separated by ;' });
    const yf = input({ id: 'e-yf', type: 'number', value: e.year_from || '', min: 2000, max: 2100 }); const yt = input({ id: 'e-yt', type: 'number', value: e.year_to || '', min: 2000, max: 2100 });
    openDrawer({ title: `${e.client?.short || e.client?.name_en} — ${e.title_en}`, iconName: 'briefcase', body: h('div', { class: 'stack' },
      h('dl', { class: 'kv' }, h('dt', {}, t('client')), h('dd', {}, cname(e.client)), h('dt', {}, t('domain')), h('dd', {}, e.domain || '—'), h('dt', {}, t('years')), h('dd', {}, years(e.year_from, e.year_to)),
        h('dt', {}, t('status')), h('dd', {}, statusBadge(e.status)), h('dt', {}, t('lead')), h('dd', {}, e.lead_name || '—'), h('dt', {}, t('team')), h('dd', {}, teamText(e)),
        e.project_name ? [h('dt', {}, 'Register'), h('dd', {}, h('a', { href: `#/projects?p=${e.project_id}` }, e.project_name))] : null, h('dt', {}, t('drive')), h('dd', {}, driveLink(e.drive_url))),
      h('div', { class: 'stack' }, h('h3', { class: 'kv-head' }, 'English'), h('p', {}, e.scope_en || '—')),
      h('div', { class: 'stack', dir: 'rtl', lang: 'ar' }, h('h3', { class: 'kv-head' }, 'العربية'), h('p', {}, e.scope_ar || h('span', { class: 'muted' }, 'لم تُضف ترجمة عربية بعد'))),
      e.team.some((m) => !m.confirmed) ? h('p', { class: 'muted' }, `* ${'Named in the project register; the project lead still has to confirm.'}`) : null,
      edit ? h('form', { class: 'stack', onsubmit: (ev) => ev.preventDefault() }, h('h3', { class: 'kv-head' }, 'Edit'),
        field({ label: t('status'), id: 'e-status', control: st }), field({ label: 'Drive folder link', id: 'e-drive', control: dr }),
        h('div', { class: 'row' }, field({ label: 'From year', id: 'e-yf', control: yf }), field({ label: 'To year', id: 'e-yt', control: yt })),
        field({ label: 'Team (names from before the portal)', id: 'e-team', control: team, help: 'People confirmed in the projects register are added automatically.' }),
        field({ label: 'Scope (English)', id: 'e-scope-en', control: sen }), field({ label: 'العنوان (عربي)', id: 'e-title-ar', control: tar }), field({ label: 'نطاق العمل (عربي)', id: 'e-scope-ar', control: sar })) : null),
    footer: edit ? (close) => button('Save', { variant: 'primary', iconName: 'check', onClick: async () => {
      try { await api(`/api/library/engagements/${e.id}`, { method: 'PATCH', body: { status: st.value, drive_url: dr.value, scope_en: sen.value, scope_ar: sar.value, title_ar: tar.value, team_names: team.value, year_from: yf.value, year_to: yt.value } }); toast('Saved'); close(); await reload(); } catch (err) { toast(err.message, 'danger'); }
    } }) : null });
  }

  function addForm(kind) {
    const clientSel = select([['', 'Choose a client…'], ...data.clients.map((c) => [c.id, c.name_en]), ['__new', 'New client…']], { id: 'n-client' });
    const newName = input({ id: 'n-new', placeholder: 'Client name (English)' }); const newAr = input({ id: 'n-new-ar', dir: 'rtl', lang: 'ar', placeholder: 'اسم العميل' });
    const sector = input({ id: 'n-sector', placeholder: 'e.g. Financial Services' }); const ctry = input({ id: 'n-country', placeholder: 'e.g. Jordan' });
    const newWrap = h('div', { class: 'stack', hidden: true }, field({ label: 'New client', id: 'n-new', control: newName }), field({ label: 'اسم العميل (عربي)', id: 'n-new-ar', control: newAr }),
      h('div', { class: 'row' }, field({ label: 'Sector', id: 'n-sector', control: sector }), field({ label: 'Country', id: 'n-country', control: ctry })));
    clientSel.onchange = () => { newWrap.hidden = clientSel.value !== '__new'; };
    const title = input({ id: 'n-title', placeholder: kind === 'proposal' ? 'e.g. Five-year strategic plan' : 'e.g. Policies and procedures – phase 2' });
    const drive = input({ id: 'n-drive', type: 'url', placeholder: 'https://drive.google.com/…' });
    const date = input({ id: 'n-date', type: 'date' }); const owner = input({ id: 'n-owner' });
    const scope = textarea({ id: 'n-scope', rows: 3 });
    openDrawer({ title: kind === 'proposal' ? 'New proposal' : 'New engagement', iconName: kind === 'proposal' ? 'file-text' : 'briefcase', body: h('form', { class: 'stack', onsubmit: (e) => e.preventDefault() },
      field({ label: t('client'), id: 'n-client', control: clientSel, required: true }), newWrap, field({ label: 'Title', id: 'n-title', control: title, required: true }),
      kind === 'proposal' ? [field({ label: 'Submitted on', id: 'n-date', control: date }), field({ label: 'Owner', id: 'n-owner', control: owner })] : field({ label: 'Scope (English)', id: 'n-scope', control: scope }),
      field({ label: 'Drive folder link', id: 'n-drive', control: drive })),
    footer: (close) => button('Add', { variant: 'primary', iconName: 'plus', onClick: async () => {
      const who = clientSel.value === '__new' ? { clientName: newName.value, clientNameAr: newAr.value, sector: sector.value, country: ctry.value } : { clientId: clientSel.value };
      try {
        if (kind === 'proposal') await api('/api/library/proposals', { method: 'POST', body: { ...who, title_en: title.value, submitted_on: date.value || null, owner_name: owner.value, drive_url: drive.value, outcome: date.value ? 'submitted' : 'drafting' } });
        else await api('/api/library/engagements', { method: 'POST', body: { ...who, title_en: title.value, scope_en: scope.value, drive_url: drive.value, status: 'running', year_from: new Date().getFullYear() } });
        toast('Added'); close(); await reload();
      } catch (err) { toast(err.message, 'danger'); }
    } }) });
  }

  async function drawStrategy() {
    strategy ||= await api('/api/strategy');
    const byObj = (code) => strategy.kpis.filter((k) => k.objectives.includes(code));
    const themes = [...new Set(strategy.objectives.map((o) => o.theme))];
    const kpiRow = (k) => h('li', { class: 'kpi-row' },
      h('div', {}, h('strong', {}, `${k.code} · `, bi(k.name_en, k.name_ar)), k.live ? h('div', { class: 'muted' }, icon('gauge'), ` ${k.live.value} — ${k.live.note}`) : null),
      h('div', { class: 'eng-side' }, badge(`${k.linked_people} ${lang === 'ar' ? 'موظف' : k.linked_people === 1 ? 'person' : 'people'}`, k.linked_people ? 'success' : 'warning'),
        strategy.canSeeNames && k.links?.length ? button(lang === 'ar' ? 'من؟' : 'Who', { size: 'sm', variant: 'ghost', onClick: () => openDrawer({ title: k.name_en, iconName: 'target', body: h('ul', { class: 'bullets' }, k.links.map((l) => h('li', {}, h('strong', {}, l.name), ` — ${l.title}`))) }) }) : null));
    const uncovered = strategy.kpis.filter((k) => !k.linked_people).length;
    list.replaceChildren(
      h('p', { class: 'muted' }, lang === 'ar' ? `استراتيجية جي بي 2026–2028. اربط أهدافك في المراجعة السنوية ${strategy.cycle_year || ''} بمؤشر أو أكثر.` : `GB Advisory Strategy 2026–2028. Link the objectives in your ${strategy.cycle_year || ''} review to the KPI(s) they move — from your review page.`,
        uncovered ? h('strong', {}, lang === 'ar' ? ` ${uncovered} مؤشراً بلا أهداف مرتبطة بعد.` : ` ${uncovered} KPI${uncovered === 1 ? '' : 's'} have no one’s objectives linked yet.`) : null),
      ...themes.map((th) => card({ title: th, iconName: 'goal', body: h('div', { class: 'stack' }, strategy.objectives.filter((o) => o.theme === th).map((o) => h('div', { class: 'objective' },
        h('h3', { class: 'kv-head' }, `${o.code} `, bi(o.title_en, o.title_ar)),
        byObj(o.code).length ? h('ul', { class: 'kpi-list' }, byObj(o.code).map(kpiRow)) : h('p', { class: 'muted' }, lang === 'ar' ? 'لا يوجد مؤشر مخصص' : 'No KPI assigned in the strategy deck'))))
      })));
  }

  function draw() {
    root.dir = lang === 'ar' ? 'rtl' : 'ltr'; root.lang = lang;
    const s = data.stats;
    const tabs = filterChips([{ value: 'clients', label: t('clients'), count: data.clients.length, iconName: 'building-2' }, { value: 'engagements', label: t('engagements'), count: data.engagements.length, iconName: 'briefcase' },
      { value: 'proposals', label: t('proposals'), count: data.proposals.length, iconName: 'file-text' }, { value: 'strategy', label: t('strategy'), iconName: 'target' }], tab, (v) => { tab = v; draw(); });
    tabs.setAttribute('aria-label', 'Library sections');
    const langs = filterChips([{ value: 'en', label: 'English' }, { value: 'ar', label: 'العربية' }], lang, (v) => { lang = v; store.set('gb.library.lang', v); draw(); });
    langs.setAttribute('aria-label', 'Language');
    const sub = tab === 'engagements' ? filterChips(['all', 'running', 'completed', 'on_hold'].map((v) => ({ value: v, label: t(v), count: v === 'all' ? data.engagements.length : data.engagements.filter((e) => e.status === v).length })), f.status, (v) => { f.status = v; drawList(); })
      : tab === 'proposals' ? filterChips([['all', t('all')], ['won', t('won')], ['lost', t('lost')], ['open', t('submittedO')]].map(([v, l]) => ({ value: v, label: l, count: v === 'all' ? data.proposals.length : v === 'open' ? s.open : data.proposals.filter((p) => p.outcome === v).length })), f.outcome, (v) => { f.outcome = v; drawList(); }) : null;
    const add = data.canEdit && (tab === 'engagements' || tab === 'proposals') ? button(t(tab === 'proposals' ? 'newProp' : 'newEng'), { iconName: 'plus', onClick: () => addForm(tab === 'proposals' ? 'proposal' : 'engagement') }) : null;
    body.replaceChildren(...[
      h('div', { class: 'toolbar' }, tabs, langs),
      statStrip([{ iconName: 'building-2', value: String(s.clients_served), label: t('servedT') }, { iconName: 'briefcase', value: String(s.engagements), label: t('engT') },
        { iconName: 'refresh-cw', value: String(s.running), label: t('runT') }, { iconName: 'trophy', value: s.hit_rate == null ? '—' : `${s.hit_rate}%`, label: `${t('hitT')} (${s.won}/${s.won + s.lost})` }]),
      tab === 'strategy' ? null : h('div', { class: 'toolbar' }, filters(), h('div', { class: 'row' }, sub, add)),
      list].filter(Boolean));
    if (tab === 'strategy') drawStrategy().catch((e) => list.replaceChildren(emptyState({ iconName: 'circle-alert', title: e.message }))); else drawList();
  }
  draw();
  root.append(body);
  root.modern = true;
  return root;
}
