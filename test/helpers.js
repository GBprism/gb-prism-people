import ExcelJS from 'exceljs';
import { openDb } from '../src/db.js';
import { seedSynthetic, seedPlans, SYN } from '../src/seed.js';
import { loadActor } from '../src/domain/authz.js';

export { SYN };
export function fresh({ plans = true } = {}) {
  const db = openDb(':memory:');
  seedSynthetic(db);
  if (plans) seedPlans(db);
  const as = (id) => loadActor(db, id);
  return { db, as };
}

/** Build an .xlsx buffer from arrays. Cells may be {formula, result} or {error}. */
export async function xlsx(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((r, i) => r.forEach((v, j) => {
      const cell = ws.getCell(i + 1, j + 1);
      if (v && typeof v === 'object' && 'error' in v) cell.value = { error: v.error };
      else if (v && typeof v === 'object' && 'formula' in v) cell.value = { formula: v.formula, result: v.result };
      else cell.value = v;
    }));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Fill a plan's self or manager fields for all items with a given rating. */
export function rateAll(items, field, rating) {
  return items.map((i) => (field === 'self'
    ? { id: i.id, actual: 'Delivered', self_rating: rating, self_rationale: 'Because', self_evidence: [{ url: 'https://drive.example/doc' }] }
    : { id: i.id, manager_rating: rating, manager_rationale: 'Checked with project lead' }));
}

// Freeze "today" for deterministic notice/retro rules
export function withToday(iso, fn) {
  const RealDate = Date;
  const fixed = new RealDate(`${iso}T09:00:00+03:00`).getTime();
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } };
  try { return fn(); } finally { globalThis.Date = RealDate; }
}
