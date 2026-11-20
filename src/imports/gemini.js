// Google Admin → Reporting → Audit and investigation → Gemini for Workspace log
// events (CSV). Aggregated per account into adoption metrics; nothing per event
// is stored, and "Network info" (IP / location) is dropped on read.
//
// "Inactive" events are features Gemini runs on its own (schedule detection,
// auto-proofread, proactive suggestions). They show availability, not use, and
// are reported separately from active conversations / generations.
import { bad } from '../db.js';
import { importUsage } from '../domain/ai.js';

export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

export function summariseGeminiLog(text) {
  const [head, ...data] = parseCsv(text.replace(/^﻿/, ''));
  const ix = (n) => head.indexOf(n);
  for (const n of ['Date', 'Actor', 'App name', 'Event category']) if (ix(n) < 0) throw bad(`Not a Gemini log export: column "${n}" missing`);
  const per = new Map(); const dates = [];
  for (const r of data) {
    const email = String(r[ix('Actor')] || '').toLowerCase(); if (!email) continue;
    const date = r[ix('Date')]; dates.push(date);
    const cat = r[ix('Event category')];
    const p = per.get(email) || { active_conversations: 0, active_generate: 0, passive_events: 0, days: new Set(), apps: new Set() };
    if (/^Active conversations/i.test(cat)) p.active_conversations++;
    else if (/^Active generate/i.test(cat)) p.active_generate++;
    else p.passive_events++;
    if (!/^Inactive/i.test(cat)) { p.days.add(date.slice(0, 10)); p.apps.add(r[ix('App name')]); }
    per.set(email, p);
  }
  dates.sort();
  return { windowFrom: dates[0]?.slice(0, 10), windowTo: dates.at(-1)?.slice(0, 10), events: data.length, accounts: [...per.entries()].map(([email, p]) => ({
    email, active_conversations: p.active_conversations, active_generate: p.active_generate, passive_events: p.passive_events, active_days: p.days.size, apps: [...p.apps].sort() })) };
}

/** Import as adoption data. Accounts listed in `licensedEmails` without events are kept as zero, not missing. */
export function importGeminiLog(db, actor, { text, licensedEmails = [], excludeEmails = [], fileBuffer }) {
  const s = summariseGeminiLog(text);
  const ex = new Set(excludeEmails.map((e) => e.toLowerCase()));
  s.accounts = s.accounts.filter((a) => !ex.has(a.email)); // people GB decided to keep out of the tool
  if (!s.windowFrom) throw bad('The export has no events');
  const rows = [];
  const seen = new Set();
  for (const a of s.accounts) {
    seen.add(a.email);
    for (const m of ['active_conversations', 'active_generate', 'active_days', 'passive_events']) rows.push({ account_email: a.email, access: 'licensed', metric: m, value: a[m] });
  }
  for (const e of licensedEmails.map((x) => x.toLowerCase())) if (!seen.has(e)) for (const m of ['active_conversations', 'active_generate', 'active_days', 'passive_events']) rows.push({ account_email: e, access: 'licensed', metric: m, value: 0 });
  const res = importUsage(db, actor, { tool: 'gemini', report: 'Gemini for Workspace log events', windowFrom: s.windowFrom, windowTo: s.windowTo,
    planNote: `${s.events} events; "Inactive" = features Gemini runs automatically, counted separately as passive_events`, rows, fileBuffer });
  return { ...res, window: [s.windowFrom, s.windowTo], accounts: s.accounts.length, events: s.events };
}
