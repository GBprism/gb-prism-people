// CV slides in GB's format (16:9, Poppins, navy #004281 / blue #0080B2), one slide per person,
// built from the company-profile facts on each profile. Opens in PowerPoint and Google Slides
// (File → Import slides). Icons and the logo come from GB's private CV template folder when present.
import fs from 'node:fs';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
import { notFound } from '../db.js';
import { teamDirectory } from './profiles.js';

const NAVY = '004281'; const BLUE = '0080B2'; const TITLE = '043873'; const GREY = 'F3F3F3'; const INK = '111111';
const FONT = 'Poppins';
const ASSETS = process.env.CV_ASSET_DIR || 'config/private/real/cv-template/media';
const asset = (name) => { try { return `data:image/png;base64,${fs.readFileSync(path.join(ASSETS, name)).toString('base64')}`; } catch { return null; } };

const INDUSTRY_ICONS = [[/bank|financ|insur|invest|fund/i, 'icon-industry-banking-financial-services.png'], [/food|beverage|agri/i, 'icon-industry-food-beverage.png'],
  [/logist|transport|mobility|port|aviation|car/i, 'icon-industry-logistics-transport-mobility.png'], [/mining|fertil|retail|wholesale|industr|manufact/i, 'icon-industry-mining-fertilizers--wholesale-retail.png'],
  [/ngo|foundation|non-?profit|charit|public|government|health/i, 'icon-industry-ngos-foundations.png'], [/start-?up|sme|entrepren/i, 'icon-industry-startups.png'],
  [/touris|hospitality|hotel/i, 'icon-industry-tourism-hospitality.png']];
const FUNCTION_ICONS = [[/cultur|change|hr|people|organi[sz]ation/i, 'icon-function-cultural-transformation.png'], [/journey|persona|customer/i, 'icon-function-customer-journeys-personas.png'],
  [/feasib|business plan/i, 'icon-function-feasibility-business-plans.png'], [/financ|model|valuation/i, 'icon-function-financial-modeling.png'],
  [/go-?to-?market|marketing|sales/i, 'icon-function-go-to-market.png'], [/market research|research|market stud/i, 'icon-function-market-research.png'],
  [/strateg|roadmap|kpi/i, 'icon-function-strategies-roadmaps.png'], [/operating model|tom|process|polic|governance|procedure/i, 'icon-function-target-operating-models.png']];
const iconFor = (label, table) => { const hit = table.find(([re]) => re.test(label)); return hit ? asset(hit[1]) : null; };
const split = (s) => String(s || '').split(/;\s*|\n/).map((x) => x.trim()).filter(Boolean);

