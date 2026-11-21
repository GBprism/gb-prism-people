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
