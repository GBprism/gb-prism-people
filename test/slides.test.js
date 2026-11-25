import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadAsSlides } from '../src/http/google.js';

test('Google Slides export: multipart upload converts the .pptx into a Slides file', async () => {
  let seen;
  const fake = async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ id: 'abc123' }) }; };
  const id = await uploadAsSlides('tok', { name: 'CV Jana Yousef', buffer: Buffer.from('PK-pptx-bytes') }, fake);
  assert.equal(id, 'abc123');
  assert.match(seen.url, /upload\/drive\/v3\/files\?uploadType=multipart/);
  assert.equal(seen.opts.headers.Authorization, 'Bearer tok');
  const body = seen.opts.body.toString();
  const boundary = /boundary=(\S+)/.exec(seen.opts.headers['Content-Type'])[1];
  assert.ok(body.startsWith(`--${boundary}\r\n`) && body.endsWith(`--${boundary}--`));
  assert.match(body, /"mimeType":"application\/vnd.google-apps.presentation"/);
  assert.match(body, /PK-pptx-bytes/);
  const fail = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Google Drive API has not been used in project 1 before or it is disabled' } }) });
  await assert.rejects(uploadAsSlides('tok', { name: 'x', buffer: Buffer.from('x') }, fail), /has not been used/);
});