function slideFor(pptx, p, photo, logo) {
  const s = pptx.addSlide(); s.background = { color: 'FFFFFF' };
  const title = p.public_title || p.title || '';
  s.addText([{ text: `${p.name} | `, options: { bold: true, fontSize: 17, color: '000000' } }, { text: title, options: { fontSize: 15, color: TITLE } }],
    { x: 0.33, y: 0.425, w: 9.0, h: 0.274, fontFace: FONT, margin: 0, valign: 'middle' });
  if (logo) s.addImage({ data: logo, x: 9.504, y: 0.303, w: 0.448, h: 0.519 });
  // photo
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 1.1175, w: 1.676, h: 1.754, fill: { color: GREY }, line: { color: GREY } });
  if (photo) s.addImage({ data: photo, x: 0, y: 1.1175, w: 1.676, h: 1.754, sizing: { type: 'cover', w: 1.676, h: 1.754 } });
  // name bar and profile band
  s.addText([{ text: p.name, options: { bold: true, fontSize: 12, breakLine: true } }, { text: title, options: { fontSize: 9 } }],
    { shape: pptx.ShapeType.rect, x: 1.676, y: 1.1175, w: 8.324, h: 0.384, fill: { color: NAVY }, color: 'FFFFFF', fontFace: FONT, align: 'center', valign: 'middle', margin: 0 });
  s.addText([{ text: 'Profile: ', options: { bold: true } }, { text: p.bio || `${p.name} is a ${title} at GB Advisory${p.years_experience ? ` with ${p.years_experience} years of experience` : ''}${p.expertise ? `, specialising in ${p.expertise}` : ''}.` }],
    { shape: pptx.ShapeType.rect, x: 1.676, y: 1.501, w: 8.324, h: 0.699, fill: { color: BLUE }, color: 'FFFFFF', fontFace: FONT, fontSize: 7, align: 'justify', valign: 'middle', margin: [4, 10, 4, 10] });
  // left panel: language, education & qualifications, contact
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 2.871, w: 1.676, h: 2.754, fill: { color: NAVY }, line: { color: NAVY } });
  const lbl = (text, y, h) => s.addText(text, { x: 0.016, y, w: 0.563, h, fontFace: FONT, fontSize: 6.5, bold: true, color: 'FFFFFF', align: 'right', valign: 'top', margin: [3, 1, 0, 0], fit: 'shrink' });
  const val = (text, y, h) => s.addText(text, { x: 0.579, y, w: 1.097, h, fontFace: FONT, fontSize: 7, color: 'FFFFFF', align: 'left', valign: 'top', margin: [3, 4, 0, 3], fit: 'shrink' });
  lbl('Language:', 2.871, 0.529); val(p.languages || 'Arabic, English', 2.871, 0.529);
  lbl('Education & Quals:', 3.433, 1.205); val([...split(p.education), ...split(p.certifications)].join('\n') || '—', 3.433, 1.205);
  const contact = [[asset('icon-contact-linkedin-white.png'), p.linkedin ? p.name : null, 4.794], [asset('icon-contact-email-white.png'), p.email, 5.0]];
  for (const [icon, text, y] of contact) {
    if (!text) continue;
    if (icon) s.addImage({ data: icon, x: 0.1035, y: y + 0.001, w: 0.167, h: 0.167 });
    s.addText(text, { x: 0.28, y, w: 1.38, h: 0.17, fontFace: FONT, fontSize: 6, color: 'FFFFFF', margin: 0, valign: 'middle', hyperlink: text === p.name && p.linkedin ? { url: p.linkedin } : undefined });
  }
  // previous projects
  s.addText('Previous Projects', { x: 1.676, y: 2.19, w: 5.91, h: 0.216, fontFace: FONT, fontSize: 10, bold: true, color: '000000', margin: [0, 6, 0, 6], valign: 'middle' });
  const projects = split(p.cv_projects).slice(0, 14);
  const runs = projects.flatMap((line, i) => {
    const m = /^(.{2,80}?)\s+[–-]\s+(.+)$/.exec(line);
    const last = i === projects.length - 1;
    return m ? [{ text: `${m[1]} – `, options: { bold: true, bullet: { indent: 8 } } }, { text: m[2], options: { breakLine: !last } }]
      : [{ text: line, options: { bullet: { indent: 8 }, breakLine: !last } }];
  });
  if (runs.length) s.addText(runs, { x: 1.676, y: 2.40, w: 5.997, h: 3.1, fontFace: FONT, fontSize: 6, color: INK, valign: 'top', margin: [2, 6, 0, 6], paraSpaceAfter: 2, fit: 'shrink' });
  s.addShape(pptx.ShapeType.line, { x: 7.673, y: 2.322, w: 0, h: 3.02, line: { color: BLUE, width: 1 } });
  // industry and functional experience grids (2 columns × 4 rows)
  const grid = (heading, y0, items, table) => {
    s.addText(heading, { x: 7.699, y: y0, w: 2.16, h: 0.216, fontFace: FONT, fontSize: 11, bold: true, color: '000000', margin: [0, 4, 0, 4], valign: 'middle' });
    items.slice(0, 8).forEach((label, i) => {
      const col = Math.floor(i / 4); const row = i % 4; const x = [7.8765, 8.8765][col]; const y = y0 + 0.3167 + row * 0.3056;
      s.addShape(pptx.ShapeType.ellipse, { x, y, w: 0.21, h: 0.21, fill: { color: 'FFFFFF' }, line: { color: NAVY, width: 0.75 } });
      const icon = iconFor(label, table); if (icon) s.addImage({ data: icon, x: x + 0.045, y: y + 0.045, w: 0.12, h: 0.12 });
      s.addText(label, { x: x + 0.204, y, w: col ? 0.92 : 0.79, h: 0.21, fontFace: FONT, fontSize: 6, color: '000000', margin: [0, 2, 0, 2], valign: 'middle', fit: 'shrink' });
    });
  };
  grid('Industry Experience', 2.2664, split(p.industries), INDUSTRY_ICONS);
  grid('Functional Experience', 3.8497, split(p.functions), FUNCTION_ICONS);
}

/** One person's CV, or everyone's (in title order) — returns { buffer, filename }. */
export async function cvDeck(db, actor, userId = null) {
  const people = teamDirectory(db, actor).filter((p) => !userId || p.id === userId);
  if (!people.length) throw notFound();
  const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_16x9'; pptx.company = 'GB Advisory'; pptx.title = userId ? `${people[0].name} – CV` : 'GB Advisory – Team CVs';
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };
  const logo = asset('logo-gb-chevron-cropped.png') || asset('logo-gb-chevron-source.png');
  for (const p of people) {
    const ph = db.prepare('SELECT mime, data FROM user_photos WHERE user_id = ?').get(p.id);
    slideFor(pptx, p, ph ? `data:${ph.mime};base64,${Buffer.from(ph.data).toString('base64')}` : null, logo);
  }
  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  const safe = (s) => s.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_');
  return { buffer, filename: userId ? `CV_${safe(people[0].name)}_GB_Advisory.pptx` : 'GB_Advisory_Team_CVs.pptx' };
}
