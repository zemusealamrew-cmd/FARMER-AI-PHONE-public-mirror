import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SmsGateway } from '../app/src/sms.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = join(REPO, 'data', 'sms', 'inbox.json');

const fresh = () => new SmsGateway(INBOX);

test('R-37 / S-5፦ ንባብ ሁለት ማረጋገጫ ይፈልጋል — የAI ቁልፍና ፈቃድ', () => {
  const g = fresh();
  const noKey = g.read('SMS-1001', { aiKey: false });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.code, 'AI_KEY_REQUIRED');

  const keyNoConsent = g.read('SMS-1001', { aiKey: true });
  assert.equal(keyNoConsent.ok, false);
  assert.equal(keyNoConsent.code, 'CONSENT_REQUIRED');

  g.setPermission('read_aloud', true);
  const ok = g.read('SMS-1001', { aiKey: true });
  assert.equal(ok.ok, true, 'ቁልፍ + ፈቃድ ሲኖር ንባብ ይፈቀዳል');
});

test('R-37 / F-15፦ የመረጃ አጠቃቀም ፈቃድ ከንባብ ፈቃድ ጭምብል አይደለም (separate scopes)', () => {
  const g = fresh();
  g.setPermission('read_aloud', true);
  const extracted = g.extractKnowledge('SMS-1004');
  assert.equal(extracted.ok, false, 'ንባብ ፈቃድ ብቻ ለእውቀት መከማቸት አይበቃም');
  assert.equal(extracted.code, 'KNOWLEDGE_CONSENT_REQUIRED');

  g.setPermission('knowledge_use', true);
  const still = g.extractKnowledge('SMS-1004');
  assert.equal(still.ok, false, 'የማከማቸት ፈቃድ ግዴታ ነው');

  g.setPermission('storage', true);
  const now = g.extractKnowledge('SMS-1004');
  assert.equal(now.ok, true);
  assert.equal(now.claim.source_kind, 'sms');
  assert.equal(now.claim.execution_allowed, false, 'የSMS ይዘት ለፈጸም ትዕዛዝ አይሆንም');
  assert.equal(now.claim.trust, 'untrusted', 'ያልታመነ ምንጭና ትእዛዝ ያለው መልዕክት untrusted ይሆናል');
});

test('R-37 / LC-08፦ OTP ፈቃድ ቢኖርም በድምፅ አይነበብም', () => {
  const g = fresh();
  g.setPermission('read_aloud', true);
  g.setPermission('personal', true);
  const otp = g.messages.find((m) => m.otp);
  const r = g.read(otp.id, { aiKey: true });
  assert.equal(r.ok, true);
  assert.equal(r.protected, true);
  assert.equal(r.content, null);
  assert.ok(!JSON.stringify(r).includes('482913'), 'የOTP ቁጥር ምንም አይነት ውጤት ላይ የለውም');

  g.setPermission('knowledge_use', true);
  g.setPermission('storage', true);
  const extract = g.extractKnowledge(otp.id);
  assert.equal(extract.code, 'OTP_EXCLUDED');
});

test('F-13 / R-24፦ ማይታመን መልዕክት ቢነበብም ትእዛዙ አይፈጸምም (action_taken = NONE)', () => {
  const g = fresh();
  g.setPermission('read_aloud', true);
  const injected = g.messages.find((m) => /money|ብር|ignore/i.test(m.body));
  assert.ok(injected, 'የማስገባት ሙከራ ናሙና መኖር አለበት');
  const r = g.read(injected.id, { aiKey: true });
  assert.equal(r.ok, true);
  assert.equal(r.action_taken, 'NONE');
  assert.equal(r.untrusted, true);
  assert.ok(r.warning, 'ተጠቃሚው ማስጠንቀቂያ መሰማት አለበት');
  assert.match(r.warning, /አትላኩ|አታጋሩ|hin ergin|hin qoodin/);
});

test('F-15 / R-37 / OP-08፦ ፈቃድ መሻር የተሠራ ውጤቶችን ማጥፋት አለበት (revocation wipe)', () => {
  const g = fresh();
  const events = [];
  g.onEvent = (e, d) => events.push([e, d]);
  g.setPermission('storage', true);
  g.setPermission('storage', false);
  const wipe = g.events.filter((e) => e.event === 'derived_data_wiped');
  assert.equal(wipe.length, 1, 'የማከማቸት ፈቃድ ሲወገድ ማጥፋት ተመዝግቧል');
  assert.equal(wipe[0].detail.scope, 'storage');
});

test('R-26 / F-16፦ የግል መልዕክት ለነባሪ ዝርዝር ሳይሆን ለየብቻ ፈቃድ ይፈልጋል', () => {
  const g = fresh();
  g.setPermission('read_aloud', true);
  const personal = g.messages.find((m) => m.personal && !m.otp);
  assert.ok(personal, 'የግል ናሙና መኖር አለበት');
  const denied = g.read(personal.id, { aiKey: true });
  assert.equal(denied.code, 'PERSONAL_SCOPE_REQUIRED');
  assert.equal(denied.ok, false);
  g.setPermission('personal', true);
  assert.equal(g.read(personal.id, { aiKey: true }).ok, true);
});

test('F-20 / R-36፦ በናሙና ላይ ያሉ ልሙድ ቅሪቶች አይደገሙም (preview masking)', () => {
  const g = fresh();
  const rows = g.list();
  const otpRow = rows.find((r) => r.otp);
  assert.equal(otpRow.preview, '••••', 'ዝርዝር ላይ OTP አይታይም');
  const personalRow = rows.find((r) => r.personal && !r.otp);
  if (personalRow) assert.equal(personalRow.preview, 'የግል መልዕክት');
});

// R-37 / OP-14 / RG-34-08: actual derived purging on consent revocation (not just an event log).
test('SMS consent revocation actually removes derived claims and blocks re-extraction', () => {
  const g = fresh();
  g.setPermission('knowledge_use', true);
  g.setPermission('storage', true);
  const extracted = g.extractKnowledge('SMS-1004');
  assert.equal(extracted.ok, true);
  assert.equal(g.derivedClaims.length, 1, 'derived claim is retained while consent is active');
  const revoked = g.setPermission('storage', false);
  assert.equal(revoked.wiped, 1, 'revocation reports the removed claim count');
  assert.equal(g.derivedClaims.length, 0, 'derived claim is gone after revocation');
  const after = g.extractKnowledge('SMS-1004');
  assert.equal(after.ok, false);
  assert.equal(after.code, 'KNOWLEDGE_CONSENT_REQUIRED', 'storage consent is still off');
});
