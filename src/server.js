// HTTP entry point.
// Auth modes (AUTH_MODE):
//   dev            – DEV_LOGIN=1 enables a synthetic-account picker (never in production)
//   trusted-header – behind the GB Prism gateway: the gateway authenticates and
//                    sets X-Prism-User-Email; requests must also carry the shared
//                    PRISM_GATEWAY_SECRET in X-Prism-Gateway-Secret.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, AppError } from './db.js';
import { buildApi } from './http/api.js';
import { readSession, makeSession, sessionCookie, readBody, send, SECURITY_HEADERS } from './http/router.js';
import { loadActor } from './domain/authz.js';
import { seedSynthetic, seedPlans } from './seed.js';
import * as google from './http/google.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

export function createServer(db, { devLogin = process.env.DEV_LOGIN === '1', authMode = process.env.AUTH_MODE || 'dev', googleCfg = google.googleConfig(), fetchImpl = fetch } = {}) {
  if (authMode === 'google' && !googleCfg) throw new Error('AUTH_MODE=google needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_ALLOWED_DOMAIN and BASE_URL');
  if (devLogin && process.env.NODE_ENV === 'production') throw new Error('DEV_LOGIN cannot be enabled in production');
  const api = buildApi(db);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      if (url.pathname === '/auth/google' && googleCfg) return google.start(googleCfg, res);
      if (url.pathname === '/auth/google/callback' && googleCfg) return await google.callback(googleCfg, db, req, res, url, fetchImpl);
      if (url.pathname === '/healthz') { db.prepare('SELECT 1').get(); return send(res, 200, { ok: true }); }
      if (url.pathname === '/api/auth/config') return send(res, 200, { google: !!googleCfg, dev: devLogin, domain: googleCfg?.domain ?? null });
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      // CSRF: state-changing requests must come from our own JS
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'prism') throw new AppError(403, 'csrf', 'Missing request header');

      if (url.pathname === '/api/dev/users' && devLogin) {
        return send(res, 200, db.prepare("SELECT u.id, u.name, u.email, t.name tenant, (SELECT group_concat(role) FROM user_roles r WHERE r.user_id = u.id) roles FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.synthetic = 1 ORDER BY t.id, u.name").all());
      }
      if (url.pathname === '/api/dev/login' && devLogin && req.method === 'POST') {
        const { userId } = JSON.parse((await readBody(req)).toString() || '{}');
        const u = db.prepare('SELECT * FROM users WHERE id = ? AND synthetic = 1').get(userId);
        if (!u) throw new AppError(400, 'invalid', 'Unknown synthetic user');
        return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(makeSession(u.id)) });
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': 'prism_session=; Max-Age=0; Path=/' });

      const userId = authMode === 'trusted-header' ? fromGateway(db, req) : readSession(req); // 'google' and 'dev' both use the signed session cookie
      const actor = userId && loadActor(db, userId);
      if (!actor) throw new AppError(401, 'unauthenticated', 'Please sign in');

      const route = api.match(req.method, url.pathname);
      if (!route) throw new AppError(404, 'not_found', 'No such endpoint');
      const raw = route.opts.raw ? await readBody(req) : null;
      let body = {};
      if (!route.opts.raw && req.method !== 'GET') { const b = (await readBody(req, 1e6)).toString(); body = b ? JSON.parse(b) : {}; }
      const out = await route.handler({ actor, params: route.params, body, raw, ctx: { url } });
      if (out && out.__raw !== undefined) return send(res, 200, out.__raw, { 'Content-Type': out.contentType, 'Content-Disposition': `attachment; filename="${out.filename}"` });
      return send(res, 200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof AppError) return send(res, e.status, { error: e.code, message: e.message, details: e.details });
      if (e instanceof SyntaxError) return send(res, 400, { error: 'invalid', message: 'Malformed JSON' });
      console.error(e);
      return send(res, 500, { error: 'server', message: 'Something went wrong. Your work is saved up to the last confirmation.' });
    }
  });
}

function fromGateway(db, req) {
  const secret = process.env.PRISM_GATEWAY_SECRET;
  const given = req.headers['x-prism-gateway-secret'];
  if (!secret || !given || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) return null;
  const email = String(req.headers['x-prism-user-email'] || '').toLowerCase();
  const tenant = String(req.headers['x-prism-tenant'] || '');
  return db.prepare('SELECT id FROM users WHERE lower(email) = ? AND tenant_id = ? AND active = 1').get(email, tenant)?.id ?? null;
}

function serveStatic(p, res) {
  const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
  fs.createReadStream(file).pipe(res);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  if (process.env.DEV_LOGIN === '1') { seedSynthetic(db); seedPlans(db); }
  const port = Number(process.env.PORT || 3000);
  createServer(db).listen(port, process.env.HOST || '0.0.0.0', () => console.log(`GB Prism People & Performance on http://localhost:${port}${process.env.DEV_LOGIN === '1' ? ' (synthetic dev login)' : ''}`));
}
