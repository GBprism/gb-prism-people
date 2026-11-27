import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, SYN } from './helpers.js';
import * as b from '../src/domain/board.js';
import * as msg from '../src/domain/messages.js';

const outbox = (db, event, to) => db.prepare('SELECT COUNT(*) n FROM notification_outbox WHERE event = ? AND recipient_id = ?').get(event, to).n;

test('board: the GB review workflow on one card, with alerts only where someone must act', () => {
  const { db, as } = fresh();
  const L = as(SYN.lead); const E = as(SYN.emp); const S = as(SYN.senior);
  // lead assigns a task with a due date and the working file
  const card = b.createCard(db, L, 'prj_alpha', { title: 'Draft N-2 organization structure', owner_id: SYN.emp, due_date: '2026-12-03', workstream: 'Organisation' });
  b.updateCard(db, L, card.id, { drive_url: 'https://docs.google.com/presentation/d/abc', expected_output: 'N-2 chart with roles' });
  assert.equal(outbox(db, 'card.assigned', SYN.emp), 1);
  const i1 = b.addChecklistItem(db, L, card.id, { text: 'Span of control checked' });
  // the consultant sees it at home
  assert.ok(b.myCardItems(db, E).some((i) => i.title === 'Draft N-2 organization structure' && i.link.includes(card.id)));
  // review rules: checklist first; owner cannot pass their own review
  b.moveCard(db, E, card.id, { status: 'in_progress' });
  assert.throws(() => b.moveCard(db, E, card.id, { status: 'submitted' }), /checklist first \(0 of 1/);
  b.setChecklistItem(db, E, i1.id, { done: true });
  b.updateCard(db, L, card.id, { reviewer_id: SYN.senior });
  const moved = b.moveCard(db, E, card.id, { status: 'submitted' });
  assert.equal(moved.status, 'submitted');
  assert.equal(outbox(db, 'card.review', SYN.senior), 1);
  assert.ok(b.myCardItems(db, S).some((i) => i.type === 'card_review'));
  assert.throws(() => b.moveCard(db, E, card.id, { status: 'ready' }), /Only the reviewer/);
  assert.throws(() => b.moveCard(db, E, card.id, { status: 'accepted' }), /Internal review and Ready to send first/);
  // reviewer comments with a mention, sends it back; the consultant sees the feedback
  b.addComment(db, S, card.id, { body: '@Eli Employee please add the HR business partner role', mentions: [SYN.emp, SYN.peer] });
  b.moveCard(db, S, card.id, { status: 'in_progress' });
  const mine = b.myCardItems(db, E);
  assert.ok(mine.some((i) => i.kind === 'Changes requested'));
  assert.ok(mine.some((i) => i.type === 'mention'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mentions WHERE user_id = ?').get(SYN.peer).n, 0, 'only people on the project can be mentioned');
  assert.equal(outbox(db, 'card.changes', SYN.emp), 1);
  assert.equal(outbox(db, 'mention', SYN.emp), 1);
  b.cardDetail(db, E, card.id); // opening the card clears the mention
  assert.ok(!b.myCardItems(db, E).some((i) => i.type === 'mention'));
  // back to review, then passed, then done
  b.moveCard(db, E, card.id, { status: 'submitted' });
  b.moveCard(db, S, card.id, { status: 'ready' });
  assert.equal(b.cardDetail(db, L, card.id).review.by, 'Sara Senior');
  b.moveCard(db, L, card.id, { status: 'accepted' });
  // routine moves stay quiet: no email for todo → in progress
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE event LIKE 'card.%' AND recipient_id = ?").get(SYN.lead).n, 0);
  // stale updates are refused with the saved state
  const now = b.cardDetail(db, L, card.id);
  assert.throws(() => b.moveCard(db, L, card.id, { status: 'in_progress', rev: now.rev - 1 }), (e) => e.status === 409 && e.details?.status === 'accepted');
});

test('board and discussion: outsiders get nothing — board, card, comments, search, thread, mentions', () => {
  const { db, as } = fresh();
  const L = as(SYN.lead); const P = as(SYN.peer);
  const card = b.createCard(db, L, 'prj_alpha', { title: 'Workshop follow-up: confirm HR roles', owner_id: SYN.emp });
  assert.throws(() => b.boardView(db, P, 'prj_alpha'), /Not found/);
  assert.throws(() => b.cardDetail(db, P, card.id), /Not found/);
  assert.throws(() => b.addComment(db, P, card.id, { body: 'hi' }), /Not found/);
  assert.deepEqual(b.searchCards(db, P, 'Workshop'), []);
  assert.equal(b.searchCards(db, as(SYN.emp), 'Workshop').length, 1);
  assert.throws(() => msg.projectConversation(db, P, 'prj_alpha'), /Not found/);
  const conv = msg.projectConversation(db, L, 'prj_alpha');
  const m = msg.sendMessage(db, L, conv.id, 'Workshop done — action: confirm HR roles', { mentions: [SYN.emp] });
  msg.sendMessage(db, as(SYN.emp), conv.id, 'On it', { parentId: m.id });
  assert.throws(() => msg.readMessages(db, P, conv.id), /Not found|Not permitted/);
  assert.deepEqual(msg.searchMessages(db, P, 'Workshop'), []);
  assert.equal(msg.searchMessages(db, as(SYN.emp), 'Workshop').length, 1);
  assert.ok(!msg.listConversations(db, P).some((c) => c.id === conv.id));
  // replies are in the thread, not the main list; a task made from a message links back
  const main = msg.readMessages(db, L, conv.id);
  assert.equal(main.messages.length, 1); assert.equal(main.messages[0].replies, 1);
  const t = b.createCard(db, L, 'prj_alpha', { title: 'Confirm HR roles', source_message_id: m.id, owner_id: SYN.emp, due_date: '2026-12-05' });
  assert.equal(b.cardDetail(db, L, t.id).source.id, m.id);
  assert.equal(msg.readMessages(db, L, conv.id).messages[0].tasks[0].id, t.id);
  // pin: lead yes, consultant no
  assert.throws(() => msg.pinMessage(db, as(SYN.emp), conv.id, m.id), /Only the project lead/);
  msg.pinMessage(db, L, conv.id, m.id); assert.equal(msg.readMessages(db, L, conv.id).pinned.length, 1);
  // someone who leaves the project loses the discussion and the board
  db.prepare("UPDATE project_assignments SET end_date = '2020-01-01' WHERE user_id = ? AND project_id = 'prj_alpha'").run(SYN.emp);
  assert.throws(() => msg.readMessages(db, as(SYN.emp), conv.id), /Not found/);
  assert.throws(() => b.boardView(db, as(SYN.emp), 'prj_alpha'), /Not found/);
  assert.ok(!b.myCardItems(db, as(SYN.emp)).length);
});
