import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN } from './helpers.js';
import { createServer } from '../src/server.js';

async function boot() {
  const { db } = fresh();
  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = async (userId) => {
    const r = await fetch(`${base}/api/dev/login`, { method: 'POST', headers: { 'X-Requested-With': 'prism', 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return (path, opts = {}) => fetch(base + path, { ...opts, headers: { cookie, 'X-Requested-With': 'prism', 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  };
  return { db, srv, base, login };
}

test('HTTP: auth, CSRF, record-level permissions on every entry point', async () => {
  const { srv, base, login } = await boot();
  try {
    assert.equal((await fetch(`${base}/api/me`)).status, 401);
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);

    const emp = await login(SYN.emp);
    const me = await (await emp('/api/me')).json();
    assert.equal(me.name, 'Eli Employee');
    const home = await (await emp('/api/home')).json();
    assert.match(home.next.label, /self-assessment/);

    const plan = `plan_${SYN.emp}_2026`;
    // CSRF header required for writes
    const noHeader = await fetch(`${base}/api/plans/${plan}/self/submit`, { method: 'POST', headers: { cookie: (await fetch(`${base}/api/dev/login`, { method: 'POST', headers: { 'X-Requested-With': 'prism' }, body: JSON.stringify({ userId: SYN.emp }) })).headers.get('set-cookie').split(';')[0] } });
    assert.equal(noHeader.status, 403);

    // peer, unrelated manager, admin and other tenant cannot read the review, export it or see it in inbox
    for (const who of [SYN.peer, SYN.unrelated, SYN.ops, SYN.otherUser]) {
      const c = await login(who);
      assert.equal((await c(`/api/plans/${plan}`)).status, 403, who);
      assert.equal((await c(`/api/plans/${plan}/export`)).status, 403, who);
      const inbox = await (await c('/api/inbox')).json();
      assert.ok(!JSON.stringify(inbox).includes(plan), who);
    }
    // employee cannot export own review; manager can (CSV with formula-injection guard)
    assert.equal((await emp(`/api/plans/${plan}/export`)).status, 403);
    const mgr = await login(SYN.manager);
    const csv = await mgr(`/api/plans/${plan}/export`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);

    // leave request: reason hidden from peers; admin dashboard has no ratings
    const r = await (await emp('/api/leave/requests', { method: 'POST', body: JSON.stringify({ typeCode: 'SL', start: '2026-12-06', end: '2026-12-06', reason: 'Medical appointment' }) })).json();
    assert.equal(r.reason, 'Medical appointment');
    const peer = await login(SYN.peer);
    assert.equal((await peer(`/api/leave/requests/${r.id}`)).status, 404);
    const ops = await login(SYN.ops);
    const dash = await (await ops('/api/admin/dashboard')).json();
    assert.ok(!/rating|score/i.test(JSON.stringify(dash.rows)));
    assert.equal((await emp('/api/admin/roster')).status, 403);
    // other tenant admin sees nothing of GB
    const other = await login(SYN.otherUser);
    const roster = await (await other('/api/admin/roster')).json();
    assert.ok(roster.every((u) => !u.email.endsWith('example.test') || u.email === 'otto@example.test'));
    assert.equal((await other(`/api/leave/requests/${r.id}`)).status, 404);
    assert.equal((await other('/api/leave/balances?userId=' + SYN.emp)).status, 403);
  } finally { srv.close(); }
});

test('HTTP: malformed request URL from a scanner returns 400 and the server keeps running', async () => {
  const net = await import('node:net');
  const { srv, base } = await boot();
  try {
    const port = srv.address().port;
    const raw = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let buf = ''; s.on('data', (d) => { buf += d; }); s.on('end', () => resolve(buf)); s.on('error', () => resolve(buf));
    });
    assert.match(raw, /^HTTP\/1\.1 (400|404)/);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally { srv.close(); }
});
