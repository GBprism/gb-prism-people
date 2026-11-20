// Importer for GB Advisory's "2026 Employee Eval. Form" workbooks (one file per
// employee, per-role folders on Drive). Prism never trusts the workbook's own
// totals: it re-derives scores from item ratings and weights and reports every
// formula problem it finds so GB can correct the source.
//
// Allowlisted personal fields: Name, Position, Date of Joining.
// Never read: Age, Current Salary, Years of Experience, Hobby, Favorite AI Tool, Favorite Book.
import { tx, uid, now, J, audit, bad, forbid, conflict } from '../db.js';
import { isOps } from '../domain/authz.js';
import { insertItem } from '../domain/performance.js';
import { validateWeights, round } from '../domain/scoring.js';
import { readWorkbook, sha256, str, val } from './xlsx.js';
import { saveBatch, findExisting, matchPerson, markApplied, requirePreviewed, getBatch } from './batch.js';

const PLACEHOLDER = /^insert .* here$/i;
// The template ships with an example on objective 1 that every copy inherited.
const TEMPLATE_SAMPLE = { L: 'Failed in delivery of project', M: 3, N: 'Target not achieved fully but within range' };
const LEVELS = { basic: 2, intermediate: 3, advanced: 4, expert: 5 };
const SECTION = [
  { re: /^OBJECTIVES.*?(\d+)\s*%/i, cat: 'objective' },
  { re: /^COMPETENCIES.*?(\d+)\s*%/i, cat: 'competency' },
  { re: /^Internal Initiatives.*?(\d+)\s*%/i, cat: 'initiative' },
];
const COL = { num: 0, title: 1, desc: 2, kpi: 3, weight: 4, target: 5, date: 6, approvalOrLevel: 7, notes: 8, actual: 9, self: 10, empComment: 11, sup: 12, supComment: 13, final: 14 };
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

const clean = (c) => {
  const v = val(c);
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') { const s = v.trim(); return !s || PLACEHOLDER.test(s) ? null : s; }
  return v;
};

/** Weight cell → percent. Recovers fractions that Excel displays as times (0.2 → 04:48). */
function weightPct(cell, issues, label) {
  const v = val(cell);
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    const frac = (v.getTime() - EXCEL_EPOCH) / 86400000;
    issues.push(`${label}: weight cell is formatted as a time; read as ${round(frac * 100, 4)}%`);
    return round(frac * 100, 6);
  }
  const n = Number(v);
  if (Number.isNaN(n)) { issues.push(`${label}: weight "${v}" is not a number`); return null; }
  return n <= 1 ? round(n * 100, 6) : n;
}

