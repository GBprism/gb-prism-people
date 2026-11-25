import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN } from './helpers.js';
import { applyLibrary, libraryView, saveEngagement, saveProposal, strategyView, linkPlanItem } from '../src/domain/library.js';
import { planView } from '../src/domain/performance.js';

const FILE = {
  source: 'test',
  clients: [{ key: 'acme', name_en: 'Acme Bank', name_ar: 'بنك أكمي', short: 'ACME', sector: 'Financial Services', country: 'Jordan', drive_url: 'https://drive.google.com/drive/folders/x' },
    { key: 'beta', name_en: 'Beta Authority', sector: 'Public Sector', country: 'Saudi Arabia' }],
  engagements: [
    { key: 'acme-2019', client: 'acme', title_en: 'Strategy', title_ar: 'الاستراتيجية', domain: 'Strategic Planning and Roadmap', service_line: 'Strategic Planning and Growth', scope_en: 'Bank strategy', scope_ar: 'استراتيجية البنك', year_from: 2019, year_to: 2021, status: 'completed', lead: 'Old Lead', team: ['Tariq', 'Amira'] },
    { key: 'beta-2026', client: 'beta', title_en: 'Processes', domain: 'Policies and Procedures', year_from: 2026, status: 'running', project: 'Project Alpha — strategy' },
  ],
  proposals: [
    { key: 'p1', client: 'acme', title_en: 'Strategy refresh', submitted_on: '2026-02-01', outcome: 'won', engagement: 'acme-2019' },
    { key: 'p2', client: 'beta', title_en: 'Org design', submitted_on: '2026-03-01', outcome: 'lost' },
    { key: 'p3', client: 'beta', title_en: 'Training', submitted_on: '2026-04-01', outcome: 'submitted' },
  ],
  strategy: { objectives: [{ code: '1.1', theme: '1. Prepare', title_en: 'Rectify quality' }, { code: '1.4', theme: '1. Prepare', title_en: 'Grow markets' }],
    kpis: [{ code: 'K01', name_en: 'Quality index on projects delivered', objectives: ['1.1'] }, { code: 'K16', name_en: 'Proposal hit rate', objectives: ['1.4'] },
      { code: 'K02', name_en: 'Employee experience index', objectives: ['1.1'] }, { code: 'K03', name_en: 'Systems', objectives: ['1.1'] }] },
};

test('library: loads idempotently, everyone reads it, team merges history with the register', () => {
  const { db, as } = fresh();
  const r = applyLibrary(db, as(SYN.ops), FILE);
  assert.deepEqual([r.clients, r.engagements, r.proposals, r.kpis, r.problems.length], [2, 2, 3, 4, 0]);
  applyLibrary(db, as(SYN.ops), FILE);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM engagements').get().n, 2);
  // any colleague can read, including someone with no reviews or projects
  const v = libraryView(db, as(SYN.unrelated));
  assert.equal(v.canEdit, false);
  assert.equal(v.stats.running, 1);
  assert.equal(v.stats.hit_rate, 50);
  const acme = v.engagements.find((e) => e.key === 'acme-2019');
  assert.deepEqual(acme.team.map((t) => t.name), ['Tariq', 'Amira']);
  assert.equal(acme.client.name_ar, 'بنك أكمي');
  const beta = v.engagements.find((e) => e.key === 'beta-2026');
  assert.ok(beta.project_id, 'linked to the register project');
  assert.ok(beta.team.length >= 1, 'team comes from the register assignments');
  // another tenant sees nothing
  assert.equal(libraryView(db, as(SYN.otherUser)).engagements.length, 0);
});

