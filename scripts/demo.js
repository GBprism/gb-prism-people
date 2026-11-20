// Synthetic end-to-end demo (no real records). Run: npm run demo
import { openDb } from '../src/db.js';
import { seedSynthetic, seedPlans, SYN } from '../src/seed.js';
import { loadActor } from '../src/domain/authz.js';
import * as perf from '../src/domain/performance.js';
import * as leave from '../src/domain/leave.js';
import * as proj from '../src/domain/projects.js';
import { fmtX100 } from '../src/domain/decimal.js';

const db = openDb(':memory:'); seedSynthetic(db); seedPlans(db);
const as = (id) => loadActor(db, id);
const say = (...a) => console.log(...a);
const PLAN = `plan_${SYN.emp}_2026`;

say('\n== 2026 review: self → manager → calibration → release → acknowledge → close');
let v = perf.planView(db, as(SYN.emp), PLAN);
perf.saveSelf(db, as(SYN.emp), PLAN, { items: v.items.map((i) => ({ id: i.id, actual: 'Delivered', self_rating: 4, self_rationale: 'See evidence', self_evidence: [{ url: 'https://drive.example/doc' }] })) });
perf.submitSelf(db, as(SYN.emp), PLAN);
v = perf.planView(db, as(SYN.manager), PLAN);
perf.saveManager(db, as(SYN.manager), PLAN, { items: v.items.map((i, k) => ({ id: i.id, manager_rating: k === 0 ? 5 : 3, manager_rationale: 'Checked with project lead' })) });
perf.submitManager(db, as(SYN.manager), PLAN);
perf.calibrateItem(db, as(SYN.partner), PLAN, v.items[0].id, { calibrated_rating: 4, reason: 'Consistency with peers in role' });
perf.release(db, as(SYN.partner), PLAN);
v = perf.planView(db, as(SYN.emp), PLAN);
say(v.outcome.math.join('\n'));
perf.acknowledge(db, as(SYN.emp), PLAN, { comment: 'Received' });
perf.addDevelopmentAction(db, as(SYN.manager), PLAN, { kind: 'improvement', title: 'Lead a client workshop', dueDate: '2027-04-30', ownerId: SYN.emp });
perf.closePlan(db, as(SYN.manager), PLAN);
say('state:', perf.getPlan(db, PLAN).state);
const keep = v.items.find((i) => i.title === 'Data traceability');
const p27 = perf.createPlan(db, as(SYN.emp), { cycleId: 'cyc_2027', userId: SYN.emp, reviewerId: SYN.manager, partnerId: SYN.partner, templateId: 'tpl_consultant', carryItemIds: [keep.id] });
say('2027 draft created with carried item (fresh target/weight required):', perf.planView(db, as(SYN.emp), p27.id).items.filter((i) => i.carried_from_item_id).map((i) => `${i.title} weight=${i.weight} target=${i.target}`));

say('\n== Time off: holiday + weekend + cross-year, approval, cancellation');
db.prepare("INSERT INTO holidays (id, tenant_id, calendar, date, name) VALUES ('h1','gb','JO','2026-12-31','Demo holiday')").run();
leave.adjustBalance(db, as(SYN.ops), { userId: SYN.emp, typeCode: 'AV', year: 2027, amountX100: 1400, note: 'Demo 2027 entitlement' });
const r = leave.submitRequest(db, as(SYN.emp), { typeCode: 'AV', start: '2026-12-30', end: '2027-01-04', coverUserId: SYN.senior });
say('chargeable:', fmtX100(r.chargeable_x100), JSON.parse(r.breakdown_json).days.map((d) => `${d.date} ${d.note}`).join(' | '));
leave.decideRequest(db, as(SYN.manager), r.id, { decision: 'approve' });
say('AV 2026 posted:', fmtX100(leave.balance(db, 'gb', SYN.emp, 'lt_AV', 2026).posted_x100), '· 2027:', fmtX100(leave.balance(db, 'gb', SYN.emp, 'lt_AV', 2027).posted_x100));
leave.cancelRequest(db, as(SYN.emp), r.id, {});
say('after cancellation:', fmtX100(leave.balance(db, 'gb', SYN.emp, 'lt_AV', 2026).posted_x100), '/', fmtX100(leave.balance(db, 'gb', SYN.emp, 'lt_AV', 2027).posted_x100));
try { leave.submitRequest(db, as(SYN.emp), { typeCode: 'WFH', start: '2026-12-06', end: '2026-12-10' }); } catch (e) { say('off-site quota:', e.details.join('; ')); }

say('\n== Shared deliverable, two contributions, lead validation');
const c1 = proj.claimContribution(db, as(SYN.emp), { deliverableId: 'dlv_alpha_report', responsibility: 'analyst', description: 'Model' });
const c2 = proj.claimContribution(db, as(SYN.senior), { deliverableId: 'dlv_alpha_report', responsibility: 'author', description: 'Chapters' });
proj.reviewContribution(db, as(SYN.lead), c1, { decision: 'confirm' });
proj.reviewContribution(db, as(SYN.lead), c2, { decision: 'correct', responsibility: 'reviewer', note: 'Reviewed rather than authored' });
say(proj.registerView(db, as(SYN.lead))[0].deliverables[0].contributions.map((c) => `${c.name}: ${c.responsibility} (${c.status})`));

say('\n== Permission boundaries');
for (const who of [SYN.peer, SYN.unrelated, SYN.ops, SYN.otherUser]) {
  try { perf.planView(db, as(who), PLAN); say(who, 'CAN SEE — unexpected'); } catch { say(`${as(who).name}: no access to Eli's review ✓`); }
}