export function parseGbForm(sheets, filename) {
  const ws = sheets.find((s) => /Employee Eval/i.test(s.name)) || sheets[0];
  const R = ws.rows;
  const at = (r, c) => (R[r] || [])[c];
  const issues = []; const formulaIssues = [];
  // personal block (allowlist)
  const findLabel = (re) => { for (let r = 0; r < 15; r++) for (let c = 0; c < 9; c++) if (re.test(str(at(r, c)))) return at(r, c + 1); return null; };
  const name = clean(findLabel(/^Name\s*$/i));
  const position = clean(findLabel(/^Position\s*$/i));
  const joined = clean(findLabel(/^Date of Joining/i));
  const fileName = (/^(.+?)-20\d\d_/.exec(filename || '') || [])[1] || null;
  if (!name) issues.push('Name cell is blank — identity taken from the file name and must be confirmed');

  // sections & items
  const sections = {}; let cur = null; let header = null;
  for (let r = 0; r < R.length; r++) {
    const a = str(at(r, 0));
    const s = SECTION.find((x) => x.re.test(a));
    if (s) { cur = s.cat; sections[cur] = { declared: Number(s.re.exec(a)[1]), row: r + 1, items: [], scoreFormula: null }; header = null; continue; }
    if (!cur) continue;
    if (a === '#') { header = R[r].map(str); continue; }
    if (/Total Annual Performance Rating/i.test(a)) { cur = null; continue; }
    const avg = str(at(r, 13));
    if (/Average Rating/i.test(avg)) { sections[cur].scoreFormula = { cell: `O${r + 1}`, formula: at(r, 14)?.formula ?? null, error: at(r, 14)?.error ?? null, row: r + 1 }; continue; }
    const num = val(at(r, 0));
    if (typeof num !== 'number') continue;
    const label = `${cur} #${num}`;
    const itIssues = [];
    const title = clean(at(r, COL.title));
    const w = weightPct(at(r, COL.weight), itIssues, label);
    const levelText = cur === 'competency' ? clean(at(r, COL.approvalOrLevel)) : null;
    const approval = cur !== 'competency' ? clean(at(r, COL.approvalOrLevel)) : null;
    let empComment = clean(at(r, COL.empComment)); let sup = clean(at(r, COL.sup)); let supComment = clean(at(r, COL.supComment));
    if (empComment === TEMPLATE_SAMPLE.L && Number(sup) === TEMPLATE_SAMPLE.M && supComment === TEMPLATE_SAMPLE.N) {
      itIssues.push(`${label}: template example text (comment/rating 3/comment) ignored — not a real assessment`);
      empComment = null; sup = null; supComment = null;
    }
    sections[cur].items.push({
      row: r + 1, num, title: title ? title.replace(/^\d+\.\s*/, '') : null, description: clean(at(r, COL.desc)), kpi: clean(at(r, COL.kpi)), weight: w,
      target: clean(at(r, COL.target)), target_date: clean(at(r, COL.date)), approval, level: levelText,
      expected_proficiency: levelText ? LEVELS[levelText.toLowerCase()] ?? null : null,
      actual: clean(at(r, COL.actual)), self_rating: num2(clean(at(r, COL.self))), employee_comment: empComment,
      supervisor_rating: num2(sup), supervisor_comment: supComment, final_rating: num2(clean(at(r, COL.final))), issues: itIssues,
    });
  }

  // criteria table (category weights) + formula audit
  const criteria = {};
  for (let r = 0; r < R.length; r++) {
    const a = str(at(r, 0));
    const m = /^\d\.\s*(Objectives|Competencies|Internal Initiatives)/i.exec(a);
    if (!m) continue;
    const cat = { objectives: 'objective', competencies: 'competency', 'internal initiatives': 'initiative' }[m[1].toLowerCase()];
    const w = Number(val(at(r, 2)));
    const ref = at(r, 3)?.formula || null;
    criteria[cat] = { weight: w <= 1 ? round(w * 100, 6) : w, row: r + 1, ratingFormula: ref };
    const expected = sections[cat]?.scoreFormula?.cell;
    if (ref && expected && ref.replace(/^=/, '').trim() !== expected) formulaIssues.push(`${m[1]} rating (D${r + 1}) = ${ref} but the ${m[1].toLowerCase()} score is in ${expected}`);
  }
  const totalCell = R.findIndex((row) => /Total Annual Score/i.test(str(row?.[3])) || /Total Annual Score/i.test(str(row?.[0])));
  const hasTotalFormula = R.some((row) => (row || []).some((c) => /SUM\(H\d+:H\d+\)/i.test(c?.formula || '')));
  if (!hasTotalFormula) formulaIssues.push('No total-score formula (Total Annual Score / Final Rating cells are labels only)');

  for (const [cat, s] of Object.entries(sections)) {
    const f = s.scoreFormula?.formula || '';
    const rows = s.items.map((i) => i.row);
    if (/#REF!/i.test(f)) formulaIssues.push(`${cat} score ${s.scoreFormula.cell} contains #REF!: =${f}`);
    if (/AVERAGE/i.test(f)) formulaIssues.push(`${cat} score ${s.scoreFormula.cell} uses an unweighted AVERAGE (=${f}) while other sections are weighted`);
    else if (f) {
      const terms = [...f.matchAll(/O(\d+)\s*\*\s*([A-Z]+)?(\d+)?/g)].map((m) => ({ o: Number(m[1]), w: m[2] && m[3] ? `${m[2]}${m[3]}` : null }));
      const missing = rows.filter((r) => !terms.some((t) => t.o === r));
      if (missing.length) formulaIssues.push(`${cat} score ${s.scoreFormula.cell} leaves out row(s) ${missing.join(', ')} (=${f})`);
      for (const t of terms) if (t.w && t.w !== `E${t.o}`) formulaIssues.push(`${cat} score multiplies O${t.o} by ${t.w} instead of E${t.o}`);
    }
    if (criteria[cat] && criteria[cat].weight !== s.declared) issues.push(`${cat}: header says ${s.declared}% but the criteria table says ${criteria[cat].weight}%`);
    if (s.scoreFormula?.error && !/DIV\/0/.test(s.scoreFormula.error)) formulaIssues.push(`${cat} score shows ${s.scoreFormula.error}`);
  }
  return { name, fileName, position, joined: joined instanceof Date ? joined.toISOString().slice(0, 10) : joined, sections, criteria, issues, formulaIssues };
}
const num2 = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** Preview a set of GB form files as one reviewed batch. */
export async function previewGbForms(db, actor, { files, cycleId }) {
  if (!isOps(actor)) throw forbid();
  const cycle = db.prepare('SELECT * FROM cycles WHERE id = ? AND tenant_id = ?').get(cycleId, actor.tenantId);
  if (!cycle) throw bad('Choose the target cycle');
  const sha = sha256(Buffer.concat(files.map((f) => Buffer.from(sha256(f.buffer)))));
  const ex = findExisting(db, actor.tenantId, 'pms_gb_form', sha);
  if (ex) return { ...getBatch(db, actor, ex.id), duplicateOf: ex.id };
  const rows = []; const plans = [];
  for (const f of files) {
    const p = parseGbForm(await readWorkbook(f.buffer), f.filename);
    const who = p.name || p.fileName;
    const m = matchPerson(db, actor.tenantId, { name: who, source: 'pms_form' });
    const items = [];
    for (const [cat, s] of Object.entries(p.sections)) for (const it of s.items) {
      if (!it.title && !it.kpi && !it.target) { it.skipped = true; continue; }
      items.push({ ...it, category: cat });
    }
    const declared = Object.fromEntries(Object.entries(p.sections).map(([c, s]) => [c, p.criteria[c]?.weight ?? s.declared]));
    const planIssues = [...p.issues];
    for (const [cat, s] of Object.entries(p.sections)) {
      const skipped = s.items.filter((i) => i.skipped);
      if (skipped.length === s.items.length && s.items.length) planIssues.push(`No ${cat} items defined although the section carries ${declared[cat]}% (rows hold weights ${skipped.map((i) => i.weight + '%').join(' + ')})`);
    }
    const weightErrors = validateWeights(declared, items.map((i) => ({ category: i.category, weight: i.weight, title: i.title }))).map((e) => e.message);
    const noApproval = items.filter((i) => i.category !== 'competency' && !i.approval).length;
    if (noApproval) planIssues.push(`${noApproval} target(s) have no recorded supervisor approval`);
    const rated = items.filter((i) => i.self_rating !== null || i.supervisor_rating !== null).length;
    const lockedPlan = m.userId && db.prepare("SELECT state FROM plans WHERE cycle_id = ? AND user_id = ? AND state IN ('partner_calibration','released','acknowledged','closed')").get(cycleId, m.userId);
    const blocking = [];
    if (lockedPlan) blocking.push(`Existing plan is ${lockedPlan.state} — import blocked`);
    const plan = { file: f.filename, person: who, user_id: m.userId, match_status: m.matchStatus, position: p.position, joined: p.joined, category_weights: declared,
      items: items.length, rated_items: rated, issues: planIssues, formula_issues: p.formulaIssues, weight_errors: weightErrors, blocking };
    plans.push(plan);
    rows.push({ sheet: f.filename, rowNo: 0, sourceKey: `form:${f.filename}`, raw: { plan, items: items.map(({ issues, ...rest }) => rest), item_issues: items.flatMap((i) => i.issues) },
      userId: m.userId, matchStatus: m.matchStatus, issues: [...blocking, ...planIssues, ...p.formulaIssues, ...weightErrors, ...items.flatMap((i) => i.issues)],
      action: blocking.length ? 'reject' : m.userId ? 'insert' : 'review' });
  }
  const summary = { cycle: { id: cycle.id, year: cycle.year }, forms: plans.length, plans, blocking: [],
    excluded_fields: ['Age', 'Current Salary', 'Years of Experience', 'Hobby', 'Favorite AI Tool', 'Favorite Book'],
    warnings: ['Workbook totals are not imported — Prism recalculates from item ratings and approved weights', 'Plans import as drafts with an unverified basis until the line manager approves them in Prism or GB records a decision'] };
  return saveBatch(db, actor, { kind: 'pms_gb_form', filename: `${files.length} GB PMS form(s)`, sha, summary, rows });
}

export function applyGbForms(db, actor, batchId, { reviewers = {}, initiatives } = {}) {
  if (!isOps(actor)) throw forbid();
  return tx(db, () => {
    const b = getBatch(db, actor, batchId);
    requirePreviewed(b);
    const cycleId = b.summary.cycle.id;
    const setting = db.prepare("SELECT value_json FROM settings WHERE tenant_id = ? AND key = ?").get(actor.tenantId, `decision_initiatives_${b.summary.cycle.year}`);
    const initiativeRule = initiatives ?? (setting ? JSON.parse(setting.value_json) : null); // { rule: 'redistribute', note }
    const out = { plans_created: 0, plans_updated: 0, items: 0, needs_review: 0, initiatives_redistributed: 0 };
    for (const r of b.rows) {
      if (r.action === 'review') { out.needs_review++; continue; }
      if (r.action !== 'insert') continue;
      const { plan, items } = r.raw;
      let p = db.prepare('SELECT * FROM plans WHERE cycle_id = ? AND user_id = ?').get(cycleId, r.match_user_id);
      if (p && p.state !== 'draft_plan') throw conflict(`${plan.person} already has a ${p.state} plan in Prism — amend it there instead of re-importing`);
      if (p && (p.self_submitted_at || db.prepare('SELECT 1 FROM plan_items WHERE plan_id = ? AND (self_rating IS NOT NULL OR manager_rating IS NOT NULL)').get(p.id))) throw conflict(`${plan.person} has already started the review in Prism — not overwritten`);
      const emp = db.prepare('SELECT * FROM employments WHERE user_id = ? AND effective_to IS NULL').get(r.match_user_id);
      const note = [...plan.issues, ...plan.weight_errors].join(' · ') || 'Imported from GB form';
      if (!p) {
        const id = uid('plan_');
        db.prepare(`INSERT INTO plans (id, tenant_id, cycle_id, user_id, reviewer_id, partner_id, role_title, category_weights_json, basis_status, basis_note, source_ref, rubric_version, created_at)
            VALUES (?,?,?,?,?,?,?,?, 'unverified', ?, ?, ?, ?)`).run(id, actor.tenantId, cycleId, r.match_user_id, reviewers[r.match_user_id]?.reviewerId ?? emp?.manager_id ?? null,
          reviewers[r.match_user_id]?.partnerId ?? null, plan.position, J(plan.category_weights), note, `${b.id}:${plan.file}`, `gb-form-2026:${plan.position}`, now());
        p = db.prepare('SELECT * FROM plans WHERE id = ?').get(id); out.plans_created++;
      } else {
        db.prepare('DELETE FROM plan_items WHERE plan_id = ?').run(p.id);
        db.prepare("UPDATE plans SET state = 'draft_plan', category_weights_json = ?, basis_status = 'unverified', basis_note = ?, source_ref = ?, row_version = row_version + 1 WHERE id = ?").run(J(plan.category_weights), note, `${b.id}:${plan.file}`, p.id);
        out.plans_updated++;
      }
      items.forEach((it, i) => {
        insertItem(db, actor.tenantId, p.id, { category: it.category, title: it.title || `(untitled ${it.category} ${it.num})`, description: [it.description, it.level ? `Expected level: ${it.level}` : null, it.target_date ? `Target date: ${it.target_date}` : null].filter(Boolean).join('\n'),
          kpi: it.kpi, target: it.target, weight: it.weight, expected_proficiency: it.expected_proficiency, position: i, source_ref: `${b.id}:${plan.file}:row${it.row}` });
        out.items++;
      });
      // GB decision: no initiatives this cycle → one approved N/A item; scoring redistributes the category weight pro rata and shows it
      if (initiativeRule?.rule === 'redistribute' && (plan.category_weights.initiative || 0) > 0 && !items.some((it) => it.category === 'initiative')) {
        const iid = insertItem(db, actor.tenantId, p.id, { category: 'initiative', title: 'Internal initiatives', weight: 100, position: items.length, evidence_required: false,
          description: initiativeRule.note || 'No internal initiatives this cycle (GB decision)', source_ref: `decision:${b.id}` });
        db.prepare('UPDATE plan_items SET na = 1, na_reason = ?, na_approved_by = ? WHERE id = ?').run(initiativeRule.note || 'GB decision: no internal initiatives this cycle; weight redistributed', actor.id, iid);
        out.initiatives_redistributed++;
      }
      audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'import.gb_form', entity: 'plan', entityId: p.id, after: { file: plan.file, items: items.length } });
    }
    markApplied(db, actor, b);
    return out;
  });
}
