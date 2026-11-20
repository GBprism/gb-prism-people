// Weighted performance scoring.
//
//   category score = Σ (item rating × normalized item weight)
//   overall        = Σ (category score × normalized category weight)
//
// Weights are validated (category weights = 100, applicable item weights per
// category = 100). Missing ratings leave the plan UNSCORED (never treated as
// zero). N/A is only honoured when the cycle's rule allows it AND the N/A was
// approved; the resulting redistribution is returned in `redistributions` so it
// can be shown and recorded. Precision and thresholds are applied once, to the
// overall score, at the end.

export const DEFAULT_SCORING = {
  status: 'candidate', // GB must approve before live use
  scale: {
    min: 1, max: 5, step: 1, // GB 2025 summary used 0.1 steps (e.g. 3.8)
    anchors: {
      1: 'Did not meet expectations',
      2: 'Partially met expectations',
      3: 'Met expectations',
      4: 'Exceeded expectations',
      5: 'Far exceeded expectations',
    },
  },
  // GB form bands (2026 PMS forms): 4.5–5 / 4–4.4 / 3.0–3.9 / 2.0–2.9 / <2.0.
  // Bands are written at one decimal, so the score is rounded to 1 dp (half up)
  // before banding — otherwise 4.45 falls in the gap between 4.4 and 4.5
  // (the AM form's IF() formula returns FALSE there). Candidate until GB confirms.
  precision: 1,
  thresholds: [
    { min: 4.5, label: 'Outstanding Performer' },
    { min: 4.0, label: 'Excellent Performer' },
    { min: 3.0, label: 'Meets Performance Expectation' },
    { min: 2.0, label: 'Partially Meets Standards of Performance' },
    { min: 0, label: 'Below Acceptable Standards of Performance' },
  ],
  naRule: 'redistribute_within_category', // or 'not_allowed'
  evidenceRequiredForSelf: true,
};

const CATS = ['objective', 'competency', 'initiative'];
const EPS = 1e-6;

export function round(x, precision) {
  const f = 10 ** precision;
  return Math.round((x + Number.EPSILON) * f) / f;
}

export function ratingFor(item, field) {
  if (field === 'final') return item.calibrated_rating ?? item.manager_rating ?? null;
  return item[field] ?? null;
}

/** Structural validation of a plan's weights (independent of ratings). */
export function validateWeights(categoryWeights, items) {
  const errors = [];
  const cw = normalizeCatWeights(categoryWeights);
  const total = Object.values(cw).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 100) > EPS) errors.push({ code: 'category_total', message: `Category weights total ${fmt(total)}%, expected 100%` });
  for (const c of CATS) {
    const its = items.filter((i) => i.category === c);
    if (cw[c] > 0 && its.length === 0) errors.push({ code: 'category_empty', category: c, message: `${label(c)} carries ${cw[c]}% but has no items` });
    if (its.length === 0) continue;
    if (cw[c] === 0) errors.push({ code: 'category_unweighted', category: c, message: `${label(c)} has items but 0% category weight` });
    const sum = its.reduce((a, i) => a + (Number(i.weight) || 0), 0);
    const missing = its.filter((i) => i.weight === null || i.weight === undefined || i.weight === '');
    if (missing.length) errors.push({ code: 'item_weight_missing', category: c, message: `${missing.length} ${label(c).toLowerCase()} item(s) have no weight` });
    if (Math.abs(sum - 100) > EPS) errors.push({ code: 'item_total', category: c, message: `${label(c)} item weights total ${fmt(sum)}%, expected 100%` });
    for (const i of its) if (Number(i.weight) < 0) errors.push({ code: 'negative_weight', message: `Negative weight on "${i.title}"` });
  }
  return errors;
}

/**
 * Compute a score. `field` is 'self_rating' | 'manager_rating' | 'final'.
 * Returns { status: 'scored'|'incomplete'|'invalid', ... } — never throws on
 * data problems so the UI can always show what is missing.
 */