test('library: only partners / People Ops edit; edits survive a re-import; Drive links validated', () => {
  const { db, as } = fresh();
  applyLibrary(db, as(SYN.ops), FILE);
  const e = db.prepare("SELECT id FROM engagements WHERE key = 'beta-2026'").get();
  assert.throws(() => saveEngagement(db, as(SYN.emp), e.id, { status: 'completed' }), /Not permitted/);
  assert.throws(() => saveEngagement(db, as(SYN.partner), e.id, { status: 'done' }), /running, completed or on hold/);
  assert.throws(() => saveEngagement(db, as(SYN.partner), e.id, { drive_url: 'https://evil.example/x' }), /drive\.google\.com/);
  saveEngagement(db, as(SYN.partner), e.id, { status: 'completed', drive_url: 'https://drive.google.com/drive/folders/abc', scope_ar: 'نطاق' });
  const r = applyLibrary(db, as(SYN.ops), FILE);
  assert.equal(r.kept, 1);
  assert.equal(db.prepare('SELECT status FROM engagements WHERE id = ?').get(e.id).status, 'completed');
  // new engagement with a new client
  const { id } = saveEngagement(db, as(SYN.ops), null, { clientName: 'Gamma Co', title_en: 'Feasibility', status: 'running' });
  assert.equal(db.prepare('SELECT c.name_en FROM engagements e JOIN clients c ON c.id = e.client_id WHERE e.id = ?').get(id).name_en, 'Gamma Co');
  // proposals: outcome change dates the decision and is audited
  const p3 = db.prepare("SELECT id FROM proposals WHERE key = 'p3'").get().id;
  assert.throws(() => saveProposal(db, as(SYN.manager), p3, { outcome: 'won' }), /Not permitted/);
  saveProposal(db, as(SYN.partner), p3, { outcome: 'won' });
  assert.ok(db.prepare('SELECT decided_on FROM proposals WHERE id = ?').get(p3).decided_on);
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action = 'library.proposal.update'").get());
  assert.equal(libraryView(db, as(SYN.emp)).stats.hit_rate, 67);
});

test('strategy: people link their objectives to GB KPIs; colleagues see counts, partners see names', () => {
  const { db, as } = fresh();
  applyLibrary(db, as(SYN.ops), FILE);
  const plan = db.prepare("SELECT p.id FROM plans p JOIN cycles c ON c.id = p.cycle_id WHERE p.user_id = ? AND c.status != 'historical' ORDER BY c.year LIMIT 1").get(SYN.emp);
  const item = db.prepare("SELECT id, title FROM plan_items WHERE plan_id = ? AND category = 'objective' LIMIT 1").get(plan.id);
  const k = Object.fromEntries(db.prepare('SELECT code, id FROM strategy_kpis').all().map((r) => [r.code, r.id]));
  // a peer or an unrelated person cannot link someone else's objective
  for (const who of [SYN.peer, SYN.unrelated, SYN.otherUser]) assert.throws(() => linkPlanItem(db, as(who), item.id, [k.K01]), /Not permitted|not found/i);
  assert.throws(() => linkPlanItem(db, as(SYN.emp), item.id, [k.K01, k.K02, k.K03, k.K16]), /at most three/);
  linkPlanItem(db, as(SYN.emp), item.id, [k.K01, k.K16]);
  const v = planView(db, as(SYN.emp), plan.id);
  assert.deepEqual(v.items.find((i) => i.id === item.id).strategy.map((s) => s.code), ['K01', 'K16']);
  assert.equal(v.can_link_strategy, true);
  // the reviewer can change it
  linkPlanItem(db, as(SYN.manager), item.id, [k.K01]);
  const forPeer = strategyView(db, as(SYN.peer));
  const k01 = forPeer.kpis.find((x) => x.code === 'K01');
  assert.equal(k01.linked_people, 1);
  assert.equal(k01.links, undefined, 'colleagues see counts only');
  assert.equal(strategyView(db, as(SYN.partner)).kpis.find((x) => x.code === 'K01').links[0].title, item.title);
  // proposal hit rate is measured live from the library
  assert.match(forPeer.kpis.find((x) => x.code === 'K16').live.value, /^50%$/);
});
