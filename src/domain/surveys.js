// Surveys that feed GB's strategy KPIs.
// * Client survey: sent after an engagement as a private link (no sign-in). One response per link.
//   Feeds the quality index (deliverable quality) and the customer experience index (satisfaction, NPS).
// * Team pulse: quarterly, anonymous. Who answered is stored apart from what they answered, and results
//   show only once at least three people have answered. Feeds the employee experience index (eNPS).
import crypto from 'node:crypto';
import { tx, uid, now, audit, bad, forbid, notFound } from '../db.js';
import { isOps, has } from './authz.js';

export const MIN_ANONYMOUS = 3;
export const CLIENT_QUESTIONS = [
  { key: 'overall', text: 'Overall, how satisfied are you with GB Advisory’s work on this engagement?', scale: 5 },
  { key: 'quality', text: 'How would you rate the quality of the deliverables?', scale: 5 },
  { key: 'understanding', text: 'How well did the team understand your organisation and needs?', scale: 5 },
  { key: 'timeliness', text: 'How well did the team keep to the agreed timeline?', scale: 5 },
  { key: 'team', text: 'How would you rate the team’s professionalism and communication?', scale: 5 },
  { key: 'nps', text: 'How likely are you to recommend GB Advisory to a colleague?', scale: 10, nps: true },
];
export const PULSE_QUESTIONS = [
  { key: 'enps', text: 'How likely are you to recommend GB Advisory as a place to work?', scale: 10, nps: true },
  { key: 'support', text: 'I have the support and tools I need to do quality work.', scale: 5 },
  { key: 'workload', text: 'My workload is manageable.', scale: 5 },
  { key: 'growth', text: 'I am learning and growing at GB.', scale: 5 },
  { key: 'recognition', text: 'I feel recognised for my work.', scale: 5 },
  { key: 'strategy', text: 'I understand GB’s strategy and how my work contributes to it.', scale: 5 },
];
const editor = (a) => isOps(a) || has(a, 'partner');
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const questions = (kind) => (kind === 'client' ? CLIENT_QUESTIONS : PULSE_QUESTIONS);

/** A partner, People Ops or the project lead creates a client survey link for an engagement. */
export function createClientSurvey(db, actor, { project_id, engagement_id, contact_name, contact_email, closes_on } = {}) {
  const proj = project_id ? db.prepare('SELECT * FROM projects WHERE id = ? AND tenant_id = ?').get(project_id, actor.tenantId) : null;
  if (project_id && !proj) throw bad('Unknown project');
  const eng = engagement_id ? db.prepare('SELECT * FROM engagements WHERE id = ? AND tenant_id = ?').get(engagement_id, actor.tenantId) : null;
  if (!proj && !eng) throw bad('Choose the engagement the survey is about');
  if (!editor(actor) && proj?.lead_user_id !== actor.id) throw forbid();
  const email = String(contact_email || '').trim(); if (email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) throw bad('Check the email address');
  const token = crypto.randomBytes(24).toString('base64url');
  const id = uid('srv_');
  const title = `Client feedback – ${proj?.name || eng.title_en}`;
  db.prepare(`INSERT INTO surveys (id, tenant_id, kind, title, project_id, engagement_id, contact_name, contact_email, token_hash, opens_on, closes_on, created_by, created_at)
      VALUES (?,?, 'client', ?,?,?,?,?,?,?,?,?,?)`).run(id, actor.tenantId, title, proj?.id || eng?.project_id || null, eng?.id || null, String(contact_name || '').slice(0, 120) || null, email || null,
    hash(token), new Date().toISOString().slice(0, 10), closes_on || new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), actor.id, now());
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'survey.client_create', entity: 'survey', entityId: id });
  return { id, token, title };
}

/** Public: look up an open client survey by its link token (no sign-in). */
export function surveyByToken(db, token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token || '')) return null;
  const s = db.prepare("SELECT s.*, t.name tenant FROM surveys s JOIN tenants t ON t.id = s.tenant_id WHERE s.token_hash = ? AND s.kind = 'client'").get(hash(token));
  if (!s) return null;
  const done = db.prepare('SELECT 1 FROM survey_responses WHERE survey_id = ?').get(s.id);
  const expired = s.closes_on && s.closes_on < new Date().toISOString().slice(0, 10);
  return { ...s, answered: !!done, open: s.status === 'open' && !done && !expired, questions: CLIENT_QUESTIONS };
}

