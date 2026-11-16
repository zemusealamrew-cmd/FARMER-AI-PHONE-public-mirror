import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallController, AI_PHASES } from '../app/src/call.mjs';

const fresh = () => {
  const logged = [];
  return { c: new CallController({ log: (e) => logged.push(e) }), logged };
};

test('R-04 / RU-13 / CI-13፦ ጥሪ ሲመጣ AI ወዲያውኑ ይቋረጣል', () => {
  const { c } = fresh();
  c.aiStarted('s-1', AI_PHASES.SPEAKING);
  assert.equal(c.isAiActive(), true);
  const pre = c.incoming({ from: '+251900000000', kind: 'voice' });
  assert.equal(pre.preempted, true, 'AI ዙሩ ተቋረጧል');
  assert.equal(pre.code, 'AI_PREEMPTED');
  assert.equal(c.isAiActive(), false, 'የAI ሂደት አልተመለሰም');
  assert.ok(pre.snapshot.phase, 'የተቋረጠው ደረጃ ተይዟል');
});

test('R-04 / RG-34-01፦ ጥሪ በሚደረግበት ጊዜ AI ማስጀመር አይቻልም', () => {
  const { c } = fresh();
  c.incoming({ from: '+251900000000', kind: 'voice' });
  const r = c.aiStarted('s-2', AI_PHASES.LISTENING);
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'CALL_ACTIVE');
  assert.equal(c.assertAiAllowed().allowed, false);
});

test('R-04 / F-18፦ ጥሪ ሲያልቅ AI በተጠቃሚ ፈቃድ ብቻ ይመለሳል (no auto-resume)', () => {
  const { c } = fresh();
  c.aiStarted('s-1', AI_PHASES.SPEAKING);
  c.incoming({ from: 'X', kind: 'voice' });
  c.accept();
  const ended = c.end();
  assert.equal(ended.ok, true);
  assert.equal(ended.resume_requires_consent, true, 'እንደገና መጀመር የተጠቃሚ ውሳኔ ይፈልጋል');
  assert.ok(ended.snapshot, 'የተቋረጠው ዙር መረጃ ተይዟል');
  assert.equal(c.assertAiAllowed().allowed, true, 'ጥሪው ማለቱ ለAI መመለስ ፈቃድ አይደለም');
});

test('R-04 / VE-05፦ የክስተት ቅደም ተከተል ማስረጃ ትክክል ነው', () => {
  const { c, logged } = fresh();
  c.aiStarted('s-1', AI_PHASES.LISTENING);
  c.incoming({ from: 'Y', kind: 'voice' });
  c.end();
  const kinds = c.events.map((e) => e.event);
  const cutIndex = kinds.indexOf('ai_preempted');
  assert.ok(cutIndex >= 0, 'የማቋረጥ ክስተት ተመዝግቧል');
  assert.ok(kinds.indexOf('call_incoming') > cutIndex, 'ማቋረጡ ከጥሪ መረጃ ጋር ተያይዞ ተቀድሟል');
  assert.ok(kinds.includes('ai_resume_pending_consent'));
  assert.equal(logged.length, kinds.length, 'የውስጥ መዝገብና የውጭ ሎግ እኩል ናቸው');
});

test('R-04 / F-18፦ የአደጋ ጥሪ ምንም የAI ሥራ አይፈቅድም', () => {
  const { c } = fresh();
  c.aiStarted('s-1', AI_PHASES.SPEAKING);
  const emergency = c.incoming({ from: 'emergency', kind: 'emergency' });
  assert.equal(emergency.preempted, true);
  assert.equal(c.aiStarted('s-1', AI_PHASES.THINKING).allowed, false);
});

test('R-04፦ ጥሪ ሳለ ሁለተኛ ጥሪ AIን አያንጣልም (deterministic)', () => {
  const { c } = fresh();
  c.incoming({ from: 'A', kind: 'voice' });
  const second = c.incoming({ from: 'B', kind: 'voice' });
  assert.equal(second.code, 'ALREADY_IN_CALL');
  assert.equal(second.preempted, false);
});

