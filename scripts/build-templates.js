// Generate downloadable import templates into public/templates/ (committed).
//   npm run build:templates
import ExcelJS from 'exceljs';
import fs from 'node:fs';

const dir = new URL('../public/templates/', import.meta.url);
fs.mkdirSync(dir, { recursive: true });
async function write(name, sheet, header, rows, notes) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.addRow(header); rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true }; ws.columns.forEach((c) => { c.width = 22; });
  const n = wb.addWorksheet('How to fill');
  notes.forEach((t) => n.addRow([t])); n.getColumn(1).width = 110;
  await wb.xlsx.writeFile(new URL(name, dir).pathname);
}
await write('pms-plan-items-template.xlsx', 'Plans',
  ['Email', 'Cycle', 'Category', 'Category weight', 'Item', 'KPI', 'Target', 'Weight', 'Expected proficiency', 'Plan status', 'Approved by'],
  [['name@gb-advisory.com', 2027, 'Objective', '50%', 'End-to-end delivery', '% milestones on time', '≥ 95%', '40%', '', 'Draft', ''],
    ['name@gb-advisory.com', 2027, 'Competency', '30%', 'Problem solving', '', '', '100%', 3, 'Draft', '']],
  ['One row per plan item. Use the person\'s verified work email.', 'Category: Objective, Competency or Initiative. Category weights must total 100% per person; item weights must total 100% within each category.',
    'Do not add salary, bonus or personal columns — they are ignored and reported.', 'Plans import as drafts; the line manager approves them in Prism.']);
await write('pms-history-summary-template.xlsx', 'PMS',
  ['Employee', 'Current Title', 'Delivery Quality (25%)', 'Ownership & Accountability (25%)', 'Client & Communication (20%)', 'Team Contribution (15%)', 'Judgment & Maturity (15%)', 'Total Performance Score', 'Performance Rationale'],
  [['Full Name', 'Consultant', 4, 4, 3.5, 4, 4, 3.9, 'Short rationale']],
  ['One row per person. Dimension headers must include their weight in brackets, e.g. "Delivery Quality (25%)".', 'Totals are recomputed (1 decimal, half up) and mismatches are flagged.', 'Keep this sheet named "PMS". Payroll sheets are refused.']);
console.log('templates written');
