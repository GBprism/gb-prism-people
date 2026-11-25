// Google Workspace sign-in (OpenID Connect, authorization-code flow + PKCE).
// Only verified accounts of GOOGLE_ALLOWED_DOMAIN (e.g. gb-advisory.com) that
// already exist on the Prism roster can sign in; nobody is auto-created.
import crypto from 'node:crypto';
import { makeSession, sessionCookie } from './router.js';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

export function googleConfig(env = process.env) {
  const c = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, domain: (env.GOOGLE_ALLOWED_DOMAIN || '').toLowerCase(),
    tenant: env.GOOGLE_TENANT || 'gb-advisory', baseUrl: (env.BASE_URL || '').replace(/\/$/, '') };
  return c.clientId && c.clientSecret && c.domain && c.baseUrl ? c : null;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (v, secret) => crypto.createHmac('sha256', secret).update(v).digest('base64url');

/** Step 1: redirect to Google with state + PKCE kept in a short-lived signed cookie. */
export function start(cfg, res) {
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const payload = b64url(JSON.stringify({ state, verifier, exp: Date.now() + 10 * 60e3 }));
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: `${cfg.baseUrl}/auth/google/callback`, response_type: 'code',
    scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256', hd: cfg.domain, prompt: 'select_account' });
  res.writeHead(302, { Location: `${AUTH}?${q}`, 'Set-Cookie': `prism_oauth=${payload}.${sign(payload, cfg.clientSecret)}; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=600${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
  res.end();
}

/**
 * "Open in Google Slides": ask the signed-in person for access to files this app creates in their own
 * Drive (drive.file — it cannot see anything else), then convert the generated .pptx into a Google
 * Slides file there and open it. Uses the same redirect address as sign-in, so nothing new to register.
 */
export function startSlides(cfg, res, user, target) {
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const payload = b64url(JSON.stringify({ state, verifier, exp: Date.now() + 10 * 60e3, purpose: 'slides', userId: user.id, target }));
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: `${cfg.baseUrl}/auth/google/callback`, response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file', state, code_challenge: challenge, code_challenge_method: 'S256', hd: cfg.domain, login_hint: user.email, include_granted_scopes: 'true' });
  res.writeHead(302, { Location: `${AUTH}?${q}`, 'Set-Cookie': `prism_oauth=${payload}.${sign(payload, cfg.clientSecret)}; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=600${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
  res.end();
}

/** Upload a .pptx to the person's Drive as a Google Slides file; returns its id. */
export async function uploadAsSlides(accessToken, { name, buffer }, fetchImpl = fetch) {
  const boundary = `prism${crypto.randomBytes(8).toString('hex')}`;
  const meta = JSON.stringify({ name, mimeType: 'application/vnd.google-apps.presentation' });
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation\r\n\r\n`), buffer, Buffer.from(`\r\n--${boundary}--`)]);
  const r = await fetchImpl('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  if (!r.ok) { const why = await r.json().catch(() => ({})); const e = new Error(why.error?.message || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return (await r.json()).id;
}

/** Step 2: verify state, exchange the code, check the account, start a Prism session. */
export async function callback(cfg, db, req, res, url, fetchImpl = fetch) {
  const fail = (status, msg) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'prism_oauth=; Max-Age=0; Path=/auth/google' }); res.end(`<!doctype html><meta charset="utf-8"><title>Sign-in</title><p>${msg}</p><p><a href="/">Back</a></p>`); };
  const cookie = Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)])).prism_oauth;
  if (!cookie) return fail(400, 'Sign-in expired. Please try again.');
  const [p, s] = cookie.split('.');
  if (!p || !s || sign(p, cfg.clientSecret) !== s) return fail(400, 'Sign-in could not be verified.');
  const st = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (st.exp < Date.now() || st.state !== url.searchParams.get('state')) return fail(400, 'Sign-in expired. Please try again.');
  const code = url.searchParams.get('code');
  if (!code) return fail(400, 'Google did not return a sign-in code.');
  const tok = await fetchImpl(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: `${cfg.baseUrl}/auth/google/callback`, grant_type: 'authorization_code', code_verifier: st.verifier }) });
  if (!tok.ok) {
    // log Google's reason (never the code or secret) so the cause is visible in the server log
    const why = await tok.json().catch(() => ({}));
    console.error(`Google token exchange failed: HTTP ${tok.status} ${why.error || ''} ${why.error_description || ''}`.trim());
    return fail(401, why.error === 'invalid_client' ? 'Google sign-in failed: the server has the wrong client ID or secret. Ask the administrator to re-enter them.'
      : why.error === 'redirect_uri_mismatch' ? 'Google sign-in failed: the redirect address is not registered in Google Cloud.' : 'Google sign-in failed.');
  }
  const { access_token: at } = await tok.json();
  if (st.purpose === 'slides') return slides(cfg, db, req, res, st, at, fail, fetchImpl);
  const ui = await fetchImpl(USERINFO, { headers: { Authorization: `Bearer ${at}` } });
  if (!ui.ok) { console.error(`Google userinfo failed: HTTP ${ui.status}`); return fail(401, 'Google sign-in failed.'); }
  const info = await ui.json();
  const email = String(info.email || '').toLowerCase();
  if (!info.email_verified || String(info.hd || '').toLowerCase() !== cfg.domain || !email.endsWith(`@${cfg.domain}`)) return fail(403, `Please sign in with your @${cfg.domain} Google account.`);
  const u = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND lower(email) = ? AND active = 1').get(cfg.tenant, email);
  if (!u) return fail(403, 'Your account is not set up in People & Performance yet. Please contact People Ops.');
  res.writeHead(302, { Location: '/', 'Set-Cookie': [sessionCookie(makeSession(u.id)), 'prism_oauth=; Max-Age=0; Path=/auth/google'] });
  res.end();
}

async function slides(cfg, db, req, res, st, at, fail, fetchImpl) {
  const { readSession } = await import('./router.js');
  const { loadActor } = await import('../domain/authz.js');
  const { cvDeck } = await import('../domain/cv.js');
  if (readSession(req) !== st.userId) return fail(403, 'Please sign in to People & Performance again, then retry.');
  const actor = loadActor(db, st.userId); if (!actor) return fail(403, 'Your account is not active.');
  try {
    const d = await cvDeck(db, actor, st.target === 'all' ? null : st.target);
    const id = await uploadAsSlides(at, { name: d.filename.replace(/\.pptx$/, '').replace(/_/g, ' '), buffer: d.buffer }, fetchImpl);
    res.writeHead(302, { Location: `https://docs.google.com/presentation/d/${id}/edit`, 'Set-Cookie': 'prism_oauth=; Max-Age=0; Path=/auth/google' });
    return res.end();
  } catch (e) {
    console.error(`Google Slides export failed: ${e.message}`);
    return fail(502, /has not been used|disabled|not been enabled/i.test(e.message) ? 'Google Drive is not switched on for this app yet. Ask the administrator to enable the Google Drive API in Google Cloud.' : 'Could not create the Google Slides file. Please try again.');
  }
}
