import test from 'node:test';
import assert from 'node:assert/strict';
import { computeScore, validateWeights, DEFAULT_SCORING } from '../src/domain/scoring.js';

const it = (id, category, weight, r, extra = {}) => ({ id, title: id, category, weight, manager_rating: r, ...extra });

test('75/25 scheme (2025 generic form)', () => {
  const items = [it('o1', 'objective', 60, 4), it('o2', 'objective', 40, 3), it('c1', 'competency', 100, 5)];
  const s = computeScore({ categoryWeights: { objective: 75, competency: 25 }, items, field: 'manager_rating' });
  assert.equal(s.status, 'scored');
  // objectives = 4*.6 + 3*.4 = 3.6 ; overall = 3.6*.75 + 5*.25 = 3.95
  assert.equal(s.categories[0].score.toFixed(4), '3.6000');
  assert.equal(s.raw.toFixed(4), '3.9500');
  assert.equal(s.rounded, 4); // GB bands: rounded to 1 dp before banding
  assert.equal(s.rating, 'Excellent Performer');
  assert.match(s.math.join('\n'), /Overall = 3\.6 × 75% \+ 5 × 25% = 3\.95/);
  const p2 = computeScore({ categoryWeights: { objective: 75, competency: 25 }, items, field: 'manager_rating', config: { ...DEFAULT_SCORING, precision: 2 } });
  assert.equal(p2.rating, 'Meets Performance Expectation'); // precision is a GB decision — it changes the band
});

test('40/40/20 scheme (Consultant / AM samples)', () => {
  const items = [it('o1', 'objective', 50, 4), it('o2', 'objective', 50, 4), it('c1', 'competency', 50, 3), it('c2', 'competency', 50, 4), it('i1', 'initiative', 100, 2)];
  const s = computeScore({ categoryWeights: { objective: 40, competency: 40, initiative: 20 }, items, field: 'manager_rating' });
  // 4*.4 + 3.5*.4 + 2*.2 = 1.6 + 1.4 + .4 = 3.4
  assert.equal(s.rounded, 3.4);
});

test('50/30/20 scheme (Senior Consultant sample)', () => {
  const items = [it('o1', 'objective', 40, 5), it('o2', 'objective', 30, 4), it('o3', 'objective', 30, 3), it('c1', 'competency', 50, 4), it('c2', 'competency', 50, 3), it('i1', 'initiative', 100, 4)];
  const s = computeScore({ categoryWeights: { objective: 50, competency: 30, initiative: 20 }, items, field: 'manager_rating' });
  // obj = 2 + 1.2 + .9 = 4.1 ; comp 3.5 ; overall = 2.05 + 1.05 + .8 = 3.9
  assert.equal(s.rounded, 3.9);
});

test('missing rating leaves the plan unscored (never zero)', () => {
  const items = [it('o1', 'objective', 100, 4), it('c1', 'competency', 100, null)];
  const s = computeScore({ categoryWeights: { objective: 50, competency: 50 }, items, field: 'manager_rating' });
  assert.equal(s.status, 'incomplete');
  assert.equal(s.raw, null);
  assert.deepEqual(s.missing.map((m) => m.itemId), ['c1']);
});

test('N/A: pending approval blocks scoring; approved N/A redistributes visibly', () => {
  const items = [it('o1', 'objective', 50, 4), it('o2', 'objective', 50, null, { na: 1, na_reason: 'Project cancelled' }), it('c1', 'competency', 100, 3)];
  const pending = computeScore({ categoryWeights: { objective: 50, competency: 50 }, items, field: 'manager_rating' });
  assert.equal(pending.status, 'invalid');
  assert.ok(pending.errors.some((e) => e.code === 'na_pending'));
  items[1].na_approved_by = 'u_partner';
  const s = computeScore({ categoryWeights: { objective: 50, competency: 50 }, items, field: 'manager_rating' });
  assert.equal(s.status, 'scored');
  assert.equal(s.rounded, 3.5); // o1 carries 100% of objectives
  assert.match(s.redistributions[0].message, /rescaled from 50% to 100%/);
  const strict = computeScore({ categoryWeights: { objective: 50, competency: 50 }, items, field: 'manager_rating', config: { ...DEFAULT_SCORING, naRule: 'not_allowed' } });
  assert.equal(strict.status, 'invalid');
});