export function computeScore({ categoryWeights, items, config = DEFAULT_SCORING, field = 'final', requireEvidence = false }) {
  const cfg = { ...DEFAULT_SCORING, ...config, scale: { ...DEFAULT_SCORING.scale, ...(config?.scale || {}) } };
  const errors = validateWeights(categoryWeights, items);
  const missing = [];
  const pendingNa = [];
  const redistributions = [];
  const cw = normalizeCatWeights(categoryWeights);
  const categories = [];

  for (const c of CATS) {
    const its = items.filter((i) => i.category === c);
    if (!its.length || cw[c] === 0) continue;
    const applicable = [];
    for (const i of its) {
      if (i.na) {
        if (cfg.naRule === 'not_allowed') errors.push({ code: 'na_not_allowed', itemId: i.id, message: `N/A is not allowed this cycle ("${i.title}")` });
        else if (!i.na_approved_by) pendingNa.push({ itemId: i.id, title: i.title });
        continue;
      }
      applicable.push(i);
      const r = ratingFor(i, field);
      if (r === null) missing.push({ itemId: i.id, title: i.title, category: c, what: 'rating' });
      else if (!validRating(r, cfg.scale)) errors.push({ code: 'rating_range', itemId: i.id, message: `Rating ${r} outside ${cfg.scale.min}–${cfg.scale.max} on "${i.title}"` });
      if (requireEvidence && i.evidence_required && !hasEvidence(i)) missing.push({ itemId: i.id, title: i.title, category: c, what: 'evidence' });
    }
    const naWeight = its.filter((i) => i.na).reduce((a, i) => a + Number(i.weight || 0), 0);
    const applW = applicable.reduce((a, i) => a + Number(i.weight || 0), 0);
    if (naWeight > 0 && applicable.length) {
      redistributions.push({ scope: 'items', category: c, naWeight, message: `${fmt(naWeight)}% of ${label(c).toLowerCase()} weight marked N/A; remaining items rescaled from ${fmt(applW)}% to 100%` });
    }
    const rows = applicable.map((i) => {
      const nw = applW > 0 ? Number(i.weight || 0) / applW : 0;
      const r = ratingFor(i, field);
      return { itemId: i.id, title: i.title, weight: Number(i.weight || 0), normWeight: nw, rating: r, contribution: r === null ? null : r * nw };
    });
    const complete = rows.every((r) => r.rating !== null);
    const score = applicable.length && complete ? rows.reduce((a, r) => a + r.contribution, 0) : null;
    categories.push({ category: c, label: label(c), weight: cw[c], effectiveWeight: cw[c], allNa: applicable.length === 0, items: rows, score });
  }

  // Category redistribution when a whole category is N/A.
  const live = categories.filter((k) => !k.allNa);
  const deadW = categories.filter((k) => k.allNa).reduce((a, k) => a + k.weight, 0);
  if (deadW > 0) {
    const liveW = live.reduce((a, k) => a + k.weight, 0);
    for (const k of categories) k.effectiveWeight = k.allNa ? 0 : (liveW ? (k.weight / liveW) * 100 : 0);
    redistributions.push({ scope: 'categories', naWeight: deadW, message: `${fmt(deadW)}% category weight N/A; other categories rescaled proportionally` });
  }

  if (pendingNa.length) errors.push({ code: 'na_pending', message: `${pendingNa.length} N/A item(s) awaiting approval`, items: pendingNa });

  let status = 'scored';
  if (errors.length) status = 'invalid';
  else if (missing.length) status = 'incomplete';

  let raw = null; let rounded = null; let rating = null;
  if (status === 'scored') {
    raw = live.reduce((a, k) => a + k.score * (k.effectiveWeight / 100), 0);
    rounded = round(raw, cfg.precision);
    rating = (cfg.thresholds.find((t) => rounded >= t.min - EPS) || {}).label || null;
  }
  const math = explain(categories, raw, rounded, rating, cfg);
  return { status, field, errors, missing, redistributions, categories, raw, rounded, rating, precision: cfg.precision, math, configStatus: cfg.status };
}

function explain(categories, raw, rounded, rating, cfg) {
  const lines = [];
  for (const k of categories) {
    if (k.allNa) { lines.push(`${k.label}: all items N/A — weight redistributed`); continue; }
    const parts = k.items.map((r) => `${r.rating ?? '?'} × ${fmt(r.normWeight * 100)}%`);
    lines.push(`${k.label} = ${parts.join(' + ')} = ${k.score === null ? 'unscored' : fmt(k.score, 4)}`);
  }
  const live = categories.filter((k) => !k.allNa);
  if (raw !== null) {
    lines.push(`Overall = ${live.map((k) => `${fmt(k.score, 4)} × ${fmt(k.effectiveWeight)}%`).join(' + ')} = ${fmt(raw, 4)}`);
    lines.push(`Rounded to ${cfg.precision} dp = ${rounded} → ${rating ?? 'no threshold'}`);
  } else {
    lines.push('Overall: unscored until every applicable item is rated and weights are valid');
  }
  return lines;
}

export function validRating(r, scale) {
  if (typeof r !== 'number' || !Number.isFinite(r) || r < scale.min - EPS || r > scale.max + EPS) return false;
  const steps = (r - scale.min) / (scale.step || 1);
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

function hasEvidence(i) {
  const ev = typeof i.self_evidence_json === 'string' ? JSON.parse(i.self_evidence_json || '[]') : i.self_evidence_json || [];
  return Array.isArray(ev) && ev.some((e) => (e.url || e.note || '').trim());
}
function normalizeCatWeights(cw = {}) {
  const o = {};
  for (const c of CATS) o[c] = Number(cw?.[c] ?? 0) || 0;
  return o;
}
const label = (c) => ({ objective: 'Objectives', competency: 'Competencies', initiative: 'Internal initiatives' }[c] || c);
function fmt(n, dp = 2) {
  if (n === null || n === undefined) return '—';
  return String(round(n, dp));
}
