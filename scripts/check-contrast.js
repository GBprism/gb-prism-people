// Fails if any text/background token pair is below WCAG AA (4.5:1 text, 3:1 large text/UI).
import fs from 'node:fs';
const css = fs.readFileSync(new URL('../public/tokens.css', import.meta.url), 'utf8');
const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
const vars = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const val = (n) => { let v = vars[n]; for (let i = 0; i < 5 && v && v.startsWith('var('); i++) v = vars[v.slice(6, -1).split(',')[0]]; return v; };
const lum = (hex) => { const c = hex.replace('#', ''); const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const PAIRS = [
  ['color-text', 'color-canvas', 4.5], ['color-text', 'color-surface', 4.5], ['color-text-2', 'color-surface', 4.5], ['color-text-3', 'color-surface', 4.5], ['color-text-3', 'color-canvas', 4.5], ['color-text-3', 'color-subtle', 4.5],
  ['color-on-primary', 'color-primary', 4.5], ['color-primary', 'color-surface', 4.5], ['color-primary', 'color-primary-tint', 4.5], ['color-on-primary', 'color-primary-hover', 4.5],
  ['color-success', 'color-success-bg', 4.5], ['color-warning', 'color-warning-bg', 4.5], ['color-danger', 'color-danger-bg', 4.5], ['color-info', 'color-info-bg', 4.5], ['color-neutral', 'color-neutral-bg', 4.5],
  ['color-danger', 'color-surface', 4.5], ['color-text-on-dark', 'gb-midnight', 4.5], ['color-text-on-dark-2', 'gb-midnight', 4.5], ['gb-cyan', 'gb-midnight', 3], ['color-focus', 'color-surface', 3], ['color-control-border', 'color-surface', 3], ['color-control-border', 'color-canvas', 3],
];
let bad = 0;
for (const [fg, bg, min] of PAIRS) {
  const r = ratio(val(fg), val(bg));
  if (r < min) { bad++; console.error(`contrast FAIL ${fg} on ${bg}: ${r.toFixed(2)} < ${min}`); }
}
console.log(bad ? `contrast: ${bad} failing pair(s)` : `contrast: ${PAIRS.length} pairs pass AA`);
process.exit(bad ? 1 : 0);