test('whole category N/A redistributes category weights', () => {
  const items = [it('o1', 'objective', 100, 4), it('c1', 'competency', 100, 2), it('i1', 'initiative', 100, null, { na: 1, na_reason: 'n/a', na_approved_by: 'x' })];
  const s = computeScore({ categoryWeights: { objective: 40, competency: 40, initiative: 20 }, items, field: 'manager_rating' });
  assert.equal(s.rounded, 3);
  assert.ok(s.redistributions.some((r) => r.scope === 'categories'));
});

test('GB bands have no gap between 4.4 and 4.5', () => {
  const items = [it('a', 'objective', 55, 4), it('b', 'objective', 45, 5)]; // 4.45
  const s = computeScore({ categoryWeights: { objective: 100 }, items, field: 'manager_rating' });
  assert.equal(s.raw.toFixed(2), '4.45');
  assert.equal(s.rating, 'Outstanding Performer');
});

test('weight validation', () => {
  const e = validateWeights({ objective: 70, competency: 25 }, [it('o', 'objective', 90, 1), it('c', 'competency', 100, 1)]);
  assert.ok(e.some((x) => x.code === 'category_total'));
  assert.ok(e.some((x) => x.code === 'item_total'));
});

test('precision applied once at the end', () => {
  // 3 items at 1/3 weight each => category exactly 11/3 = 3.666..; rounding only at the end
  const items = [it('a', 'objective', 33.333333, 4), it('b', 'objective', 33.333333, 4), it('c', 'objective', 33.333334, 3)];
  const s = computeScore({ categoryWeights: { objective: 100 }, items, field: 'manager_rating', config: { ...DEFAULT_SCORING, precision: 1 } });
  assert.equal(s.rounded, 3.7);
});

test('self, manager and final ratings stay independent', () => {
  const items = [{ id: 'o', title: 'o', category: 'objective', weight: 100, self_rating: 5, manager_rating: 3, calibrated_rating: 4 }];
  const cw = { objective: 100 };
  assert.equal(computeScore({ categoryWeights: cw, items, field: 'self_rating' }).rounded, 5);
  assert.equal(computeScore({ categoryWeights: cw, items, field: 'manager_rating' }).rounded, 3);
  assert.equal(computeScore({ categoryWeights: cw, items, field: 'final' }).rounded, 4);
});

test('GB 2025 team summary math reproduces the sheet (1 dp, 0.1 rating steps)', () => {
  const dims = [25, 25, 20, 15, 15];
  const rows = [[[5, 5, 3.5, 4, 4.5], 4.5], [[4.5, 4.5, 5, 4.5, 4.5], 4.6], [[4, 3.5, 3.5, 3.5, 3.5], 3.6], [[3.8, 3.5, 3.5, 3.5, 3.5], 3.6], [[4.5, 4.5, 4, 4, 4], 4.3], [[3.5, 3.5, 3.8, 4, 3.5], 3.6]];
  for (const [ratings, total] of rows) {
    const items = ratings.map((r, i) => ({ id: `d${i}`, title: `d${i}`, category: 'competency', weight: dims[i], manager_rating: r }));
    const s = computeScore({ categoryWeights: { competency: 100 }, items, field: 'manager_rating', config: { ...DEFAULT_SCORING, precision: 1, scale: { min: 1, max: 5, step: 0.1 } } });
    assert.equal(s.status, 'scored', JSON.stringify(s.errors));
    assert.equal(s.rounded, total, `ratings ${ratings}`);
  }
});
