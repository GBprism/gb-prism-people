import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN } from './helpers.js';
import * as exp from '../src/domain/expenses.js';
import * as ts from '../src/domain/timesheets.js';
import * as wp from '../src/domain/workplace.js';
import { cvDeck } from '../src/domain/cv.js';
import { applyTitleRenames } from '../src/imports/gbworkbook.js';

const PDF = Buffer.from('%PDF-1.4\n% test receipt\n');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const setting = (db, key, v) => db.prepare('INSERT OR REPLACE INTO settings (tenant_id, key, value_json) VALUES (?,?,?)').run(SYN.tenant, key, JSON.stringify(v));

test('expenses: GB form maths, receipts required, approver decides, People Ops pays', () => {
  const { db, as } = fresh();
  setting(db, 'expense_approver', SYN.partner);
  assert.equal(exp.convert(10000, '0.709'), 7090);
  assert.equal(exp.convert(333, '0.7095'), 236); // 2.3626 → 2.36
  const me = as(SYN.emp);
  const { id } = exp.createClaim(db, me, { title: 'Riyadh workshop' });
  assert.throws(() => exp.submitClaim(db, me, id), /at least one/);
  const { id: line } = exp.saveLine(db, me, id, null, { spent_on: '2026-03-02', category: 'Taxi/Bus/Tube/Tram', description: 'Taxi to client', receipt_amount: '50', receipt_currency: 'SAR', fx_rate: '0.189' });
  assert.equal(exp.claimView(db, me, id).total_x100, 945);
  assert.throws(() => exp.saveLine(db, me, id, null, { spent_on: '2026-03-02', category: 'Taxi/Bus/Tube/Tram', description: 'x', receipt_amount: '5', receipt_currency: 'SAR' }), /Exchange rate/);
  assert.throws(() => exp.saveLine(db, me, id, null, { spent_on: '2026-03-02', category: 'Bribes', description: 'x', receipt_amount: '5', receipt_currency: 'JOD' }), /expense type/);
  assert.throws(() => exp.submitClaim(db, me, id), /receipt or invoice/);
  assert.throws(() => exp.attachReceipt(db, me, id, line, HTML, 'x.html'), /PDF/);
  assert.throws(() => exp.attachReceipt(db, as(SYN.peer), id, line, PDF, 'r.pdf'), /Not permitted/);
  exp.attachReceipt(db, me, id, line, PDF, 'taxi.pdf');
  exp.submitClaim(db, me, id);
  assert.throws(() => exp.saveLine(db, me, id, line, { spent_on: '2026-03-02', category: 'Other', description: 'x', receipt_amount: '1', receipt_currency: 'JOD' }), /no longer a draft/);
  // peers cannot see it; the approver can, and sees the receipt
  assert.throws(() => exp.claimView(db, as(SYN.peer), id), /Not permitted/);
  assert.equal(exp.receipt(db, as(SYN.partner), id, line).contentType, 'application/pdf');
  assert.ok(exp.listClaims(db, as(SYN.partner), { scope: 'approve' }).some((c) => c.id === id));
  assert.throws(() => exp.decideClaim(db, as(SYN.partner), id, { decision: 'reject' }), /what needs to change/);
  exp.decideClaim(db, as(SYN.partner), id, { decision: 'reject', note: 'Add the hotel receipt' });
  assert.equal(exp.claimView(db, me, id).status, 'draft');
  exp.submitClaim(db, me, id);
  assert.throws(() => exp.markPaid(db, as(SYN.ops), id), /Only approved/);
  exp.decideClaim(db, as(SYN.partner), id, { decision: 'approve' });
  assert.throws(() => exp.markPaid(db, as(SYN.partner), id), /Not permitted/);
  exp.markPaid(db, as(SYN.ops), id);
  assert.equal(exp.claimView(db, me, id).status, 'paid');
  // nobody approves their own claim
  const own = exp.createClaim(db, as(SYN.partner), { title: 'Own' });
  exp.saveLine(db, as(SYN.partner), own.id, null, { spent_on: '2026-03-02', category: 'Other', description: 'x', receipt_amount: '1', receipt_currency: 'JOD' });
  const l2 = db.prepare('SELECT id FROM expense_lines WHERE claim_id = ?').get(own.id).id;
  exp.attachReceipt(db, as(SYN.partner), own.id, l2, PDF, 'r.pdf');
  assert.notEqual(exp.submitClaim(db, as(SYN.partner), own.id).approver, SYN.partner);
});

