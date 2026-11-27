// Performance policy (2027 onward) and the annual score. Pure functions — no database.
//
// Dimension scores are whole numbers 1–5. Points = Σ score × weight% (integers), so 4,4,3,3 on
// 35/30/20/15 = 365 points = 3.65. Bands are compared on the same exact points. When a dimension is
// founder-approved as not applicable, the remaining weights are normalised to their sum and the result is
// rounded ONCE, half up, to two decimals; that canonical value is used for display and every gate.
// Missing evidence is never scored: the review stays pending or closes as "insufficient evidence".

export const DEFAULT_POLICY = {
  name: 'GB Advisory performance policy',
  dimensions: [
    { key: 'delivery', label: 'Delivery quality and problem-solving', weight: 35, examples: 'Accuracy, traceable evidence, fit to scope, quality of recommendations and usability of outputs. Source quality is professional judgment and delivery quality.' },
    { key: 'ownership', label: 'Ownership and reliability', weight: 30, examples: 'Follows through on assigned commitments, plans dependencies, flags risks, drives closure within scope. Includes scope discipline, delivery risk and timely escalation.' },
    { key: 'communication', label: 'Communication and professional judgment', weight: 20, examples: 'Clear communication with the stakeholders actually assigned, sound escalation, collaboration and response to feedback.' },
    { key: 'contribution', label: 'Contribution to GB Advisory', weight: 15, examples: 'Agreed proposals, reusable assets, mentoring or internal improvements, scaled to role and protected capacity.' },
  ],
  scale: { 1: 'Materially below role expectations', 2: 'Inconsistently meets', 3: 'Reliably meets', 4: 'Frequently exceeds, with evidence', 5: 'Sustained exceptional impact at the current level' },
  // minimum points (score × 100) for each band, highest first
  bands: [{ min: 450, label: 'Exceptional' }, { min: 375, label: 'Exceeds' }, { min: 300, label: 'Meets' }, { min: 200, label: 'Partially Meets' }, { min: 100, label: 'Below' }],
  rubric: {
    'Business Analyst': 'Validates inputs and flags issues early.',
    Consultant: 'Owns a defined deliverable and explains its logic.',
    'Senior Consultant': 'Independently leads a workstream.',
    'Assistant Manager': 'Coordinates delivery and team quality, or owns defined engagement responsibilities. Ops track: owns defined operational processes and their quality. Client Engagement track: owns defined client relationships and engagement coordination.',
    Manager: 'Owns engagements and resource trade-offs.',
    'Senior Manager': 'Owns accounts and capabilities.',
    Director: 'Leads strategic growth and leverage.',
    Partner: 'A separate ownership decision — not reached through the annual score.',
  },
  fairness: 'Exclude counts of formatting comments, noise complaints, prompt or demo quotas, hobbies, age and salary. Do not penalise staffing allocation, lack of client exposure, an approved scope change, leave or a client-controlled delay — assess the actions the person controlled. Formatting and AI use count only through their impact on an agreed deliverable or initiative. Client feedback is optional context.',
  promotion: { min_score_points: 400, min_dimension: 3, next_level_months: 6, min_months_in_grade: null, require_economic_justification: true, require_pay_within_band: true },
  coaching: { months: [3, 6, 9], career_month: 6 },
  snapshot: { due_working_days: 5, quarterly_days: 90 },
  compensation: { bands: null, bonus_guidance_months: null, employee_release: false },
};

/** Structural check: whole-number weights that add up to 100, bands in points. */
export function validatePolicy(p) {
  const errors = [];
  const total = p.dimensions.reduce((s, d) => s + d.weight, 0);
  if (p.dimensions.some((d) => !Number.isInteger(d.weight) || d.weight <= 0)) errors.push('Each weight is a whole positive percentage');
  if (total !== 100) errors.push(`Weights add up to ${total}%, not 100%`);
  if (new Set(p.dimensions.map((d) => d.key)).size !== p.dimensions.length) errors.push('Dimension keys must be unique');
  if (!p.bands?.length || p.bands.some((b) => !Number.isInteger(b.min))) errors.push('Bands are whole points (score × 100)');
  return errors;
}

/** Half-up rounding of a non-negative rational a/b to two decimals, returned as integer hundredths. */
const halfUpHundredths = (num, den) => Math.floor((num * 2 + den) / (2 * den));

/**
 * ratings: { [dimension]: { score: 1..5 | null, na: bool (founder-approved), insufficient: bool } }
 * Returns { status: 'scored' | 'pending' | 'insufficient', points (hundredths), display, band, applied_weights, missing }.
 */
