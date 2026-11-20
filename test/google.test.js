import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh } from './helpers.js';
import { createServer } from '../src/server.js';

const cfg = { clientId: 'cid', clientSecret: 'secret', domain: 'example.test', tenant: 'gb', baseUrl: 'http://prism.local' };

async function boot(userinfo) {
  const { db } = fresh();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url.includes('oauth2.googleapis.com/token')) {
      const body = new URLSearchParams(opts.body);
      assert.ok(body.get('code_verifier'), 'PKCE verifier sent');
      return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
    }
    return new Response(JSON.stringify(userinfo), { status: 200 });
  };
  const srv = createServer(db, { authMode: 'google', googleCfg: cfg, fetchImpl });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const start = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  const loc = new URL(start.headers.get('location'));
  const cookie = start.headers.get('set-cookie').split(';')[0];
  return { srv, base, loc, cookie, calls };
}

test('Google sign-in: domain-restricted, roster-only, state + PKCE checked', async () => {
  let t = await boot({ email: 'Eli@example.test', email_verified: true, hd: 'example.test' });
  try {
    assert.equal(t.loc.searchParams.get('hd'), 'example.test');
    assert.equal(t.loc.searchParams.get('code_challenge_method'), 'S256');
    const bad = await fetch(`${t.base}/auth/google/callback?code=c&state=wrong`, { headers: { cookie: t.cookie }, redirect: 'manual' });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${t.base}/auth/google/callback?code=c&state=${t.loc.searchParams.get('state')}`, { headers: { cookie: t.cookie }, redirect: 'manual' });
    assert.equal(ok.status, 302);
    const session = ok.headers.getSetCookie().find((c) => c.startsWith('prism_session=')).split(';')[0];
    const me = await (await fetch(`${t.base}/api/me`, { headers: { cookie: session } })).json();
    assert.equal(me.name, 'Eli Employee');
    assert.equal((await fetch(`${t.base}/api/dev/users`, { headers: { cookie: session } })).status, 404); // no dev picker
  } finally { t.srv.close(); }

  t = await boot({ email: 'eli@gmail.com', email_verified: true });
  try {
    const r = await fetch(`${t.base}/auth/google/callback?code=c&state=${t.loc.searchParams.get('state')}`, { headers: { cookie: t.cookie }, redirect: 'manual' });
    assert.equal(r.status, 403); // personal Google account refused
  } finally { t.srv.close(); }

  t = await boot({ email: 'stranger@example.test', email_verified: true, hd: 'example.test' });
  try {
    const r = await fetch(`${t.base}/auth/google/callback?code=c&state=${t.loc.searchParams.get('state')}`, { headers: { cookie: t.cookie }, redirect: 'manual' });
    assert.equal(r.status, 403); // workspace account but not on the roster → not auto-created
  } finally { t.srv.close(); }
});
