import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN, xlsx } from './helpers.js';
import { getProfile, updateProfile, listProfiles } from '../src/domain/profiles.js';
import { parseGbWorkbook, applyGbWorkbook, applyHrEvidence, nameMatcher, parseWhen } from '../src/imports/gbworkbook.js';
import { planView, decideReviewerNote } from '../src/domain/performance.js';

test('HR profile: only the person, People Ops and partners can see it; only Ops/partners edit', () => {
  const { db, as } = fresh();
  updateProfile(db, as(SYN.ops), SYN.emp, { medical_insurance_status: 'Not on file', date_of_birth: '2000-05-01', gaps: 'DOB; insurance' }, { source: 'test' });
  assert.equal(getProfile(db, as(SYN.emp), SYN.emp).medical_insurance_status, 'Not on file');
  assert.deepEqual(getProfile(db, as(SYN.partner), SYN.emp).gaps_list, ['DOB', 'insurance']);
  assert.ok(getProfile(db, as(SYN.emp), SYN.emp).age >= 25);
  // manager, project lead, peer and another tenant's admin are refused
  for (const who of [SYN.manager, SYN.lead, SYN.peer, SYN.am]) assert.throws(() => getProfile(db, as(who), SYN.emp), /Not permitted/);
  assert.throws(() => getProfile(db, as(SYN.otherUser), SYN.emp), /not found/i);
  assert.throws(() => updateProfile(db, as(SYN.emp), SYN.emp, { gaps: '' }), /Not permitted/);
  assert.throws(() => listProfiles(db, as(SYN.manager)), /Not permitted/);
  assert.ok(listProfiles(db, as(SYN.partner)).some((r) => r.id === SYN.emp));
  assert.throws(() => updateProfile(db, as(SYN.ops), SYN.emp, { date_of_birth: '01/05/2000' }), /yyyy-mm-dd/);
  // audit keeps field names, never the values
  const a = db.prepare("SELECT after_json FROM audit_events WHERE action = 'profile.update' ORDER BY id DESC LIMIT 1").get();
  assert.ok(!a.after_json.includes('2000-05-01') && a.after_json.includes('date_of_birth'));
});

test('GB workbook helpers: name variants and month spans', () => {
  const m = nameMatcher([{ id: 'g', name: 'Ghaith Battikhi' }, { id: 'a1', name: 'Abdullah Abu-Alhija' }, { id: 'a2', name: 'Abdullah Qasem' }, { id: 't', name: 'Tamer Albitar' }]);
  assert.equal(m('Ghaith Al Battikhi')?.id, 'g');
  assert.equal(m('Ghaith / Layan (direct)'.split('/')[0])?.id, 'g');
  assert.equal(m('Abdullah Abu-AlHija')?.id, 'a1');
  assert.equal(m('Abdullah Qasem')?.id, 'a2');
  assert.equal(m('Abdullah'), null); // ambiguous
  assert.equal(m('Tamer AlBeitar')?.id, 't');
  assert.equal(m('Not identified'), null);
  assert.deepEqual(parseWhen('Jan–Feb'), { start: '2026-01-01', end: '2026-02-28' });
  assert.deepEqual(parseWhen('H1'), { start: '2026-01-01', end: '2026-06-30' });
  assert.deepEqual(parseWhen('Sep onward'), { start: '2026-09-01', end: null });
});

