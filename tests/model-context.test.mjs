// Adapter regression only. Controlled inference results are not model-quality evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectGeneratedReply } from '../app/src/generation-guard.mjs';
import { dialogueSystemPrompt } from '../app/src/dialogue_prompt.mjs';
import { conversationFacts, factsReminder } from '../app/src/dialogue_facts.mjs';

const source = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8');
const body = source.split('async function respondForSession(s, text, locale) {')[1].split('\nconst NO_INPUT_CODES')[0];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function adapter(infer, risk = () => ({ level: 'low' })) {
  return new AsyncFunction('offlineModelsEnabled', 'runOfflineModel', 'inspectGeneratedReply', 'classifyRisk', 'dialogueSystemPrompt', 'conversationFacts', 'factsReminder',
    'return async function(s,text,locale) {' + body)(() => true, infer, inspectGeneratedReply, risk, dialogueSystemPrompt, conversationFacts, factsReminder);
}
function session() {
  return { dialogue: { kb: { entries: [] }, respond: ({ localeHint }) => ({ locale: localeHint, claims: [] }) },
    call: { assertAiAllowed: () => ({ allowed: true }) } };
}

test('model context retains Amharic user facts after repetitive output is withheld', async () => {
  const s = session(), jobs = [];
  const respond = await adapter(async job => {
    jobs.push(structuredClone(job));
    return jobs.length === 1
      ? { ok: true, text: Array(20).fill('እንደ እንደ ነው').join(' ') }
      : { ok: true, text: 'ያለዎትን መረጃ እባክዎ ያብራሩ።' };
  });
  const first = 'ስሜ ሀና ነው። ሁለት በሬዎች አሉኝ።';
  assert.equal((await respond(s, first, 'am')).code, 'MODEL_OUTPUT_REPETITIVE');
  await respond(s, 'ስሜ ማን ነው?', 'am');
  assert.equal(jobs[1].messages[1].content, first);
  assert.ok(!jobs[1].messages.some(m => m.role === 'assistant'));
});

test('model context retains Oromo input after echo or language mismatch without storing rejected replies', async () => {
  for (const reply of ['Maqaan koo Caalaa dha. Sangoota lama qaba.', 'ይህ የተሳሳተ ቋንቋ መልስ ነው።']) {
    const s = session(), jobs = [];
    const respond = await adapter(async job => { jobs.push(structuredClone(job)); return jobs.length === 1 ? { ok: true, text: reply } : { ok: false, code: 'OFFLINE_MODEL_FAILED' }; });
    const first = 'Maqaan koo Caalaa dha. Sangoota lama qaba.';
    assert.equal((await respond(s, first, 'om')).type, 'model_unavailable');
    await respond(s, 'Sangoota meeqa qaba?', 'om');
    assert.equal(jobs[1].messages[1].content, first);
    assert.ok(!s.modelHistory.some(m => m.role === 'assistant'));
  }
});

test('model context stays session-local and bounded across repeated inference failures', async () => {
  const a = session(), b = session(), jobs = [];
  const respond = await adapter(async job => { jobs.push(structuredClone(job)); return { ok: false, code: 'OFFLINE_MODEL_FAILED' }; });
  for (let n = 0; n < 10; n++) await respond(a, 'x'.repeat(2500) + n, 'om');
  assert.equal(a.modelHistory.length, 6);
  assert.ok(a.modelHistory.every(m => m.content.length === 2000));
  await respond(b, 'Fresh session', 'om');
  assert.equal(jobs.at(-1).messages.length, 2);
});

test('interrupted turns and rejected high-risk assistant text do not enter model history', async () => {
  const s = session();
  const interrupted = await adapter(async () => { s.aiEpoch = 1; return { ok: true, text: 'Valid English script' }; });
  assert.equal((await interrupted(s, 'private input', 'om')).code, 'CALL_INTERRUPTED');
  assert.deepEqual(s.modelHistory, []);
  const risky = await adapter(async () => ({ ok: true, text: 'An unsafe response' }), () => ({ level: 'high' }));
  assert.equal((await risky(s, 'a question', 'om')).code, 'GENERATED_RISK_BLOCKED');
  assert.deepEqual(s.modelHistory, [{ role: 'user', content: 'a question' }]);
  const limited = await adapter(async () => ({ ok: false, code: 'MODEL_CONTEXT_TOO_LONG' }));
  const tooLong = await limited(session(), 'ሀ'.repeat(2000), 'am');
  assert.equal(tooLong.code, 'MODEL_CONTEXT_TOO_LONG');
  assert.match(tooLong.text, /አሳጥረው/);
});

test('product dialogue assembly marks the newest user correction as authoritative', async () => {
  const s = session(), jobs = [];
  const respond = await adapter(async job => { jobs.push(structuredClone(job)); return { ok: true, text: 'መረጃውን ተቀብያለሁ።' }; });
  await respond(s, 'የታችኛው ቅጠል ቢጫ ሆነ። ለሁለት ሳምንት ዝናብ አልዘነበም።', 'am');
  await respond(s, 'የዝናቡን መረጃ አስተካክላለሁ፤ ከሦስት ቀን በፊት ዘንቦ ነበር።', 'am');
  const last = jobs[jobs.length - 1];
  const system = last.messages[0].content;
  const user = last.messages[last.messages.length - 1].content;
  assert.match(system, /LATEST-WINS RULE/);
  assert.match(system, /የቅርብ ጊዜ ማስተካከያ/);
  assert.doesNotMatch(system, /\[CORRECTION\]|\[\d\]/);
  assert.match(system, /ከሦስት ቀን በፊት/);
  assert.match(user, /የቅርብ ጊዜ ማስተካከያ/);
  assert.doesNotMatch(user, /\[CORRECTION\]|\[\d\]/);
  assert.match(user, /ከሦስት ቀን በፊት/);
  assert.ok(last.messages.length >= 3, 'history keeps the earlier user turn');
});
