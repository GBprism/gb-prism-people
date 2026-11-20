// Workbook inspection: values, formulas, cached results, formula errors and
// merged cells, so previews can flag problems instead of importing them.
import ExcelJS from 'exceljs';
import crypto from 'node:crypto';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export async function readWorkbook(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheets = [];
  wb.eachSheet((ws) => {
    const rows = [];
    const maxCol = ws.columnCount;
    ws.eachRow({ includeEmpty: true }, (row, rowNo) => {
      const cells = [];
      for (let c = 1; c <= maxCol; c++) cells.push(cellInfo(row.getCell(c)));
      rows[rowNo - 1] = cells;
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    sheets.push({ name: ws.name, rows, merged: Object.keys(ws._merges || {}).map((k) => ws._merges[k].range || k) });
  });
  return sheets;
}

function cellInfo(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return { v: null };
  if (typeof v === 'object' && !(v instanceof Date)) {
    if ('error' in v) return { v: null, error: v.error };
    if ('formula' in v || 'sharedFormula' in v) {
      const r = v.result;
      if (r && typeof r === 'object' && 'error' in r) return { v: null, formula: v.formula || v.sharedFormula, error: r.error };
      return { v: r ?? null, formula: v.formula || v.sharedFormula, cachedMissing: r === undefined };
    }
    if ('richText' in v) return { v: v.richText.map((t) => t.text).join('') };
    if ('text' in v) return { v: v.text, hyperlink: v.hyperlink };
  }
  return { v };
}

export const val = (c) => (c ? c.v : null);
export const str = (c) => { const x = val(c); return x === null || x === undefined ? '' : String(x instanceof Date ? x.toISOString().slice(0, 10) : x).trim(); };

// Columns that must never be imported into PMS / leave records.
export const EXCLUDED_HEADER = /salary|bonus|increase|compensation|\bpay\b|payroll|social\s*security|\bage\b|working\s*days|net\s*salary|allowance\s*\(jod\)|jod/i;

/** Parse "11/01/2026" style dates, refusing ambiguous formats unless a hint is given. */
export function parseVendorDate(s, format = 'MM/DD/YYYY') {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s).trim());
  if (!m) return null;
  const [a, b, y] = [Number(m[1]), Number(m[2]), m[3]];
  const [mm, dd] = format === 'MM/DD/YYYY' ? [a, b] : [b, a];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