function clean(kind, answers = {}) {
  const out = {};
  for (const q of questions(kind)) {
    const v = answers[q.key]; if (v === '' || v == null) continue;
    const n = Number(v); const min = q.nps ? 0 : 1;
    if (!Number.isInteger(n) || n < min || n > q.scale) throw bad('Please choose a value for each question you answer');
    out[q.key] = n;
  }
  if (!Object.keys(out).length) throw bad('Please answer at least one question');
  return out;
}

export function answerClientSurvey(db, token, answers, comment) {
  const s = surveyByToken(db, token); if (!s) throw notFound();
  if (!s.open) throw bad(s.answered ? 'Thank you — this survey has already been answered.' : 'This survey is closed.');
  const a = clean('client', answers);
  tx(db, () => {
    db.prepare('INSERT INTO survey_responses (id, survey_id, answers_json, comment, created_at) VALUES (?,?,?,?,?)').run(uid('sr_'), s.id, JSON.stringify(a), String(comment || '').slice(0, 3000) || null, now());
    db.prepare("UPDATE surveys SET status = 'closed' WHERE id = ?").run(s.id);
  });
  return { ok: true };
}

/** Partners / People Ops open a quarterly team pulse. */
export function openPulse(db, actor, { title, closes_on } = {}) {
  if (!editor(actor)) throw forbid();
  const t = String(title || '').trim().slice(0, 80) || `Team pulse ${new Date().getFullYear()} Q${Math.floor(new Date().getMonth() / 3) + 1}`;
  if (closes_on && !/^\d{4}-\d{2}-\d{2}$/.test(closes_on)) throw bad('Closing date: use yyyy-mm-dd');
  const id = uid('srv_');
  db.prepare("INSERT INTO surveys (id, tenant_id, kind, title, opens_on, closes_on, created_by, created_at) VALUES (?,?, 'pulse', ?,?,?,?,?)")
    .run(id, actor.tenantId, t, new Date().toISOString().slice(0, 10), closes_on || new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10), actor.id, now());
  audit(db, { tenantId: actor.tenantId, actorId: actor.id, action: 'survey.pulse_open', entity: 'survey', entityId: id });
  return { id };
}

export function answerPulse(db, actor, surveyId, answers, comment) {
  const s = db.prepare("SELECT * FROM surveys WHERE id = ? AND tenant_id = ? AND kind = 'pulse'").get(surveyId, actor.tenantId); if (!s) throw notFound();
  if (s.status !== 'open' || (s.closes_on && s.closes_on < new Date().toISOString().slice(0, 10))) throw bad('This pulse is closed');
  if (db.prepare('SELECT 1 FROM survey_participation WHERE survey_id = ? AND user_id = ?').get(surveyId, actor.id)) throw bad('You have already answered — thank you');
  const a = clean('pulse', answers);
  tx(db, () => {
    // participation and answers are stored separately and are not linked, so answers stay anonymous
    db.prepare('INSERT INTO survey_participation (survey_id, user_id, answered_at) VALUES (?,?,?)').run(surveyId, actor.id, new Date().toISOString().slice(0, 10));
    db.prepare('INSERT INTO survey_responses (id, survey_id, answers_json, comment, created_at) VALUES (?,?,?,?,?)').run(uid('sr_'), surveyId, JSON.stringify(a), String(comment || '').slice(0, 3000) || null, new Date().toISOString().slice(0, 10));
  });
  return { ok: true };
}

export function closeSurvey(db, actor, id) {
  if (!editor(actor)) throw forbid();
  const r = db.prepare("UPDATE surveys SET status = 'closed' WHERE id = ? AND tenant_id = ?").run(id, actor.tenantId); if (!r.changes) throw notFound();
  return { ok: true };
}

function score(kind, responses) {
  const qs = questions(kind); const out = {};
  for (const q of qs) {
    const vals = responses.map((r) => r[q.key]).filter((v) => v != null);
    if (!vals.length) { out[q.key] = null; continue; }
    if (q.nps) { const pro = vals.filter((v) => v >= 9).length; const det = vals.filter((v) => v <= 6).length; out[q.key] = { nps: Math.round(((pro - det) / vals.length) * 100), n: vals.length }; }
    else out[q.key] = { avg: Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10, n: vals.length };
  }
  return out;
}

