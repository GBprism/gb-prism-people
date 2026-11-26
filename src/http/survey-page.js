// The client survey page: plain HTML (no script), opened from a private link without signing in.
import { surveyByToken, answerClientSurvey } from '../domain/surveys.js';
import { readBody, SECURITY_HEADERS } from './router.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>GB Advisory – client feedback</title><link rel="stylesheet" href="/survey.css"></head><body><main class="sv"><img src="/brand/gb-logo.png" alt="GB Advisory" class="sv-logo">${body}</main></body></html>`;
const send = (res, status, html) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); res.end(html); };

function form(s, token, error, values = {}) {
  const q = s.questions.map((x) => {
    const min = x.nps ? 0 : 1;
    const opts = Array.from({ length: x.scale - min + 1 }, (_, i) => i + min).map((v) => `<label class="sv-opt"><input type="radio" name="${x.key}" value="${v}"${String(values[x.key]) === String(v) ? ' checked' : ''}><span>${v}</span></label>`).join('');
    const ends = x.nps ? '<span>Not at all likely</span><span>Extremely likely</span>' : '<span>Poor</span><span>Excellent</span>';
    return `<fieldset class="sv-q"><legend>${esc(x.text)}</legend><div class="sv-scale">${opts}</div><div class="sv-ends">${ends}</div></fieldset>`;
  }).join('');
  return page(`<h1>Your feedback on ${esc(s.title.replace(/^Client feedback – /, ''))}</h1>
<p class="sv-lede">${s.contact_name ? `Dear ${esc(s.contact_name)}, thank` : 'Thank'} you for working with GB Advisory. Six quick questions — about two minutes. Your answers go to the GB partners.</p>
${error ? `<p class="sv-error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/survey/${esc(token)}">${q}<label class="sv-q sv-comment"><span>Anything else you would like to tell us?</span><textarea name="comment" rows="4">${esc(values.comment || '')}</textarea></label>
<button type="submit">Send feedback</button></form>`);
}

export async function surveyRoute(db, req, res, url) {
  const token = decodeURIComponent(url.pathname.slice('/survey/'.length));
  const s = surveyByToken(db, token);
  if (!s) return send(res, 404, page('<h1>Link not found</h1><p>Please check the link in your email, or reply to the sender.</p>'));
  if (req.method === 'POST') {
    const values = Object.fromEntries(new URLSearchParams((await readBody(req, 2e4)).toString()));
    try { answerClientSurvey(db, token, values, values.comment); }
    catch (e) { return send(res, 400, s.open ? form(s, token, e.message, values) : page(`<h1>Thank you</h1><p>${esc(e.message)}</p>`)); }
    return send(res, 200, page('<h1>Thank you</h1><p>Your feedback has reached the GB Advisory partners. We appreciate your time.</p>'));
  }
  if (!s.open) return send(res, 200, page(`<h1>Thank you</h1><p>${s.answered ? 'This survey has already been answered.' : 'This survey is closed.'}</p>`));
  return send(res, 200, form(s, token));
}
