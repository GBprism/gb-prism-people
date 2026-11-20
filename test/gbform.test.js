import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN, xlsx } from './helpers.js';
import { previewGbForms, applyGbForms } from '../src/imports/gbform.js';
import * as perf from '../src/domain/performance.js';

const PH = 'Insert Rating here';
const timeAs = (frac) => new Date(Date.UTC(1899, 11, 30) + frac * 86400000);

/** Synthetic workbook laid out like GB's "2026 Employee Eval. Form" (same row/column positions). */
async function form({ name, position = 'Senior Consultant', weights = [0.2, 0.2, 0.2, 0.2, 0.2], compD61 = '=O55', initiatives = [] }) {
  const R = Array.from({ length: 75 }, () => []);
  const set = (addr, v) => { const m = /^([A-Z])(\d+)$/.exec(addr); R[Number(m[2]) - 1][m[1].charCodeAt(0) - 65] = v; };
  set('A2', 'Employee Evaluation Form');
  set('A7', 'Name '); set('B7', name); set('D7', 'Age'); set('E7', 30); set('G7', 'Hobby'); set('H7', 'Chess');
  set('A8', 'Position'); set('B8', position); set('D8', 'Years of Experience'); set('E8', 3);
  set('A9', 'Date of Joining'); set('D9', 'Current Salary'); set('E9', 999);
  set('A31', 'OBJECTIVES: Weight 0f 50%'); set('A33', '#');
  weights.forEach((w, i) => {
    const r = 34 + i;
    set(`A${r}`, i + 1); set(`B${r}`, `${i + 1}. Objective ${i + 1}`); set(`D${r}`, `KPI ${i + 1}`); set(`E${r}`, w); set(`F${r}`, `Target ${i + 1}`);
    set(`H${r}`, 'Insert Approval here'); set(`J${r}`, 'Insert Achievement here'); set(`K${r}`, PH);
    if (i === 0) { set(`L${r}`, 'Failed in delivery of project'); set(`M${r}`, 3); set(`N${r}`, 'Target not achieved fully but within range'); }
  });
  set('N39', 'Average Rating'); set('O39', { formula: '(O34*E34)+(O35*E35)+(O36*E36)+(O37*E37)+(O38*E38)', result: 0 });
  set('A41', 'COMPETENCIES: Weight 0f 30%'); set('A43', '#');
  [0.15, 0.15, 0.15, 0.2, 0.2, 0.15].forEach((w, i) => { const r = 44 + i; set(`A${r}`, i + 1); set(`B${r}`, `${i + 1}. Competency ${i + 1}`); set(`E${r}`, w); set(`H${r}`, 'Intermediate'); });
  set('N50', 'Average Rating'); set('O50', { formula: '(O44*E44)+(O45*E45)+(O46*E46)+(O47*E47)+(O48*E48)+(O49*E49)', result: 0 });
  set('A51', 'Internal Initiatives: Weight of 20%'); set('A52', '#');
  [0.1, 0.1].forEach((w, i) => { const r = 53 + i; set(`A${r}`, i + 1); set(`E${r}`, w); if (initiatives[i]) set(`B${r}`, initiatives[i]); });
  set('N55', 'Average Rating'); set('O55', { formula: 'AVERAGE(O53:O54)', result: { error: '#DIV/0!' } });
  set('A58', 'Total Annual Performance Rating');
  set('A60', '1. Objectives'); set('C60', 0.5); set('D60', { formula: 'O39', result: 0 });
  set('A61', '2. Competencies'); set('C61', 0.3); set('D61', { formula: compD61.slice(1), result: 0 });
  set('A62', '3. Internal Initiatives'); set('C62', 0.2); set('D62', { formula: 'O55', result: 0 });
  return xlsx({ '2026 Employee Eval. Form': R });
}

