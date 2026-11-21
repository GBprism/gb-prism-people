// Repo checks: syntax of every JS file, migrations apply cleanly on an empty
// database, and no private/real data is tracked by git.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, MIGRATIONS } from '../src/db.js';

let failed = 0;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of ['src', 'public', 'scripts', 'test'].flatMap(walk).filter((f) => f.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { failed++; console.error(`syntax: ${f}\n${e.stderr}`); }
}
const db = openDb(':memory:');
const v = db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;
if (v !== MIGRATIONS.length) { failed++; console.error(`migrations: applied ${v} of ${MIGRATIONS.length}`); }
try {
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n');
  const bad = tracked.filter((f) => /^private-extracts\/|^config\/private\/|^backup\/|\.db$|^data\/(?!\.gitkeep)/.test(f) || /\.xlsx$/.test(f));
  if (bad.length) { failed++; console.error('private or data files tracked by git:', bad); }
} catch { /* not a git checkout */ }
// design rule: colours live only in public/tokens.css
for (const f of ['public/components.css', 'public/styleguide.css', 'public/ui.js', 'public/shell.js', 'public/app.css']) {
  const hits = fs.readFileSync(f, 'utf8').split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(l) && !/xmlns|http/.test(l));
  for (const [n] of hits) { failed++; console.error(`hard-coded colour: ${f}:${n} (use a token)`); }
}
try { execFileSync(process.execPath, ['scripts/check-contrast.js'], { stdio: 'inherit' }); } catch { failed++; }
console.log(failed ? `check: ${failed} problem(s)` : `check: ok (${MIGRATIONS.length} migrations)`);
process.exit(failed ? 1 : 0);