test('timesheets: month drafts itself from assignments minus weekends; owner edits; partners see man-hours', () => {
  const { db, as } = fresh();
  const me = as(SYN.emp);
  const month = db.prepare("SELECT substr(start_date, 1, 7) m FROM project_assignments WHERE user_id = ? AND start_date IS NOT NULL ORDER BY start_date LIMIT 1").get(SYN.emp)?.m || '2026-03';
  const v = ts.monthView(db, me, SYN.emp, month);
  const workdays = v.days.filter((d) => d.capacity_x100).length;
  assert.equal(v.totals.hours_x100, workdays * 800, 'every working day drafted at 8 hours');
  assert.ok(v.days.some((d) => d.weekend && d.capacity_x100 === 0));
  const fri = v.days.find((d) => d.weekday === 5);
  assert.throws(() => ts.saveEntries(db, me, month, [{ date: fri.date, code: 'internal', hours: 25 }]), /between 0 and 24/);
  assert.throws(() => ts.saveEntries(db, me, month, [{ date: `${month}-01`, code: 'holiday-fun', hours: 2 }]), /Unknown time code/);
  const day = v.days.find((d) => d.capacity_x100).date;
  ts.saveEntries(db, me, month, [{ date: day, code: 'proposals', hours: 2 }]);
  // a manual day is kept when the month is redrafted from assignments
  ts.autofill(db, me, month);
  assert.equal(db.prepare("SELECT hours_x100 FROM timesheet_entries WHERE user_id = ? AND work_date = ? AND code = 'proposals'").get(SYN.emp, day).hours_x100, 200);
  // colleagues cannot read it; the line manager and partners can
  assert.throws(() => ts.monthView(db, as(SYN.peer), SYN.emp, month), /Not permitted/);
  ts.monthView(db, as(SYN.partner), SYN.emp, month);
  ts.submitMonth(db, me, month);
  assert.throws(() => ts.saveEntries(db, me, month, [{ date: day, code: 'internal', hours: 1 }]), /already submitted/);
  assert.throws(() => ts.decideMonth(db, me, SYN.emp, month, { decision: 'approve' }), /Not permitted/);
  ts.decideMonth(db, as(SYN.partner), SYN.emp, month, { decision: 'approve' });
  const r = ts.monthReport(db, as(SYN.partner), month);
  assert.equal(r.projects.reduce((s, p) => s + p.hours_x100, 0), workdays * 800 - (db.prepare("SELECT 1 FROM timesheet_entries WHERE work_date = ? AND user_id = ? AND source = 'auto'").get(day, SYN.emp) ? 0 : 600));
  assert.throws(() => ts.monthReport(db, as(SYN.peer), month), /Not permitted/);
});