test('R-04 / F-18፦ ጥሪ ሳይኖር AI ፈቃድ አያልቅም', () => {
  const { c } = fresh();
  assert.equal(c.end().code, 'NO_CALL');
  assert.equal(c.accept().code, 'NO_CALL');
});

test('R-04 / R-37 / F-18፦ የማቋረጥ ናሙና የተቋረጠውን ዙር መታወቂያ ይዞ ይመዝገባል', () => {
  const { c } = fresh();
  c.aiStarted('sess-42', AI_PHASES.LISTENING, { turn: 3, topicId: 'T-WOOD-STOVE' });
  const cut = c.incoming({ from: '+251911', kind: 'normal' });
  assert.equal(cut.snapshot.session_id, 'sess-42', 'ማንኛው ክፍለ-ጊዜ እንደተቋረጠ የለውም ከሆነ መልሶ አይቀጥልም');
  assert.equal(cut.snapshot.turn, 3);
  assert.equal(cut.snapshot.topic_id, 'T-WOOD-STOVE');
  assert.equal(cut.snapshot.phase, 'LISTENING');
  const ended = c.end();
  assert.equal(ended.snapshot.turn, 3, 'ጥሪ ሲያልቅም ናሙናው አይጠፋም');
});

test('R-04 / RU-13፦ የAI ደረጃ ሽግግር መረጃውን አያጣም፣ የማያውቀው ስም ይደፋል', () => {
  const { c } = fresh();
  c.aiStarted('sess-7', AI_PHASES.LISTENING, { turn: 1 });
  assert.equal(c.aiPhase(AI_PHASES.SPEAKING, { sessionId: 'sess-7', turn: 2, topicId: 'T-MILK' }).allowed, true);
  assert.equal(c.phase, 'SPEAKING');
  const cut = c.incoming({ from: 'x', kind: 'voice' });
  assert.equal(cut.snapshot.turn, 2, 'የተዛመደው ደረጃ ቁጥር መከታተል አለበት');
  assert.equal(cut.snapshot.topic_id, 'T-MILK');
  assert.throws(() => c.aiPhase('SLEEPING'), /bad_ai_phase/);
  assert.throws(() => c.aiStarted('sess-7', 'PLAYING'), /bad_ai_phase/);
});

test('R-37 / F-18፦ AI ሲያልቅ ናሙናው ይጠፋል፣ ያለጥሪ ማቋረጥ አይደለም', () => {
  const { c } = fresh();
  c.aiStarted('sess-9', AI_PHASES.SPEAKING, { turn: 5, topicId: 'T-1' });
  c.aiFinished();
  assert.equal(c.aiSession, null, 'የፈቃድ መዝገብ የተጠናቀቀውን ክፍለ-ጊዜ አይያዝም');
  assert.equal(c.aiTurn, null);
  const idle = c.incoming({ from: 'y', kind: 'normal' });
  assert.equal(idle.preempted, false);
  assert.equal(idle.snapshot, null);
});

test('R-04 / RU-13፦ ወደ ውጭ የሚደረግ ጥሪም AIን በመላው መረጃ ይቋረጣል (parity with incoming)', () => {
  const { c } = fresh();
  c.aiStarted('sess-3', AI_PHASES.THINKING, { turn: 8, topicId: 'T-SEED' });
  const out = c.outgoing({ to: 'dentist', kind: 'normal' });
  assert.equal(out.preempted, true);
  assert.equal(out.snapshot.session_id, 'sess-3', 'የወጪ ጥሪ ናሙና ከገቢ ጋር እኩል መረጃ ሊኖረው ይገባ');
  assert.equal(out.snapshot.turn, 8);
  assert.equal(out.snapshot.topic_id, 'T-SEED');
  assert.equal(c.end().resume_requires_consent, true);
});