export function surveysView(db, actor) {
  const T = actor.tenantId;
  const pulses = db.prepare("SELECT * FROM surveys WHERE tenant_id = ? AND kind = 'pulse' ORDER BY created_at DESC").all(T).map((s) => {
    const resp = db.prepare('SELECT answers_json, comment FROM survey_responses WHERE survey_id = ?').all(s.id);
    const enough = resp.length >= MIN_ANONYMOUS;
    const open = s.status === 'open' && (!s.closes_on || s.closes_on >= new Date().toISOString().slice(0, 10));
    return { id: s.id, title: s.title, opens_on: s.opens_on, closes_on: s.closes_on, open, responses: resp.length, answered: !!db.prepare('SELECT 1 FROM survey_participation WHERE survey_id = ? AND user_id = ?').get(s.id, actor.id),
      results: editor(actor) && enough ? score('pulse', resp.map((r) => JSON.parse(r.answers_json))) : null, comments: editor(actor) && enough ? resp.map((r) => r.comment).filter(Boolean).sort(() => Math.random() - 0.5) : null, // shuffled: order never hints at who wrote what
      hidden_reason: editor(actor) && !enough ? `Results appear once ${MIN_ANONYMOUS} people have answered` : null };
  });
  const clients = editor(actor) || db.prepare('SELECT 1 FROM projects WHERE lead_user_id = ?').get(actor.id)
    ? db.prepare(`SELECT s.*, p.name project, u.name created_by_name FROM surveys s LEFT JOIN projects p ON p.id = s.project_id LEFT JOIN users u ON u.id = s.created_by
        WHERE s.tenant_id = ? AND s.kind = 'client' ${editor(actor) ? '' : 'AND p.lead_user_id = ?'} ORDER BY s.created_at DESC`).all(...(editor(actor) ? [T] : [T, actor.id])).map((s) => {
        const r = db.prepare('SELECT answers_json, comment, created_at FROM survey_responses WHERE survey_id = ?').get(s.id);
        return { id: s.id, title: s.title, project: s.project, contact_name: s.contact_name, contact_email: s.contact_email, created_at: s.created_at, closes_on: s.closes_on, status: s.status,
          answered: !!r, answers: r ? JSON.parse(r.answers_json) : null, comment: r?.comment || null, answered_at: r?.created_at || null };
      }) : [];
  return { pulses, clients, canManage: editor(actor), client_questions: CLIENT_QUESTIONS, pulse_questions: PULSE_QUESTIONS, kpis: editor(actor) ? surveyKpis(db, T) : null };
}

/** Strategy KPI values from surveys (12 months for clients; the latest pulse with enough answers). */
export function surveyKpis(db, tenantId) {
  const since = new Date(Date.now() - 365 * 864e5).toISOString();
  const client = db.prepare("SELECT r.answers_json FROM survey_responses r JOIN surveys s ON s.id = r.survey_id WHERE s.tenant_id = ? AND s.kind = 'client' AND r.created_at >= ?").all(tenantId, since).map((r) => JSON.parse(r.answers_json));
  const c = score('client', client);
  let pulse = null;
  for (const s of db.prepare("SELECT id, title FROM surveys WHERE tenant_id = ? AND kind = 'pulse' ORDER BY created_at DESC").all(tenantId)) {
    const resp = db.prepare('SELECT answers_json FROM survey_responses WHERE survey_id = ?').all(s.id).map((r) => JSON.parse(r.answers_json));
    if (resp.length >= MIN_ANONYMOUS) { pulse = { title: s.title, n: resp.length, ...score('pulse', resp) }; break; }
  }
  return { client_responses: client.length, quality: c.quality, overall: c.overall, nps: c.nps, pulse };
}

/** Inbox: an open pulse the person has not answered. */
export function openPulsesFor(db, actor) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(`SELECT s.id, s.title, s.closes_on FROM surveys s WHERE s.tenant_id = ? AND s.kind = 'pulse' AND s.status = 'open' AND (s.closes_on IS NULL OR s.closes_on >= ?)
      AND NOT EXISTS (SELECT 1 FROM survey_participation p WHERE p.survey_id = s.id AND p.user_id = ?)`).all(actor.tenantId, today, actor.id);
}