test('letters, checklists, policies, onboarding: permissions and no pay stored', () => {
  const { db, as } = fresh();
  wp.applyWorkplace(db, as(SYN.ops), {
    letters: [{ key: 'experience_letter', title: 'Experience Letter', fields: ['today', 'employee_name', 'join_date', 'salary'], body: 'Dear {{addressee}}, {{employee_name}} … {{salary}}', has_compensation: true }],
    checklists: { general: [{ key: 'brand', title: 'Branding', items: ['Footer date', 'No other client names'] }], specific: [{ key: 'pp', deliverable_type: 'P&P manual', title: 'P&P', items: ['Numbered policies'] }] },
    policies: [{ key: 'claude', category: 'AI', title: 'Claude usage', version: '1', rules: ['Use Sonnet first'] }],
    onboarding: [{ key: 'nda', title: 'NDA', stage: 'day1', owner: 'new_joiner', action: 'sign' }, { key: 'contract', title: 'Contract', stage: 'day1', owner: 'hr', action: 'sign' }],
  });
  // letters
  const { id } = wp.requestLetter(db, as(SYN.emp), { kind: 'experience_letter', purpose: 'Visa' });
  assert.throws(() => wp.letterDraft(db, as(SYN.emp), id), /Not permitted/);
  const d = wp.letterDraft(db, as(SYN.ops), id);
  assert.ok(d.known.employee_name);
  wp.decideLetter(db, as(SYN.ops), id, { decision: 'issue', fields: { employee_name: 'X', salary: '1,234 JOD' } });
  assert.ok(!db.prepare('SELECT issued_fields_json FROM letter_requests WHERE id = ?').get(id).issued_fields_json.includes('1,234'), 'pay is never saved');
  // checklists: every item must be ticked before a deliverable is submitted
  const dlv = db.prepare("SELECT d.id FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE p.lead_user_id = ? LIMIT 1").get(SYN.lead)
    || { id: (() => { const pid = db.prepare('SELECT id FROM projects WHERE lead_user_id = ? LIMIT 1').get(SYN.lead).id; db.prepare("INSERT INTO deliverables (id, tenant_id, project_id, title) VALUES ('dlv_t', ?, ?, 'Manual')").run(SYN.tenant, pid); return 'dlv_t'; })() };
  assert.throws(() => wp.submitDeliverable(db, as(SYN.unrelated), dlv.id, {}), /Not permitted/);
  assert.throws(() => wp.submitDeliverable(db, as(SYN.lead), dlv.id, { deliverableType: 'P&P manual', checked: { 'brand:0': true, 'brand:1': true } }), /1 left/);
  wp.submitDeliverable(db, as(SYN.lead), dlv.id, { deliverableType: 'P&P manual', checked: { 'brand:0': true, 'brand:1': true, 'pp:0': true } });
  assert.equal(db.prepare('SELECT status FROM deliverables WHERE id = ?').get(dlv.id).status, 'submitted');
  // policies
  assert.equal(wp.policiesView(db, as(SYN.emp))[0].acked, false);
  wp.ackPolicy(db, as(SYN.emp), 'claude');
  assert.equal(wp.policiesView(db, as(SYN.emp))[0].acked, true);
  assert.throws(() => wp.policyAckReport(db, as(SYN.emp), 'claude'), /Not permitted/);
  // onboarding: the joiner ticks their own steps, not HR's
  const items = wp.onboardingView(db, as(SYN.newbie)).items;
  wp.setOnboardingDone(db, as(SYN.newbie), SYN.newbie, items.find((i) => i.key === 'nda').id, true);
  assert.throws(() => wp.setOnboardingDone(db, as(SYN.newbie), SYN.newbie, items.find((i) => i.key === 'contract').id, true), /Not permitted/);
  assert.throws(() => wp.onboardingView(db, as(SYN.peer), SYN.newbie), /Not permitted/);
  // CV updates go through People Ops
  wp.proposeCvUpdate(db, as(SYN.emp), { bio: 'New summary', date_of_birth: '2000-01-01' });
  const u = wp.cvUpdates(db, as(SYN.ops)).find((x) => x.user_id === SYN.emp);
  assert.deepEqual(Object.keys(u.fields), ['bio'], 'only CV facts can be proposed');
  assert.throws(() => wp.decideCvUpdate(db, as(SYN.emp), u.id, { decision: 'apply' }), /Not permitted/);
  wp.decideCvUpdate(db, as(SYN.ops), u.id, { decision: 'apply' });
  assert.equal(db.prepare('SELECT bio FROM employee_profiles WHERE user_id = ?').get(SYN.emp).bio, 'New summary');
});

test('job title rename and CV slide export', async () => {
  const { db, as } = fresh();
  db.prepare("UPDATE employments SET title = 'Business Analyst (Grade 1)' WHERE user_id = ? AND effective_to IS NULL").run(SYN.emp);
  const out = applyTitleRenames(db, as(SYN.ops), { 'Business Analyst (Grade 1)': 'Consultant' });
  assert.ok(out.some((l) => /Consultant/.test(l)));
  assert.equal(db.prepare('SELECT title FROM employments WHERE user_id = ? AND effective_to IS NULL').get(SYN.emp).title, 'Consultant');
  const d = await cvDeck(db, as(SYN.peer), SYN.emp);
  assert.equal(d.buffer.subarray(0, 2).toString(), 'PK', 'a .pptx (zip) file');
  assert.match(d.filename, /^CV_.+\.pptx$/);
});