test('GB workbook: profiles, reviewer matrix and project log load idempotently; ratings untouched', async () => {
  const { db, as } = fresh();
  const plan = db.prepare("SELECT p.* FROM plans p JOIN cycles c ON c.id = p.cycle_id WHERE p.user_id = ? AND c.year = 2026").get(SYN.emp);
  const buf = await xlsx({
    'Employee Profiles': [
      ['Employee', 'Level (2026)', 'Joining date', 'Years with GB', 'Age (Dec 2025)', 'Date of birth', 'Probation ended', 'Post-probation contract', 'Social security', 'Medical insurance (opt-in, 50% co.)', 'Gym stipend (35 JOD/mo)', '2026 projects – role / involvement', '2026 proposals worked on', 'Gaps / to confirm'],
      ['Eli Employee', 'Business Analyst (Grade 1)', new Date('2025-10-14T00:00:00Z'), { formula: 'ROUND(1,1)', result: 1.1 }, 22, 'Not on file', '2026-01-18 (her email)', 'Not verified', 'Policy: yes – confirm', 'Not on file', 'Eligible', 'Alpha – Contributor', 'Beta proposal (owner)', 'DOB; insurance'],
      ['Gone Person', 'Senior Consultant', new Date('2024-01-01T00:00:00Z'), 2, 28, 'Not on file', 'Yes', '', '', '', '', '', '', ''],
    ],
    'Reviewer Matrix': [
      ['2026 PMS – Reviewer assignment per consultant'], [],
      ['Consultant', 'Competencies reviewer', 'Technical reviewer', 'Primary senior (project feedback)', 'Secondary senior (project feedback)', 'Projects behind the choice', 'Status'],
      ['Eli Employee', 'Maya Manager', 'Pat Partner', 'Sara Senior', 'Adam Assistant', 'Alpha with Sara; Gamma with Adam', 'Draft – confirm'],
      [], ['Senior Consultants – reviewed by an Assistant Manager'],
      ['Senior Consultant', 'Competencies reviewer', 'Technical reviewer', 'Assistant Manager reviewer', 'Backup / second input', 'Projects behind the choice', 'Status'],
      ['Gone Person', 'Maya Manager', 'Pat Partner', 'Adam Assistant', '—', 'Left', 'Change reviewer'],
    ],
    '2026 Project Log': [
      ['Consultant', 'Project / client', 'Work', 'When (2026)', 'Senior on the project', 'Evidence', 'Confidence'],
      ['Eli Employee', 'Alpha', 'Assessment report', 'Jan–Feb', 'Sara Senior', 'Task sheet', 'Confirmed'],
      ['Eli Employee', 'Gamma', 'Proposal drafting', 'Sep', 'Adam Assistant', 'Email', 'Inferred'],
      ['Gone Person', 'Delta', 'Processes', 'Jan', 'Sara Senior', 'Task sheet', 'Partial'],
    ],
  });
  const parsed = await parseGbWorkbook(buf);
  assert.equal(parsed.matrix.length, 2);
  const before = JSON.stringify(db.prepare('SELECT self_rating, manager_rating, calibrated_rating FROM plan_items WHERE plan_id = ?').all(plan.id));
  const dry = applyGbWorkbook(db, as(SYN.ops), parsed, { dry: true });
  assert.ok(dry.dry);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM employee_profiles').get().n, 0);

  for (let i = 0; i < 2; i++) applyGbWorkbook(db, as(SYN.ops), parsed, {});
  const p = getProfile(db, as(SYN.emp), SYN.emp);
  assert.equal(p.level, 'Business Analyst (Grade 1)');
  assert.equal(p.title, 'Business Analyst (Grade 1)');
  assert.equal(p.hire_date, '2025-10-14');
  assert.equal(p.probation_end, '2026-01-18');
  assert.equal(p.age_recorded, 22); assert.equal(p.age_recorded_on, '2025-12-01');
  assert.equal(p.age, null); // no date of birth on file
  // project register: candidate projects, assignments are leads for the project lead to confirm
  const asg = db.prepare('SELECT pa.status, p.name, p.kind, p.register_status FROM project_assignments pa JOIN projects p ON p.id = pa.project_id WHERE pa.user_id = ? AND pa.source LIKE ? ORDER BY p.name').all(SYN.emp, '2026 PMS%');
  assert.deepEqual(asg.map((a) => [a.name, a.kind, a.status, a.register_status]), [['Alpha', 'engagement', 'tentative', 'candidate'], ['Gamma – Proposal drafting', 'proposal', 'provisional', 'candidate']]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM projects WHERE name = 'Delta'").get().n, 0); // only people on the roster
  // reviewers: competencies reviewer leads, technical reviewer rates objectives, seniors give input
  const v = planView(db, as(SYN.partner), plan.id);
  assert.equal(v.reviewer.name, 'Maya Manager');
  assert.deepEqual(v.category_reviewers.map((r) => [r.category, r.name]), [['objective', 'Pat Partner']]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_input_invites WHERE plan_id = ?').get(plan.id).n, 2);
  assert.equal(v.reviewer_note.status, 'draft');
  assert.match(v.reviewer_note.rationale, /Alpha with Sara/);
  // the employee does not see the reviewer rationale
  assert.equal(planView(db, as(SYN.emp), plan.id).reviewer_note, undefined);
  assert.throws(() => decideReviewerNote(db, as(SYN.manager), plan.id, { decision: 'confirm' }), /Not permitted/);
  decideReviewerNote(db, as(SYN.partner), plan.id, { decision: 'confirm' });
  applyGbWorkbook(db, as(SYN.ops), parsed, {}); // a re-load keeps the partner's confirmation
  assert.equal(planView(db, as(SYN.partner), plan.id).reviewer_note.status, 'confirmed');
  assert.equal(JSON.stringify(db.prepare('SELECT self_rating, manager_rating, calibrated_rating FROM plan_items WHERE plan_id = ?').all(plan.id)), before);
});

test('HTTP: profile endpoints enforce the same visibility', async () => {
  const { createServer } = await import('../src/server.js');
  const { db } = fresh();
  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = async (userId) => {
    const r = await fetch(`${base}/api/dev/login`, { method: 'POST', headers: { 'X-Requested-With': 'prism', 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return (path, opts = {}) => fetch(base + path, { ...opts, headers: { cookie, 'X-Requested-With': 'prism', 'Content-Type': 'application/json' } });
  };
  try {
    const emp = await login(SYN.emp); const mgr = await login(SYN.manager); const ops = await login(SYN.ops);
    assert.equal((await emp('/api/profile')).status, 200);
    assert.equal((await emp(`/api/profiles/${SYN.peer}`)).status, 403);
    assert.equal((await mgr(`/api/profiles/${SYN.emp}`)).status, 403);
    assert.equal((await mgr('/api/profiles')).status, 403);
    assert.equal((await emp(`/api/profiles/${SYN.emp}`, { method: 'PATCH', body: JSON.stringify({ gaps: 'x' }) })).status, 403);
    const r = await ops(`/api/profiles/${SYN.emp}`, { method: 'PATCH', body: JSON.stringify({ gym_stipend_status: 'Eligible' }) });
    assert.equal(r.status, 200);
    assert.equal((await (await emp('/api/profile')).json()).gym_stipend_status, 'Eligible');
    assert.equal((await (await mgr('/api/me')).json()).nav.people, false);
    assert.equal((await (await ops('/api/me')).json()).nav.people, true);
  } finally { srv.close(); }
});

test('HR evidence from email fills profile fields, clears matching gaps, ignores other keys', () => {
  const { db, as } = fresh();
  updateProfile(db, as(SYN.ops), SYN.emp, { gaps: 'DOB; insurance enrollment; confirm gym claims' });
  const r = applyHrEvidence(db, as(SYN.ops), { people: [
    { name: 'Eli Employee', date_of_birth: '2001-03-04', medical_insurance_status: 'Enrolled – insurer list', probation_end: '2026-01-19', salary: 999, remove_gaps: ['DOB', 'insurance'] },
    { name: 'Nobody Here', date_of_birth: '1990-01-01' } ] });
  assert.equal(r.skipped.length, 1);
  const p = getProfile(db, as(SYN.ops), SYN.emp);
  assert.equal(p.date_of_birth, '2001-03-04'); assert.equal(p.probation_end, '2026-01-19');
  assert.deepEqual(p.gaps_list, ['confirm gym claims']);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM employee_profiles').all()).includes('999'));
});