test('GB evaluation form: allowlisted fields, template sample ignored, formula bugs reported, plan imported as unverified draft', async () => {
  const { db, as } = fresh({ plans: false }); const ops = as(SYN.ops);
  db.prepare("INSERT INTO identity_aliases (id, tenant_id, user_id, source, alias, verified) VALUES ('f1','gb',?,'pms_form','Sara Senior',1), ('f2','gb',?,'pms_form','Eli',1)").run(SYN.senior, SYN.emp);
  const files = [
    { filename: 'Sara-2026_GB Advisory_PMS_Senior Consultant_form.xlsx', buffer: await form({ name: 'Sara Senior', weights: [0.2, 0.2, 0.2, timeAs(0.2), timeAs(0.2)] }) },
    { filename: 'Eli-2026_GB Advisory_PMS_Senior Consultant_form.xlsx', buffer: await form({ name: null, compD61: '=O50', initiatives: ['Template library', 'Training session'] }) },
  ];
  const b = await previewGbForms(db, ops, { files, cycleId: 'cyc_2026' });
  const all = JSON.stringify(b);
  assert.equal(all.includes('999'), false, 'salary never read');
  assert.equal(all.includes('Chess'), false, 'hobby never read');
  const sara = b.summary.plans.find((p) => p.person === 'Sara Senior');
  assert.ok(sara.formula_issues.some((x) => /Competencies rating \(D61\) = O55/.test(x)));
  assert.ok(sara.formula_issues.some((x) => /unweighted AVERAGE/.test(x)));
  assert.ok(sara.issues.some((x) => /No initiative items defined/.test(x)));
  assert.ok(sara.issues.some((x) => /no recorded supervisor approval/.test(x)));
  const saraRow = b.rows.find((r) => r.raw.plan.person === 'Sara Senior');
  assert.ok(saraRow.issues.some((x) => /template example text/.test(x)));
  assert.ok(saraRow.issues.some((x) => /formatted as a time; read as 20%/.test(x)));
  assert.ok(saraRow.raw.items.every((i) => i.supervisor_rating === null), 'sample rating 3 not imported');
  const eli = b.summary.plans.find((p) => p.person === 'Eli');
  assert.ok(!eli.formula_issues.some((x) => /D61/.test(x)));
  assert.ok(b.rows.find((r) => r.raw.plan.person === 'Eli').issues.some((x) => /Name cell is blank/.test(x)));
  const res = applyGbForms(db, ops, b.id);
  assert.equal(res.plans_created, 2);
  const plan = db.prepare('SELECT * FROM plans WHERE user_id = ?').get(SYN.senior);
  assert.equal(plan.state, 'draft_plan');
  assert.equal(plan.basis_status, 'unverified');
  assert.deepEqual(JSON.parse(plan.category_weights_json), { objective: 50, competency: 30, initiative: 20 });
  // Sara's plan cannot be approved until initiatives are defined (or an N/A decision is recorded)
  assert.throws(() => perf.approvePlan(db, as(SYN.manager), plan.id), (e) => e.details.some((d) => /no items/.test(d.message)));
  // Eli's (with initiatives at 10% + 10% in the source) needs the item weights fixing
  const eliPlan = db.prepare('SELECT * FROM plans WHERE user_id = ?').get(SYN.emp);
  assert.throws(() => perf.approvePlan(db, as(SYN.manager), eliPlan.id), (e) => e.details.some((d) => /Internal initiatives item weights total 20%/.test(d.message)));
  const items = db.prepare("SELECT id FROM plan_items WHERE plan_id = ? AND category = 'initiative'").all(eliPlan.id);
  perf.editDraft(db, as(SYN.manager), eliPlan.id, { upsertItems: items.map((i) => ({ id: i.id, weight: 50 })) });
  perf.approvePlan(db, as(SYN.manager), eliPlan.id, { note: 'Targets agreed in 1:1' });
  assert.equal(perf.getPlan(db, eliPlan.id).basis_status, 'verified');
  // re-uploading the same set is a no-op
  assert.equal((await previewGbForms(db, ops, { files, cycleId: 'cyc_2026' })).duplicateOf, b.id);
});

test('GB decision "no initiatives in 2026": approved N/A item, plan approvable, 20% redistributed pro rata in the math', async () => {
  const { db, as } = fresh({ plans: false }); const ops = as(SYN.ops);
  db.prepare("INSERT INTO identity_aliases (id, tenant_id, user_id, source, alias, verified) VALUES ('f1','gb',?,'pms_form','Sara Senior',1)").run(SYN.senior);
  db.prepare("INSERT INTO settings (tenant_id, key, value_json) VALUES ('gb', 'decision_initiatives_2026', ?)").run(JSON.stringify({ rule: 'redistribute', note: 'GB decision: no internal initiatives in 2026' }));
  const b = await previewGbForms(db, ops, { files: [{ filename: 'Sara-2026_form.xlsx', buffer: await form({ name: 'Sara Senior' }) }], cycleId: 'cyc_2026' });
  const res = applyGbForms(db, ops, b.id);
  assert.equal(res.initiatives_redistributed, 1);
  const plan = db.prepare('SELECT * FROM plans WHERE user_id = ?').get(SYN.senior);
  perf.approvePlan(db, as(SYN.manager), plan.id, { note: 'Agreed' });
  db.prepare("UPDATE plan_items SET manager_rating = 4 WHERE plan_id = ? AND category = 'objective'").run(plan.id);
  db.prepare("UPDATE plan_items SET manager_rating = 3 WHERE plan_id = ? AND category = 'competency'").run(plan.id);
  db.prepare("UPDATE plans SET partner_id = ?, state = 'partner_calibration' WHERE id = ?").run(SYN.partner, plan.id);
  const s = perf.planView(db, as(SYN.partner), plan.id).scores.final;
  // 50/30 rescaled to 62.5/37.5 → 4×.625 + 3×.375 = 3.625 → 3.6
  assert.equal(s.raw.toFixed(3), '3.625');
  assert.equal(s.rounded, 3.6);
  assert.ok(s.redistributions.some((r) => r.scope === 'categories'));
});