export function computeScore(policy, ratings = {}) {
  const missing = []; const applied = {};
  let num = 0; let wsum = 0;
  for (const d of policy.dimensions) {
    const r = ratings[d.key] || {};
    if (r.na) { applied[d.key] = 0; continue; }
    if (r.insufficient) return { status: 'insufficient', points: null, display: null, band: null, applied_weights: null, missing: [d.key] };
    if (!Number.isInteger(r.score) || r.score < 1 || r.score > 5) { missing.push(d.key); continue; }
    num += r.score * d.weight; wsum += d.weight; applied[d.key] = d.weight;
  }
  if (missing.length) return { status: 'pending', points: null, display: null, band: null, applied_weights: null, missing };
  if (!wsum) return { status: 'pending', points: null, display: null, band: null, applied_weights: null, missing: ['all dimensions are N/A'] };
  // points in hundredths of a score: (num / wsum) × 100, rounded once half-up
  const points = halfUpHundredths(num * 100, wsum);
  const normalised = wsum === 100 ? applied : Object.fromEntries(Object.entries(applied).map(([k, w]) => [k, Math.round((w * 10000) / wsum) / 100]));
  return { status: 'scored', points, display: (points / 100).toFixed(2), band: bandFor(policy, points), applied_weights: normalised, missing: [] };
}
export function bandFor(policy, points) { return (policy.bands.find((b) => points >= b.min) || policy.bands.at(-1)).label; }

/** Promotion gates. Missing policy values are "not set", never invented. */
export function promotionGates(policy, { points, ratings = {}, scopeMonths = null, monthsInGrade = null, economic = '', payWithinBand = null, payException = '' }) {
  const g = policy.promotion; const gates = [];
  const add = (key, label, state, why) => gates.push({ key, label, state, why });
  if (points == null) add('score', `Annual score at least ${(g.min_score_points / 100).toFixed(2)}`, 'pending', 'No released annual score yet');
  else add('score', `Annual score at least ${(g.min_score_points / 100).toFixed(2)}`, points >= g.min_score_points ? 'pass' : 'fail', `Score ${(points / 100).toFixed(2)}`);
  const low = Object.entries(ratings).filter(([, r]) => !r.na && Number.isInteger(r.score) && r.score < g.min_dimension).map(([k]) => k);
  add('dimension', `No rated dimension below ${g.min_dimension}`, points == null ? 'pending' : low.length ? 'fail' : 'pass', low.length ? `Below ${g.min_dimension}: ${low.join(', ')}` : '');
  add('scope', `Next-level responsibility for at least ${g.next_level_months} months`, scopeMonths == null ? 'pending' : scopeMonths >= g.next_level_months ? 'pass' : 'fail', scopeMonths == null ? 'Dates of sustained scope not given' : `${scopeMonths} months shown`);
  add('time_in_grade', 'Minimum time in grade', g.min_months_in_grade == null ? 'not_set' : monthsInGrade == null ? 'pending' : monthsInGrade >= g.min_months_in_grade ? 'pass' : 'fail',
    g.min_months_in_grade == null ? 'Policy value not set by the founders' : `${monthsInGrade ?? '?'} of ${g.min_months_in_grade} months`);
  if (g.require_economic_justification) add('economic', 'Economic justification', String(economic || '').trim() ? 'pass' : 'pending', String(economic || '').trim() ? '' : 'Not written yet');
  if (g.require_pay_within_band) add('band', 'Post-promotion pay within band, or authorised exception', payWithinBand === true ? 'pass' : payWithinBand === false ? (String(payException || '').trim() ? 'pass' : 'fail') : 'pending',
    payWithinBand === false ? (payException ? `Exception: ${payException}` : 'Outside band, no exception') : payWithinBand == null ? 'Band position not recorded' : '');
  return { gates, eligible: gates.every((x) => x.state === 'pass' || x.state === 'not_set'), blocking: gates.filter((x) => x.state === 'fail').map((x) => x.label) };
}

/** Add n working days to a date using the tenant work week and holidays (Map or Set of yyyy-mm-dd). */
export function addWorkingDays(start, n, workweek = [0, 1, 2, 3, 4], holidays = new Set()) {
  let d = new Date(`${start}T00:00:00Z`); let left = n;
  while (left > 0) { d = new Date(d.getTime() + 864e5); const iso = d.toISOString().slice(0, 10); if (workweek.includes(d.getUTCDay()) && !holidays.has(iso)) left--; }
  return d.toISOString().slice(0, 10);
}
