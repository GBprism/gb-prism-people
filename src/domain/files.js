// Uploaded files (expense receipts, brand files) kept in the database next to the records they
// belong to. Type is decided from the bytes, never from the name the browser sends.
import crypto from 'node:crypto';
import { uid, now, bad, notFound } from '../db.js';

const SNIFF = [
  ['application/pdf', (b) => b.subarray(0, 5).toString('latin1') === '%PDF-'],
  ['image/png', (b) => b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG'],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];
export const sniff = (buf) => SNIFF.find(([, f]) => f(buf))?.[0] || null;
const EXT = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Store bytes after checking type and size. Returns the file id. */
export function storeFile(db, actor, { purpose, filename, buffer, allow = Object.keys(EXT), maxBytes = 5 * 1024 * 1024 }) {
  if (!buffer?.length) throw bad('Choose a file');
  if (buffer.length > maxBytes) throw bad(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  const mime = sniff(buffer);
  if (!mime || !allow.includes(mime)) throw bad(`Upload a ${allow.map((m) => EXT[m].toUpperCase()).join(', ')} file`);
  const clean = String(filename || purpose).replace(/[^\w.\- ]+/g, '').replace(/\.[a-z0-9]+$/i, '').trim().slice(0, 80) || purpose;
  const id = uid('file_');
  db.prepare('INSERT INTO files (id, tenant_id, owner_id, purpose, filename, mime, size, sha256, data, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, actor.tenantId, actor.id, purpose, `${clean}.${EXT[mime]}`, mime, buffer.length, crypto.createHash('sha256').update(buffer).digest('hex'), buffer, now());
  return id;
}

/** Raw response for a file; callers check access first. PDFs and images are shown inline, never scripts. */
export function fileResponse(db, tenantId, id, { download = false } = {}) {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!f) throw notFound();
  return { __raw: Buffer.from(f.data), contentType: f.mime, filename: f.filename, inline: !download };
}
