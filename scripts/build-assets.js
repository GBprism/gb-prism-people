// Build static UI assets into public/ (committed, so the server needs no build step).
//   npm run build:assets
// - Inter (400/500/600) + Poppins 600, latin subset, self-hosted (CSP blocks external fonts)
// - Lucide icon sprite with only the icons the app uses
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const nm = (p) => path.join(root, 'node_modules', p);
const out = (p) => path.join(root, 'public', p);
fs.mkdirSync(out('fonts'), { recursive: true });

for (const [pkg, file] of [['@fontsource/inter', 'inter-latin-400-normal.woff2'], ['@fontsource/inter', 'inter-latin-500-normal.woff2'], ['@fontsource/inter', 'inter-latin-600-normal.woff2'], ['@fontsource/poppins', 'poppins-latin-600-normal.woff2']]) {
  fs.copyFileSync(nm(`${pkg}/files/${file}`), out(`fonts/${file}`));
}
fs.writeFileSync(out('fonts/LICENSE.txt'), 'Inter and Poppins are licensed under the SIL Open Font License 1.1 (https://openfontlicense.org). Files from @fontsource.\n');

// Every icon used in the UI. Add a name here, then rerun the script.
export const ICONS = [
  'inbox', 'calendar-days', 'calendar-check', 'clipboard-check', 'clipboard-list', 'folder-kanban', 'sparkles', 'settings', 'users', 'upload', 'cloud-upload',
  'file-spreadsheet', 'file-text', 'download', 'scale', 'bell', 'bell-ring', 'bot', 'scroll-text', 'search', 'circle-help', 'log-out', 'chevron-down', 'chevron-right',
  'chevron-left', 'chevrons-left', 'chevrons-right', 'menu', 'x', 'check', 'circle-check', 'circle-alert', 'triangle-alert', 'info', 'circle-x', 'clock', 'loader-circle',
  'plus', 'pencil', 'trash-2', 'ellipsis', 'filter', 'arrow-up-down', 'arrow-right', 'arrow-up-right', 'arrow-down-right', 'external-link', 'eye', 'send',
  'user', 'user-check', 'user-round', 'briefcase', 'target', 'award', 'trending-up', 'gauge', 'list-checks', 'history', 'rotate-ccw', 'lock', 'shield-check',
  'plane', 'house', 'stethoscope', 'heart', 'sun', 'layout-dashboard', 'table', 'rows-3', 'command', 'messages-square', 'lightbulb', 'file-check-2', 'refresh-cw',
  'circle-dot', 'circle', 'hourglass', 'party-popper', 'mail', 'building-2', 'map-pin', 'percent', 'hash', 'goal',
];
const src = nm('lucide-static/icons');
const symbols = [];
const missing = [];
for (const name of ICONS) {
  const f = path.join(src, `${name}.svg`);
  if (!fs.existsSync(f)) { missing.push(name); continue; }
  const svg = fs.readFileSync(f, 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  symbols.push(`<symbol id="i-${name}" viewBox="0 0 24 24">${inner}</symbol>`);
}
if (missing.length) { console.error('Missing Lucide icons:', missing.join(', ')); process.exit(1); }
fs.writeFileSync(out('icons.svg'), `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n<!-- Lucide icons (ISC licence, lucide.dev) -->\n${symbols.join('\n')}\n</svg>\n`);
console.log(`fonts: 4 files · icons: ${symbols.length}`);
