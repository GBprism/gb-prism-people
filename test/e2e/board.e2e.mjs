// The GB consulting workflow on the engagement board and discussion, in a real browser (synthetic data):
// lead assigns "Draft N-2 organization structure" with a due date and the working file → consultant opens it
// from Home, completes the checklist, moves it to Internal review → reviewer opens the review request and
// comments → consultant sees the feedback → a workshop follow-up becomes a task traceable to its message →
// someone outside the engagement finds nothing (search, notifications, direct link). Desktop and phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fresh, SYN } from '../helpers.js';
import { createServer } from '../../src/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

test('engagement board and discussion: the consulting workflow end to end', { skip: !chromium && 'playwright not installed' }, async () => {
  const { db } = fresh();
  db.prepare('UPDATE project_assignments SET end_date = NULL WHERE project_id = ?').run('prj_alpha');
  const srv = createServer(db, { devLogin: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const errors = [];
  const pageAs = async (userId, viewport = { width: 1440, height: 950 }) => {
    const p = await (await browser.newContext({ viewport })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/40[0-9]/.test(m.text())) errors.push(m.text()); });
    await p.goto(base);
    await p.evaluate(async (id) => { await fetch('/api/dev/login', { method: 'POST', headers: { 'X-Requested-With': 'prism' }, body: JSON.stringify({ userId: id }) }); }, userId);
    await p.reload(); await p.waitForSelector('.home-hero');
    return p;
  };
  const card = () => db.prepare("SELECT * FROM deliverables WHERE title = 'Draft N-2 organization structure'").get();
  const until = async (fn, what) => { for (let i = 0; i < 50; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`timed out: ${what}`); };
  try {
    // 1 ---- the lead adds the task in To do, assigns it, sets due date, reviewer, working file, checklist
    const lead = await pageAs(SYN.lead);
    await lead.goto(`${base}#/project/prj_alpha/board`); await lead.waitForSelector('.board');
    await lead.locator('.col-todo .add-task-btn').click();
    await lead.fill('input[aria-label="New task in To do"]', 'Draft N-2 organization structure'); await lead.keyboard.press('Enter');
    await lead.waitForSelector('.board-card:has-text("Draft N-2 organization structure")');
    await lead.click('.board-card:has-text("Draft N-2 organization structure")'); await lead.waitForSelector('.card-detail');
    await lead.selectOption('#cd-owner', SYN.emp); await lead.waitForSelector('text=Saved');
    await lead.fill('#cd-due', iso(3)); await lead.locator('#cd-due').dispatchEvent('change'); await lead.waitForTimeout(400);
    await lead.selectOption('#cd-reviewer', SYN.senior); await lead.waitForTimeout(400);
    await lead.fill('input[aria-label="Drive link"]', 'https://docs.google.com/presentation/d/n2-structure'); await lead.getByRole('button', { name: 'Link', exact: true }).click();
    await lead.waitForSelector('.card-files a:has-text("Working file")');
    await lead.fill('input[aria-label="New checklist item"]', 'Span of control within 6–8'); await lead.keyboard.press('Enter');
    await lead.waitForSelector('.card-checklist li');
    const c = card();
    assert.equal(c.owner_id, SYN.emp); assert.equal(c.due_date, iso(3)); assert.equal(c.qa_reviewer_id, SYN.senior); assert.match(c.drive_url, /n2-structure/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE event = 'card.assigned' AND recipient_id = ?").get(SYN.emp).n, 1);

    // 2 ---- the consultant opens it from Home, ticks the checklist and sends it to Internal review
    const emp = await pageAs(SYN.emp);
    await emp.locator('.home-attn a', { hasText: 'Draft N-2 organization structure' }).click();
    await emp.waitForSelector('.card-detail');
    assert.match(await emp.textContent('.drawer'), /Span of control/);
    // the review rule shows when the checklist is not done (moving by the labelled Status control)
    await emp.selectOption('#cd-status', 'submitted'); await emp.waitForSelector('.board-status .banner-danger');
    assert.match(await emp.textContent('.board-status'), /Finish the checklist first/);
    assert.equal(card().status, 'todo', 'the failed move was rolled back');
    await emp.waitForSelector('.drawer .card-checklist input'); // the card stays open after the refused move
    await emp.locator('.card-checklist input').check(); await emp.waitForTimeout(400);
    await emp.selectOption('#cd-status', 'submitted');
    await until(() => card().status === 'submitted', 'card saved in Internal review');
    await emp.waitForFunction(() => document.querySelector('.col-submitted')?.textContent.includes('Draft N-2'));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE event = 'card.review' AND recipient_id = ?").get(SYN.senior).n, 1);

    // 3 ---- the reviewer opens the review request from Home, comments with a mention, sends it back
    const rev = await pageAs(SYN.senior);
    assert.match(await rev.textContent('.focus-title'), /Review “Draft N-2 organization structure”/, 'the review request is the reviewer’s main next action');
    await rev.getByRole('link', { name: 'Review', exact: true }).click();
    await rev.waitForSelector('.review-box');
    const box = rev.locator('textarea[aria-label="Comment"]');
    await box.fill('Good start. Please add the HR business partner role. @Eli');
    await rev.waitForSelector('.suggest-item:has-text("Eli Employee")'); await rev.keyboard.press('Enter');
    await rev.getByRole('button', { name: 'Comment', exact: true }).click(); await rev.waitForSelector('.card-comments li');
    await rev.getByRole('button', { name: 'Send back for changes' }).click();
    await until(() => card().status === 'in_progress', 'sent back for changes');
    // the consultant sees the feedback and the next step
    await emp.goto(`${base}#/`); await emp.reload(); await emp.waitForSelector('.home-attn');
    assert.match(await emp.textContent('.home-attn'), /Changes requested/);
    await emp.locator('.home-attn a', { hasText: 'Draft N-2 organization structure' }).first().click(); await emp.waitForSelector('.card-comments li');
    assert.match(await emp.textContent('.card-comments'), /HR business partner role/);
    assert.match(await emp.textContent('.card-comments .mention'), /@Eli Employee/);

    // drag-and-drop and keyboard moves are saved
    await emp.keyboard.press('Escape'); await emp.goto(`${base}#/project/prj_alpha/board`); await emp.waitForSelector('.board-card');
    await emp.locator('.board-card:has-text("Draft N-2")').dragTo(emp.locator('.col-todo .board-list'));
    await until(() => card().status === 'todo', 'drag to To do saved');
    await emp.locator('.board-card:has-text("Draft N-2")').focus(); await emp.keyboard.press('Alt+ArrowRight');
    await until(() => card().status === 'in_progress', 'keyboard move saved');

    // 4 ---- a workshop follow-up in Discussion becomes a task, traceable to its message
    await lead.keyboard.press('Escape'); await lead.goto(`${base}#/project/prj_alpha/discussion`); await lead.waitForSelector('textarea[aria-label="Message the team"]');
    await lead.fill('textarea[aria-label="Message the team"]', 'Workshop 1 follow-up: the client wants a RACI for HR approvals by next week.');
    await lead.getByRole('button', { name: 'Send', exact: true }).click(); await lead.waitForSelector('.disc-msg:has-text("RACI")');
    await lead.locator('.disc-msg:has-text("RACI") button[aria-haspopup="menu"]').click();
    await lead.getByRole('menuitem', { name: 'Create task from message' }).click();
    await lead.fill('#tm-title', 'RACI for HR approvals'); await lead.selectOption('#tm-owner', SYN.emp); await lead.fill('#tm-due', iso(6));
    await lead.getByRole('button', { name: 'Create task' }).click(); await lead.waitForSelector('.disc-tasks a:has-text("RACI for HR approvals")');
    await lead.click('.disc-tasks a:has-text("RACI for HR approvals")'); await lead.waitForSelector('.card-detail');
    assert.match(await lead.textContent('.drawer'), /From the discussion/);
    await lead.click('.drawer a:has-text("Open the message")'); await lead.waitForSelector('.disc-msg.is-focus:has-text("RACI")');
    // the lead pins a decision
    await lead.fill('textarea[aria-label="Message the team"]', 'Decision: HR stays a shared service.'); await lead.getByRole('button', { name: 'Send', exact: true }).click();
    await lead.waitForSelector('.disc-msg:has-text("Decision: HR stays")');
    await lead.locator('.disc-msg:has-text("Decision: HR stays") button[aria-haspopup="menu"]').click(); await lead.getByRole('menuitem', { name: 'Pin as a decision' }).click();
    await lead.waitForSelector('.pinned:has-text("HR stays a shared service")');
    // a reply in a thread
    await emp.goto(`${base}#/project/prj_alpha/discussion`); await emp.waitForSelector('.disc-msg:has-text("RACI")');
    await emp.locator('.disc-msg:has-text("RACI") button.text-link').click(); await emp.waitForSelector('textarea[aria-label="Reply"]');
    await emp.fill('textarea[aria-label="Reply"]', 'On it — draft by Tuesday'); await emp.click('.drawer-footer button:has-text("Reply")');
    await emp.waitForSelector('.drawer .disc-msg:has-text("draft by Tuesday")');
    // the same conversation is in Messages
    await emp.keyboard.press('Escape'); await emp.goto(`${base}#/messages`); await emp.waitForSelector('.conv');
    assert.match(await emp.textContent('.conv-list'), /Project Alpha — strategy — discussion/);
    // search finds the task for the team
    await emp.keyboard.press('Control+k'); await emp.keyboard.type('RACI'); await emp.waitForSelector('.palette-item:has-text("RACI for HR approvals")');
    await emp.keyboard.press('Escape');

    // 5 ---- someone outside the engagement: no search hits, no alerts, direct links refused
    const out = await pageAs(SYN.peer);
    await out.keyboard.press('Control+k'); await out.keyboard.type('RACI'); await out.waitForTimeout(700);
    assert.equal(await out.locator('.palette-item:has-text("RACI")').count(), 0);
    await out.keyboard.press('Escape');
    const cid = db.prepare("SELECT id FROM deliverables WHERE title = 'RACI for HR approvals'").get().id;
    for (const path of [`/api/projects/prj_alpha/board`, `/api/cards/${cid}`, '/api/projects/prj_alpha/discussion', `/api/search?q=RACI`]) {
      const r = await out.evaluate(async (u) => { const x = await fetch(u, { headers: { 'X-Requested-With': 'prism' } }); return [x.status, await x.text()]; }, path);
      if (path.startsWith('/api/search')) assert.deepEqual(JSON.parse(r[1]), { cards: [], messages: [] }); else assert.equal(r[0], 404, path);
    }
    await out.goto(`${base}#/project/prj_alpha/board?card=${cid}`); await out.waitForSelector('.alert.error');
    assert.equal(await out.locator('.board-card').count(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_outbox WHERE recipient_id = ? AND (event LIKE ? OR event = ?)').get(SYN.peer, 'card.%', 'mention').n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM mentions WHERE user_id = ?').get(SYN.peer).n, 0);

    // phone: board scrolls by column without page sideways scroll; card opens full screen; status control works
    const ph = await pageAs(SYN.emp, { width: 390, height: 844 });
    await ph.goto(`${base}#/project/prj_alpha/board`); await ph.waitForSelector('.board-card');
    assert.ok(await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'board scrolls the page sideways on a phone');
    await ph.click('.board-card:has-text("RACI")'); await ph.waitForSelector('.card-detail');
    assert.ok(await ph.evaluate(() => document.querySelector('.drawer').getBoundingClientRect().width >= innerWidth - 1), 'card detail is full screen on a phone');
    await ph.selectOption('#cd-status', 'in_progress');
    await ph.waitForFunction(() => document.querySelector('.col-in_progress')?.textContent.includes('RACI'));
    await ph.goto(`${base}#/project/prj_alpha/discussion`); await ph.waitForSelector('.disc-msg');
    assert.ok(await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'discussion scrolls sideways on a phone');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
