import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN } from './helpers.js';
import * as hr from '../src/domain/hrrecords.js';

const adminOf = (db) => { db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'admin')").run(SYN.ops); };

test('employee records: admin only, encrypted at rest, prefilled from GB records, audited', () => {
  const { db, as } = fresh(); adminOf(db);
  const A = as(SYN.ops);
  for (const who of [SYN.partner, SYN.manager, SYN.emp]) assert.throws(() => hr.listRecords(db, as(who)), /admin only/);
  assert.equal(hr.prefillAll(db, A).created, db.prepare('SELECT COUNT(*) n FROM users WHERE tenant_id = ? AND active = 1').get(SYN.tenant).n);
  const r = hr.getRecord(db, A, SYN.emp);
  assert.match(r.data.employee_code, /^GB-\d{3}$/);
  assert.equal(r.data.title_en, 'Consultant'); assert.equal(r.data.title_ar, 'مستشار'); assert.equal(r.data.department_ar, 'الاستشارات');
  assert.ok(['A', 'B', 'C'].includes(r.data.grade)); assert.match(r.sources.grade, /Proposed/);
  assert.equal(r.manager.name, 'Maya Manager');
  hr.saveRecord(db, A, SYN.emp, { basic_salary: '900', mobile_allowance: '20', transport_allowance: 50, iban: 'jo94 cbjo 0010 0000 0000 0131 0003 02', national_number: '9981234567' });
  assert.equal(hr.getRecord(db, A, SYN.emp).gross_salary, 970);
  const raw = db.prepare('SELECT data_enc FROM hr_records WHERE user_id = ?').get(SYN.emp).data_enc;
  assert.ok(!raw.includes('9981234567') && !raw.includes('900') && !raw.includes('JO94'), 'values are not readable in the database');
  assert.throws(() => hr.saveRecord(db, A, SYN.emp, { iban: '12345' }), /IBAN/);
  assert.throws(() => hr.saveRecord(db, A, SYN.emp, { grade: 'D' }), /choose one of A, B, C/);
  // audit says which fields, never the values
  const ev = db.prepare("SELECT after_json FROM audit_events WHERE action = 'hr.update' ORDER BY rowid DESC LIMIT 1").get().after_json;
  assert.match(ev, /basic_salary/); assert.ok(!ev.includes('900'));
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action = 'hr.view'").get());
  assert.equal(hr.proposeGrade('2020-01-01', '2026-11-27'), 'C'); assert.equal(hr.proposeGrade('2025-06-01', '2026-11-27'), 'A');
});

test('employee records: employees are asked, see only their own personal fields, the admin applies', () => {
  const { db, as } = fresh(); adminOf(db);
  const A = as(SYN.ops); const E = as(SYN.emp);
  hr.prefillAll(db, A);
  hr.saveRecord(db, A, SYN.emp, { basic_salary: 900 });
  assert.equal(hr.requestData(db, A, { userIds: [SYN.emp] }).asked, 1);
  assert.ok(hr.hrInboxItems(db, E).some((i) => i.link === '#/my-record'));
  const mine = hr.myRecord(db, E);
  assert.ok(!('basic_salary' in mine.values) && !('grade' in mine.values), 'pay and grade are never shown to the employee');
  assert.throws(() => hr.submitMyRecord(db, E, { basic_salary: 5000 }), /filled by the admin/);
  hr.submitMyRecord(db, E, { name_ar: 'إيلي', mobile: '+962 79 123 4567', iban: 'JO94CBJO0010000000000131000302', marital_status: 'Single' });
  assert.ok(hr.hrInboxItems(db, A).some((i) => i.type === 'hr_review'));
  const rec = hr.getRecord(db, A, SYN.emp);
  assert.equal(rec.submitted.data.name_ar, 'إيلي'); assert.equal(rec.data.name_ar, undefined, 'not applied until the admin applies');
  assert.throws(() => hr.decideSubmission(db, A, rec.submitted.id, { decision: 'return' }), /what needs correcting/);
  hr.decideSubmission(db, A, rec.submitted.id, { decision: 'apply' });
  const after = hr.getRecord(db, A, SYN.emp);
  assert.equal(after.data.name_ar, 'إيلي'); assert.equal(after.data.basic_salary, 900); assert.match(after.sources.mobile, /Employee/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_outbox WHERE event = ?').get('hr.request').n, 1);
});
