// Minimal router + session handling on node:http (no framework dependency).
import crypto from 'node:crypto';
import { AppError } from '../db.js';

export class Router {
  constructor() { this.routes = []; }
  add(method, path, handler, opts = {}) {
    const keys = []; const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler, opts });
  }
  get(p, h, o) { this.add('GET', p, h, o); } post(p, h, o) { this.add('POST', p, h, o); } patch(p, h, o) { this.add('PATCH', p, h, o); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) return { ...r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

// ---- signed session cookie -------------------------------------------------
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET must be set in production');
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');

export function makeSession(userId, ttlH = 12) {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + ttlH * 3600e3 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
export function readSession(req) {
  const c = Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
  const tok = c.prism_session;
  if (!tok) return null;
  const [p, s] = tok.split('.');
  if (!p || !s) return null;
  const good = sign(p);
  if (good.length !== s.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(s))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.e > Date.now() ? o.u : null; } catch { return null; }
}
export const sessionCookie = (tok) => `prism_session=${tok}; HttpOnly; SameSite=Strict; Path=/${process.env.NODE_ENV === 'production' ? '; Secure' : ''}; Max-Age=43200`;

export async function readBody(req, limit = 10 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new AppError(413, 'too_large', 'Upload too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}

export function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(status, { 'Content-Type': isBuf ? headers['Content-Type'] || 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};
