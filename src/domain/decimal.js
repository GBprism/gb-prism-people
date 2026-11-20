// Exact decimal handling for leave units. Vendor values such as "6.50",
// "-0.50" or 229.5 are converted to integer hundredths without float drift.
export function toX100(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    v = String(v);
  }
  const s = String(v).trim().replace(/,/g, '');
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[3] || '').padEnd(2, '0');
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) {
    throw new Error(`Value ${s} has more than 2 decimal places; cannot store exactly`);
  }
  const n = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  return m[1] ? -n : n;
}

export function fromX100(n) {
  if (n === null || n === undefined) return null;
  return n / 100;
}

export function fmtX100(n) {
  if (n === null || n === undefined) return '—';
  const neg = n < 0; const a = Math.abs(n);
  const whole = Math.floor(a / 100); const frac = a % 100;
  const s = frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
  return (neg ? '-' : '') + s;
}
