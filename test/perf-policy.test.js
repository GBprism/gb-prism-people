import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY as P, computeScore, validatePolicy, promotionGates, addWorkingDays } from '../src/domain/perf/policy.js';

const R = (d, o, c, k) => ({ delivery: { score: d }, ownership: { score: o }, communication: { score: c }, contribution: { score: k } });

test('score: integer points, bands on exact points, the brief’s example', () => {
  assert.deepEqual(validatePolicy(P), []);
  const s = computeScore(P, R(4, 4, 3, 3));
  assert.equal(s.points, 365); assert.equal(s.display, '3.65'); assert.equal(s.band, 'Meets');
  // band boundaries
  assert.equal(computeScore(P, R(5, 5, 5, 5)).band, 'Exceptional');
  assert.equal(computeScore(P, R(4, 4, 4, 3)).points, 385); assert.equal(computeScore(P, R(4, 4, 4, 3)).band, 'Exceeds');
  assert.equal(computeScore(P, R(4, 3, 4, 4)).points, 370); assert.equal(computeScore(P, R(4, 3, 4, 4)).band, 'Meets');
  assert.equal(computeScore(P, R(3, 3, 3, 3)).band, 'Meets'); assert.equal(computeScore(P, R(2, 2, 2, 2)).band, 'Partially Meets'); assert.equal(computeScore(P, R(1, 1, 1, 1)).band, 'Below');
  assert.equal(computeScore(P, R(5, 4, 4, 5)).points, 450); assert.equal(computeScore(P, R(5, 4, 4, 5)).band, 'Exceptional'); // exactly on the boundary
  assert.equal(computeScore(P, R(5, 4, 4, 4)).points, 435); assert.equal(computeScore(P, R(5, 4, 4, 4)).band, 'Exceeds');
  assert.equal(computeScore(P, R(5, 5, 4, 4)).points, 465); assert.equal(computeScore(P, R(5, 5, 4, 4)).band, 'Exceptional');
});

test('score: missing evidence stays pending; insufficient closes without a score; approved N/A normalises once, half up', () => {
  assert.equal(computeScore(P, { delivery: { score: 4 }, ownership: { score: 4 }, communication: { score: 3 } }).status, 'pending');
  assert.deepEqual(computeScore(P, { ...R(4, 4, 3, 3), ownership: { insufficient: true } }).points, null);
  const na = computeScore(P, { delivery: { score: 4 }, ownership: { score: 4 }, communication: { score: 3 }, contribution: { na: true } });
  // (4×35 + 4×30 + 3×20) / 85 = 320/85 = 3.7647 → 3.76
  assert.equal(na.points, 376); assert.equal(na.display, '3.76'); assert.equal(na.band, 'Exceeds');
  assert.equal(na.applied_weights.contribution, 0); assert.equal(na.applied_weights.delivery, 41.18);
  // half-up at exactly .xx5: (3×35+3×30+4×20)/85 = 275/85 = 3.23529 → 3.24 ; and a true .005 case
  assert.equal(computeScore(P, { delivery: { score: 3 }, ownership: { score: 3 }, communication: { score: 4 }, contribution: { na: true } }).points, 324);
  const p2 = { ...P, dimensions: [{ key: 'a', weight: 50 }, { key: 'b', weight: 30 }, { key: 'c', weight: 20 }] };
  // a N/A: (3×30 + 4×20)/50 = 170/50 = 3.40 ; b N/A: (3×50+4×20)/70 = 230/70 = 3.2857 → 3.29
  assert.equal(computeScore(p2, { a: { na: true }, b: { score: 3 }, c: { score: 4 } }).points, 340);
  assert.equal(computeScore(p2, { a: { score: 3 }, b: { na: true }, c: { score: 4 } }).points, 329);
  // exact half: (1×25+2×... ) — weights 40/40/20, c N/A: (3×40+4×40)/80 = 3.5 exactly → 350
  const p3 = { ...P, dimensions: [{ key: 'a', weight: 40 }, { key: 'b', weight: 40 }, { key: 'c', weight: 20 }] };
  assert.equal(computeScore(p3, { a: { score: 3 }, b: { score: 4 }, c: { na: true } }).points, 350);
  // 3.125 → 3.13 (half up): weights 50/30/20 with c N/A and 2/5? (2×50 + 5×30)/80 = 250/80 = 3.125
  assert.equal(computeScore(p2, { a: { score: 2 }, b: { score: 5 }, c: { na: true } }).points, 313);
});

test('promotion gates: score ≥ 4.00, no dimension below 3, six months of scope, unset policy stays unset', () => {
  const ok = promotionGates(P, { points: 400, ratings: R(4, 4, 4, 4), scopeMonths: 7, economic: 'Covers AM role on 2 engagements', payWithinBand: true });
  assert.equal(ok.eligible, true);
  assert.equal(ok.gates.find((g) => g.key === 'time_in_grade').state, 'not_set');
  const low = promotionGates(P, { points: 430, ratings: R(5, 5, 2, 5), scopeMonths: 7, economic: 'x', payWithinBand: true });
  assert.equal(low.eligible, false); assert.match(low.blocking.join(), /No rated dimension below 3/);
  const short = promotionGates(P, { points: 399, ratings: R(4, 4, 4, 4), scopeMonths: 5, economic: 'x', payWithinBand: false });
  assert.deepEqual(short.blocking.length, 3);
  assert.equal(promotionGates(P, { points: 420, ratings: R(4, 4, 4, 5), scopeMonths: 6, economic: 'x', payWithinBand: false, payException: 'Founders approved, market' }).eligible, true);
});

test('working days skip the weekend and holidays', () => {
  assert.equal(addWorkingDays('2026-11-26', 5), '2026-12-03'); // Thu → next Thu (Fri/Sat off)
  assert.equal(addWorkingDays('2026-11-26', 5, [0, 1, 2, 3, 4], new Set(['2026-11-29'])), '2026-12-06');
});
