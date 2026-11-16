// F-22 / R-01..R-05 / R-04 / R-12 / R-37 / CI-01 / CI-14 / VE-01፦ የተሰነዘው ማሳያ በእውነት ይሠራል?
// ደንቡ፦ የክፍል ፍተሻ (unit) ማሽከርከር ብቻ በቂ አይደለም — ገንቢውና የHTTP መንገዶቹ አንድ ላይ መሄድ አለባቸው።
// ሁሉም ጥያቄዎች ወደ 127.0.0.1 ብቻ ናቸው (ኢንተርኔት የለም)፤ የማስረጃ መዝገቡ በጊዝያዊ ፋይል ይታዘዛል።
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asrStatus } from '../app/src/asr.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 8931);
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;
const workDir = mkdtempSync(join(tmpdir(), 'farmerserver-'));

async function call(route, body) {
  const [method, path] = route.split(' ');
  // GET መንገዶቹ ጥያቄውን ከquerystring ያነባሉ (server.mjs) — ስለዚህ session_id እዚህ ይተላለፋል
  const query = method === 'GET' && body ? `?${new URLSearchParams(body)}` : '';
  const res = await fetch(`${BASE}${path}${query}`, method === 'GET'
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const json = await res.json();
  return { status: res.status, gate: res.headers.get('x-farmer-ai-gate'), json };
}

async function waitForReady(attempts = 60) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await call('GET /api/status');
      if (r.status === 200) return r;
    } catch (error) {
      last = error;
    }
    await new Promise((d) => setTimeout(d, 100));
  }
  throw new Error(`G1 ማሳያ ማዳመጥ አልቻልኩም፦ ${last?.message ?? 'no response'}`);
}

before(async () => {
  // የHTTP ዝማኔ ሙከራ በጊዝያዊ ቅጂ ላይ ብቻ ይሠራል — የማከማቻው መዝገብ ደፋር ሆኖ ይቆያል (F-22)
  copyFileSync(join(REPO, 'data', 'knowledge', 'entries.json'), join(workDir, 'entries.json'));
  child = spawn(process.execPath, [join(REPO, 'app', 'server.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      EVIDENCE_PATH: join(workDir, 'server-evidence.jsonl'),
      UPDATE_STATE_DIR: join(workDir, 'update-state'),
      KB_PATH: join(workDir, 'entries.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stderr.inspect = () => stderr;
  try {
    await waitForReady();
  } catch (error) {
    const detail = child.spawnerr?.message ?? child.exitCode ?? 'running';
    throw new Error(`${error.message} (state=${detail} stderr=${stderr.slice(0, 400)})`);
  }
});

after(() => {
  child?.kill();
});

test('VE-01 / R-01፦ ሁኔታው ደህንነት-ተኮር መረጃውን ሳይደብቅ ይሰጣል፣ G1 ወሰኑም ግልጽ ነው', async () => {
  const { status, gate, json } = await call('GET /api/status');
  assert.equal(status, 200);
  assert.equal(gate, 'G1-LAPTOP-ONLY', 'የማሳያው ወሰን በራስ ሰር ይለያል');
  assert.equal(json.offline_by_design, true);
  assert.equal(json.outbound_requests, 0);
  assert.equal(json.server_host, '127.0.0.1');
  assert.ok(json.knowledge.entries > 0, 'የእውቀት መዝገብ ተጭኗል');
  assert.equal(json.knowledge.kb_status, 'DEMO_FIXTURE_UNVERIFIED', 'የናሙና መዝገብ "የተረጋገጠ" አይልም');
  assert.match(json.knowledge.file_sha256, /^[0-9a-f]{64}$/);
  assert.equal(json.asr.network_required, false);
  assert.equal(json.tts.network_required, false);
  assert.equal(json.limits.g4, 'NO-GO');
  assert.equal(json.limits.g2_not_started, 'real phone hardware not tested');
  assert.ok(json.now?.ethiopian, 'የኢትዮጵያ ቀንበር ሁኔታው ውስጥ አለ');
});

test('R-05 / CI-01 / OP-02፦ ክፍት ውይይት፣ ተከታታይ ጥያቄና ያልታወቀ ጥያቄ በHTTP ትክክል ይመልሳሉ', async () => {
  const s = await call('POST /api/session', {});
  assert.match(s.json.session_id, /^sess-/);
  const id = s.json.session_id;

  const first = await call('POST /api/text', { session_id: id, text: 'የበቆሎ ዘር እንዴት ይዘራል' });
  assert.equal(first.json.type, 'answer');
  assert.ok(first.json.claims.length > 0, 'የምንጭ ማስረጃ ከHTTPም ግዴታ ነው');
  assert.ok(Number.isFinite(first.json.metrics.ms), 'የጊዜ ልኬት ተመዝግቧል');

  const second = await call('POST /api/text', { session_id: id, text: 'ተጨማሪ ዝርዝር' });
  assert.equal(second.json.followUp, true, 'የቀድሞ ርዕስ ተይዟል');
  assert.equal(second.json.turn, 2);

  const unknown = await call('POST /api/text', { session_id: id, text: 'የጨረቃ ጉዞ ማረፊያ ጊዜ ስንት ነው' });
  assert.equal(unknown.json.type, 'unknown');
  assert.equal(unknown.json.escalation, 'EXPERT_REFERRAL', 'ያልታወቀ ጥያቄ ወደ ባለሙያ ይመራል፣ አልፎ አልፎ አይፈጥርም');

  const empty = await call('POST /api/text', { session_id: id, text: '   ' });
  assert.equal(empty.json.type, 'clarify');
});

test('R-04 / RU-13 / RG-34-01፦ AI ሳሠራ ጥሪ ሲመጣ ይቀበላል፤ ጥሪ ሳለ AI ይከለከላል፤ ሲደምቀስ AI ይቀጥላል', async () => {
  const id = (await call('POST /api/session', {})).json.session_id;
  const incoming = await call('POST /api/call', { session_id: id, action: 'incoming', from: 'ethio-tele', kind: 'normal' });
  assert.equal(incoming.json.phase, 'RINGING');
  // CallController.incoming() የሚመልሰው preempted/code/snapshot ነው (ai_paused የለም)
  assert.equal(incoming.json.preempted, false, 'AI ስላልሠራ የተቋረጠ ዙር የለም');
  assert.equal(incoming.json.code, 'CALL_ACCEPTED');

  const blocked = await call('POST /api/text', { session_id: id, text: 'የበቆሎ ዘር እንዴት ይዘራል' });
  assert.equal(blocked.json.type, 'blocked');
  assert.equal(blocked.json.code, 'CALL_ACTIVE');

  await call('POST /api/call', { session_id: id, action: 'accept' });
  const ended = await call('POST /api/call', { session_id: id, action: 'end' });
  assert.equal(ended.json.phase, 'IDLE');
  assert.equal(ended.json.resume_requires_consent, false, 'አልተቋረጠም ከሆነ የመቀጠል ፈቃድ አያስፈልግም');
  const resumed = await call('POST /api/text', { session_id: id, text: 'የበቆሎ ዘር እንዴት ይዘራል' });
  assert.equal(resumed.json.type, 'answer', 'ጥሪ ሲደምቀስ AI እንደገና ሊሠራ ይችላል');
});

test('R-04 / RU-13 / F-18፦ AI በንግግር ላይ ሳለ ጥሪ ከመጣ ይቋረጣል፤ መታወቂያው ይጠበቃል፤ በፈቃድ ብቻ ይቀጥላል', async () => {
  const id = (await call('POST /api/session', {})).json.session_id;
  const first = await call('POST /api/text', { session_id: id, text: 'የበቆሎ ዘር እንዴት ይዘራል' });
  assert.equal(first.json.type, 'answer');

  // በእውነተኛ ስልክ AI ራሱ ደረጃውን ይነግራል፤ በG1 ማሳያ ደግሞ አሳሽው ይዘግባል — ማሽከርከር እንጂ MET አይደለም
  const speaking = await call('POST /api/ai/phase', { session_id: id, phase: 'SPEAKING' });
  assert.equal(speaking.json.allowed, true);
  assert.equal(speaking.json.phase, 'SPEAKING');

  const cut = await call('POST /api/call', { session_id: id, action: 'incoming', from: 'ethio-tele', kind: 'emergency' });
  assert.equal(cut.json.preempted, true, 'ጥሪ ቅድሚያ ወሰዶ AIን ቋረጠ (R-04)');
  assert.equal(cut.json.code, 'AI_PREEMPTED');
  // የተቋረጠው ዙር መታወቂያ ከጠፋ መልሶ መቀጠል አይቻልም — F-18ን የሚያረጋግጥ ዋና ነጥብ
  assert.equal(cut.json.snapshot.session_id, id);
  assert.equal(cut.json.snapshot.phase, 'SPEAKING');
  assert.equal(typeof cut.json.snapshot.turn, 'number', 'የተቋረጠው ዙር ቁጥር ተይዟል');
  assert.ok(cut.json.snapshot.topic_id, 'የርዕስ መለያ ተይዟል');

  const during = await call('POST /api/text', { session_id: id, text: 'ተጨማሪ ዝርዝር' });
  assert.equal(during.json.code, 'CALL_ACTIVE');
  const phaseAgain = await call('POST /api/ai/phase', { session_id: id, phase: 'LISTENING' });
  assert.equal(phaseAgain.json.allowed, false, 'ጥሪ ሳለ የAI ደረጃ መጀመር አይፈቀድም');

  const ended = await call('POST /api/call', { session_id: id, action: 'end' });
  assert.equal(ended.json.resume_requires_consent, true, 'AI መልሶ ለመጀመር የተጠቃሚ ውሳኔ ይፈልጋል (F-18)');
  assert.equal(ended.json.snapshot.session_id, id);
  // ተጠቃሚው ራሱ እንደገና ሲጠይቅ ብቻ ይቀጥላል — አይቀጥልም ብሎ ማስተጋባት የለውም
  assert.equal((await call('POST /api/ai/phase', { session_id: id, phase: 'LISTENING' })).json.allowed, true);
  const after = await call('POST /api/text', { session_id: id, text: 'የበቆሎ ዘር ማጓጓዣ' });
  assert.equal(after.json.type, 'answer');

  const bad = await call('POST /api/ai/phase', { session_id: id, phase: 'SLEEPING' });
  assert.equal(bad.json.code, 'BAD_AI_PHASE', 'የማያውቀው የደረጃ ስም 500 ሳይሆን ግልጽ ኮድ ይመልሳል');
});

test('R-37 / R-12 / F-15 / S-5፦ የSMS ንባብ በHTTP ላይም ሁለት ማረጋገጫ ይፈልጋል', async () => {
  const id = (await call('POST /api/session', {})).json.session_id;
  const inbox = await call('GET /api/sms', { session_id: id });
  assert.ok(inbox.json.messages.length > 0);
  assert.equal(inbox.json.permissions.read_aloud, false, 'በነባሪ ፈቃድ የለም');

  const denied = await call('POST /api/sms/read', { session_id: id, id: 'SMS-1001', ai_key: false });
  assert.equal(denied.json.code, 'AI_KEY_REQUIRED');
  const stillDenied = await call('POST /api/sms/read', { session_id: id, id: 'SMS-1001', ai_key: true });
  assert.equal(stillDenied.json.code, 'CONSENT_REQUIRED');

  await call('POST /api/sms/permission', { session_id: id, scope: 'read_aloud', value: true });
  const ok = await call('POST /api/sms/read', { session_id: id, id: 'SMS-1001', ai_key: true });
  assert.equal(ok.json.ok, true);
  // ገጹ የሚያነበው መስክ በAPI ላይ መኖር አለበት — spoken ሳይሆን text ብሎ መጠየቅ የተሳሳተ ጽሑፍ ያሳያል
  assert.ok(ok.json.spoken, 'የተነበበው ይዘት በspoken ይመለሳል');
  const listed = await call('GET /api/sms', { session_id: id });
  for (const m of listed.json.messages) {
    for (const key of ['id', 'sender_label', 'category', 'otp', 'trusted_source', 'preview']) {
      assert.ok(key in m, `የደንበኛ ሰንጠረዥ የሚጠይቀው መስክ ጎድሏል፦ ${key}`);
    }
  }

  const extract = await call('POST /api/sms/extract', { session_id: id, id: 'SMS-1004' });
  assert.equal(extract.json.code, 'KNOWLEDGE_CONSENT_REQUIRED', 'የንባብ ፈቃድ ለእውቀት ማከማቸት አይበቃም');
});

test('F-12 / R-08 / NR-07፦ የFM ማስመሰያ ሲገባ ወቅታዊነትና ግጭት በማስረጃ ይታያል', async () => {
  const id = (await call('POST /api/session', {})).json.session_id;
  const stations = await call('GET /api/fm', { session_id: id });
  assert.ok(stations.json.stations.length > 0);
  assert.match(stations.json.hardware_note, /G2/, 'የG1 ማስመሰያ መሆኑ በግልጽ ተነግሯል');
  // ዳሰቢው የሚያወጣው ስም (frequency_mhz/language) በHTTPም ተመሳሳይ መሆን አለበት — የተጠባበቁ ስሞች "undefined" ይፈጥራሉ
  assert.ok(stations.json.stations[0].frequency_mhz > 0, 'የሬዲዮ ድግግሚሽ ተከታትያው ዳሰቢውን ይከተላል');
  assert.ok(stations.json.stations[0].language, 'የቋንቋ መለያ ካለ');

  const station = stations.json.stations[0];
  const ingest = await call('POST /api/fm/ingest', {
    session_id: id,
    station_id: station.id,
    text: 'የነጭ ሽንፈር ዋጋ ኪሎ 14,500 ብር ሆኗል።',
    topic_id: 'market_price',
    // FmAdapter.ingest() የሚያነበው captured_at ነው — ሌላ ስም ከተላከ ግዙፍ የጊዜ ልዩነት በዝግታ አይጠፋም
    captured_at: '2026-10-01T09:00:00.000Z',
  });
  assert.equal(ingest.json.ok, true);
  assert.equal(typeof ingest.json.ms, 'number');
  assert.ok(Array.isArray(ingest.json.conflicts), 'የግጭት ፍተሻ ይመለሳል');
  assert.equal(ingest.json.claim.stale, true, 'ያለፈበት ጊዜ የባለው ማስታወሻ ወቅታዊ አይደለም ብሎ ይመዘገባል');
  assert.equal(ingest.json.claim.execution_allowed, false, 'የሬዲዮ ይዘት ትዕዛዝ አይሆንም');

  // ጽሑፍና ናሙና ሳይኖር "undefined" የሚል የተሳሳተ ግቤት አይፈጠርም
  const nothing = await call('POST /api/fm/ingest', { session_id: id, station_id: station.id });
  assert.equal(nothing.json.ok, false);
  assert.equal(nothing.json.code, 'BROADCAST_TEXT_REQUIRED');

  // ደረጃው ባለው ናሙና ማስታወሻ መዝገብ ይገባል (የተጠቃሚው "ፕሮግራም ተቀብል" ይህንኑ ይጠቀማል)
  const fixtureId = stations.json.broadcasts[0].id;
  const fromFixture = await call('POST /api/fm/ingest', { session_id: id, station_id: station.id, broadcast_id: fixtureId });
  assert.equal(fromFixture.json.ok, true);
  assert.notEqual(fromFixture.json.claim.text, 'undefined');
  assert.ok(fromFixture.json.claim.text.length > 10, 'የናሙናው ማስታወሻ ጽሑፍ ይወረሳል');
});

test('R-37 / CI-06 / VE-01፦ ፈቃድ በአንድ ክፍለ-ጊዜ ላይ ሲሰጣት በGET መልሶ ሲነበብ ይዛመዳል', async () => {
  const id = (await call('POST /api/session', {})).json.session_id;
  assert.equal((await call('GET /api/sms', { session_id: id })).json.permissions.read_aloud, false);
  await call('POST /api/sms/permission', { session_id: id, scope: 'read_aloud', value: true });
  const again = await call('GET /api/sms', { session_id: id });
  assert.equal(again.json.session_id, id, 'የተጠየቀው ክፍለ-ጊዜውኑ መሆን አለበት');
  assert.equal(again.json.permissions.read_aloud, true, 'ፈቃድ በተመሳሳይ ክፍለ-ጊዜ ላይ ተመዝግቧል');
});

test('CI-01 / VE-01 / F-22፦ የደንበኛ ገጹ የሚጠራው እያንዳንዱ መንገድ በሰርቨሩ ላይ ተመዝግቧል', async () => {
  // ይህ የጉድለት ዘር ሙከራ ነው፦ ገጹ POST /api/fm ጠርቶ ሰርቨሩ GET ብቻ ስለነበር ማሳያው በዝግታ ተበላሽቷል
  const page = readFileSync(join(REPO, 'app', 'public', 'index.html'), 'utf8');
  const routes = readFileSync(join(REPO, 'app', 'server.mjs'), 'utf8');
  const clientCalls = [...page.matchAll(/(get|post)\('(\/api\/[^']+)'/g)]
    .map((m) => ({ method: m[1].toUpperCase(), path: m[2] }));
  assert.ok(clientCalls.length >= 12, 'የደንበኛ ጥሪዎች ተገኝተዋል');
  const registered = new Set([...routes.matchAll(/'(GET|POST) (\/api\/[^']+)'/g)].map((m) => `${m[1]} ${m[2]}`));
  for (const c of clientCalls) {
    assert.ok(registered.has(`${c.method} ${c.path}`), `መንገድ ላለመመዝገቡ 404፦ ${c.method} ${c.path}`);
  }
});

test('F-15 / R-14 / R-19፦ የተፈረመ ዝማኔ በHTTP ማረጋገጥ ይችላል፤ ማረጋገጥ ብቻ መዝገብን አይቀይርም', async () => {
  const env = JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures', 'updates', 'valid-delta.json'), 'utf8'));
  const verified = await call('POST /api/update', { action: 'verify', envelope: env });
  assert.equal(verified.json.ok, true, `ማረጋገጥ አልተሳካም፦ ${verified.json.code}`);
  assert.equal(verified.json.code, 'VERIFIED');

  const stateBefore = await call('POST /api/update', { action: 'state' });
  assert.equal(stateBefore.json.installed_version, null, 'verify ራሱ አይተገብርም');

  const bad = JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures', 'updates', 'tamper-signature.json'), 'utf8'));
  const rejected = await call('POST /api/update', { action: 'verify', envelope: bad });
  assert.equal(rejected.json.ok, false);
  assert.equal(rejected.json.code, 'SIGNATURE_INVALID');
});

test('F-22 / NR-05፦ በHTTP የተሠራ ዝማኔ የማከማቻውን መዝገብና የማሽኑን ሁኔታ አይነካም (isolation)', async () => {
  const tracked = readFileSync(join(REPO, 'data', 'knowledge', 'entries.json'), 'utf8');
  const env = JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures', 'updates', 'valid-delta.json'), 'utf8'));
  const applied = await call('POST /api/update', { action: 'apply', envelope: env });
  assert.equal(applied.json.code, 'APPLIED', `ዝማኔው በጊዝያዊ ቅጂ ላይ መተገበር አለበት፦ ${applied.json.code}`);

  const tempKb = JSON.parse(readFileSync(join(workDir, 'entries.json'), 'utf8'));
  assert.ok(tempKb.entries.some((e) => e.claim_id === 'claim-fixture-teff-price'), 'የናሙና መዝገብ ገጽባቄው በቅጂው ላይ ታይቷል');
  assert.equal(readFileSync(join(REPO, 'data', 'knowledge', 'entries.json'), 'utf8'), tracked, 'የማከማቻው ዋና መዝገብ ደነጭጭቆ ነው');
  assert.ok(existsSync(join(workDir, 'update-state', 'state.json')), 'የዝማኔ ሁኔታ በጊዝያዊ ማሰባሰቢያ ውስጥ ተቀምጧል');
  assert.equal(existsSync(join(REPO, 'data', 'updates', 'state.json')), false, 'የማሽኑ ሁኔታ በሙከራ አልተበላሸም');

  const after = await call('POST /api/update', { action: 'apply', envelope: env });
  assert.equal(after.json.code, 'REPLAY_DUPLICATE_ID', 'ተመሳሳይ ዝማኔ ሁለት ጊዜ አይተገበርም (anti-rollback/replay)');
});

// በG1 በእውነተኛ ሩጫ ሲገኝ የተዘጋ ጉድለት (F-22/NR-05/R-14)፦ KB_PATH ሳይገለጽ ሲሮጥ የተተገበረው ዝማኔ
// የGit-ተከታታይ መሠዊያ መዝገቡን (ሃሹ በመዝገቡ §10 ላይ የተመዘገበ) በእውነት መተካቱ ነበር። አሁን
// ወደ ማሽኑ-ዕጣት ቅጂ (applied/) ይሄዳል፤ መሠዊያው ንባብ ብቻ ነው።
test('F-22 / NR-05 / R-14፦ KB_PATH በኋላ ሳይገለጽ የተሠራ ዝማኔ የመሠዊያ መዝገቡን ፈጽሞ አይነካም', async () => {
  const baselinePath = join(REPO, 'data', 'knowledge', 'entries.json');
  const before = readFileSync(baselinePath, 'utf8');
  const soloDir = mkdtempSync(join(tmpdir(), 'farmerruntime-'));
  const soloPort = PORT + 1;
  const solo = spawn(process.execPath, [join(REPO, 'app', 'server.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(soloPort),
      HOST: '127.0.0.1',
      EVIDENCE_PATH: join(soloDir, 'events.jsonl'),
      UPDATE_STATE_DIR: join(soloDir, 'update-state'),
      // KB_PATH ያለበት አይደለም — የነባሪው (default) መንገድ የሚፈተሸው ይህ ነው
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    const soloCall = async (path, body) => {
      const res = await fetch(`http://127.0.0.1:${soloPort}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, json: await res.json() };
    };
    const envelope = JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures', 'updates', 'valid-delta.json'), 'utf8'));
    let applied = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        applied = await soloCall('/api/update', { action: 'apply', envelope });
        break;
      } catch {
        await new Promise((d) => setTimeout(d, 100));
      }
    }
    assert.ok(applied, 'የነባሪ-ማዋቀር ማሳያ ማዳመጥ አልቻለም');
    assert.equal(applied.json.code, 'APPLIED');
    assert.equal(readFileSync(baselinePath, 'utf8'), before, 'የመሠዊያው መዝገብ ቃል በቃል ደነጭጭቆ መቆየት አለበት');
    const runtimeKb = JSON.parse(readFileSync(join(soloDir, 'update-state', 'applied', 'entries.json'), 'utf8'));
    assert.ok(
      runtimeKb.entries.some((e) => e.claim_id === 'claim-fixture-teff-price'),
      'የተተገበረው ዝማኔ በዕጣት-ውስጥ ቅጂ ላይ ታይቷል',
    );
    assert.equal(runtimeKb.kb_version, envelope.payload.kb_version, 'ቅጂው የተተገበረውን ዕርጅት ይዞ ነው');
    assert.equal(existsSync(join(soloDir, 'update-state', 'state.json')), true, 'የዕጣት ሁኔታ በተናጠል ማሰባሰቢያ ተቀምጧል');
  } finally {
    solo.kill();
    await new Promise((r) => solo.on('exit', r));
  }
});

test('R-03 / F-08፦ የTTS መንገድ ያልተጫነ ድም፽ "ተሳካ" አያልም፤ ያለ ከሆነ WAV ይመልሳል', async () => {
  const am = await call('POST /api/tts', { text: 'የገበያ ዋጋ', locale: 'am' });
  assert.ok(['SYNTHESIZED', 'NO_LOCAL_VOICE', 'SAPI_WINDOWS_ONLY', 'SAPI_QUERY_FAILED'].includes(am.json.code), am.json.code);
  if (!am.json.ok) assert.match(am.json.note, /REQUIRES EVIDENCE/, 'የድምጽ ማረጋገጫ ያልተሰጠው መሆኑ በማስረጃ ተገልጿል');

  const empty = await call('POST /api/tts', { text: '', locale: 'am' });
  assert.equal(empty.json.code, 'EMPTY_TEXT');
});

test('R-02 / F-08፦ ASR ሳይኖር የHTTP መንገዱ ወደ ጽሑፍ አማራጭ ይመራል (no fake transcript)', async () => {
  const id = (await call('POST /api/session', {})).json.session_id;
  const tiny = await call('POST /api/audio', { session_id: id, wav_base64: 'aGVsbG8=', locale: 'am' });
  assert.equal(tiny.json.code, 'AUDIO_TOO_SMALL', 'በጣም ትንሽ ድምጅ ውሂብ አይፈጥርም');

  // ትክክለኛና ድምፅ ያለው ናሙና — የግብይት ጥበቃውን አልፎ "ኢንጂን የለም" ቅርንጫፉ እንዲደረስ ይህ ያስፈልጋል
  const frames = 8000;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + frames * 2, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) wav.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * (220 * i + 0.02 * i * i)) / 16000)), 44 + i * 2);
  const r = await call('POST /api/audio', {
    session_id: id,
    wav_base64: wav.toString('base64'),
    locale: 'am',
    asr_bin: join(workDir, 'definitely-not-installed.exe'),
    asr_model: join(workDir, 'definitely-not-installed.bin'),
  });
  assert.equal(r.json.type, 'asr_unavailable');
  assert.equal(r.json.code, 'ASR_NOT_INSTALLED');
  assert.equal(r.json.transcript, undefined, 'ያልተጫነ ኢንጂን የተፈጠረ ጽሑፍ የለም');
  assert.equal(r.json.next.ask_text, true, 'ወደ ጽሑፍ አማራጭ ይመራል');
});

test('R-02 / F-08 / CI-03፦ ኢንጂኑ ተጭኖ ሲገኝ የHTTP ድምፅ መንገዱ አልፎ አልፎ አይሆንም (500 የለም)', async () => {
  // ቀደም ሲል የHTTP ፍተሻ "ያልተጫነ" አቅጣጫ ብቻ ነበረው — ዝግጁ መንገዱ ላይ የተሰበረው argv ስለዚህ ለቋል።
  const st = asrStatus();
  if (!st.ready) {
    assert.ok(true, 'ASR በዚህ ማሽን ላይ ዝግጁ አይደለም — ፍተሻው ያለ ማስረጃ ቀርቷል (GAP / REQUIRES EVIDENCE)');
    return;
  }
  const frames = 8000; // 0.5s @16kHz mono
  const buildWav = (tone) => {
    const wav = Buffer.alloc(44 + frames * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + frames * 2, 4); wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
    // ድምፅ ያለው ናሙና የግብይት ጥበቃውን አልፎ እስከኢንጂኑ መንገድ ይደርሳል — የፍተሻው ዓላማ ይህ ነው
    if (tone) {
      for (let i = 0; i < frames; i += 1) wav.writeInt16LE(Math.round(tone * Math.sin((2 * Math.PI * 440 * i) / 16000)), 44 + i * 2);
    }
    return wav.toString('base64');
  };

  const id = (await call('POST /api/session', {})).json.session_id;
  const r = await call('POST /api/audio', { session_id: id, wav_base64: buildWav(9000), locale: 'am' });
  assert.ok(r.status < 500, `የASR መንገዱ ሰብሟል፦ ${JSON.stringify(r.json).slice(0, 200)}`);
  assert.notEqual(r.json.type, 'no_input', `ድምፅ ባለው ናሙና የዝግ ጥበቃ አይቀርፕም (${r.json.code})`);
  if (r.json.type === 'asr_unavailable') {
    assert.ok(['ASR_FAILED', 'ASR_TIMEOUT', 'ASR_SPAWN_FAILED', 'ASR_LOCALE_UNSUPPORTED', 'AUDIO_NOT_FOUND'].includes(r.json.code), r.json.code);
    assert.equal(r.json.transcript, undefined, 'ያልተከናወነ ትርጓሜ ጽሑፍ የለም');
  } else if (r.json.type === 'no_speech') {
    assert.ok(['EMPTY_TRANSCRIPT', 'AUDIO_TOO_SHORT', 'NON_SPEECH_CAPTURE', 'NO_VALID_UTTERANCE'].includes(r.json.code), r.json.code);
    assert.equal(r.json.transcript, undefined);
  } else {
    assert.equal(typeof r.json.transcript, 'string');
    assert.match(r.json.transcript, /[\p{L}\p{N}]/u, 'ወደ AI የደረሰው ጽሑፍ ቢያንስ አንድ ቃል አለው');
  }

  // የዝግ ግብይት ጥበቃ በHTTP ላይም ተመሳሳይ ግልጽ ኮድ መመለስ አለበት — ኢንጂኑ ሳይነሳ (F-08)
  const z = await call('POST /api/audio', { session_id: id, wav_base64: buildWav(0), locale: 'am' });
  assert.ok(z.status < 500, 'የጥበቃ መንገዱ 500 አይሆንም');
  assert.equal(z.json.type, 'no_input', 'ዝግ ግብይት "ኢንጂን የለም" ሳይሆን "ድምፅ አልደረሰም" ይባላል');
  assert.equal(z.json.code, 'SILENT_CAPTURE');
  assert.equal(z.json.audio.peak, 0, 'የተመዘገበው ልኬት ለማስረጃ ተገልጿል');
  assert.match(z.json.text, /ማይክ/, 'የተጠቃሚ ምክሩ የመሣሪያ ችግኙን ይገልጻል');
  assert.equal(z.json.next.ask_text, true, 'ወደ ጽሑፍ አማራጭ ይመራል');
});

test('R-38 / F-11 / CI-14፦ የማስረጃ ሰለባና የሀብት ልኬት በHTTP ተገኝተው ያገለግላሉ', async () => {
  const id = (await call('POST /api/session', {})).json.session_id;
  for (const text of ['የበቆሎ ዘር እንዴት ይዘራል', 'የእንስሳት መጠጫ ውሃ ስንት ጊዜ ነው', 'ተጨማሪ ዝርዝር']) {
    await call('POST /api/text', { session_id: id, text });
  }
  const chain = await call('GET /api/evidence');
  assert.equal(chain.json.chain.ok, true, `የማስረጃ ሰለባ ፈርሷል፦ ${chain.json.chain.code}`);
  assert.ok(chain.json.count >= 5);

  const metrics = await call('GET /api/metrics');
  assert.ok(metrics.json.text_turn_ms.n >= 3, 'የጥያቄ ፍጥነት ተልኯያል');
  assert.ok(Number.isFinite(metrics.json.text_turn_ms.p95));
  assert.ok(metrics.json.process.rss_mb > 0);
});

test('VE-01 / CI-01፦ የደምቦ ገጹ ይሰጣል፣ ያልታወቀ መንገድ 404/NO_ROUTE ይመልሳል', async () => {
  const page = await fetch(`${BASE}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<html/i);
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/i.test(html.replace(/xmlns="[^"]*"/g, '')), 'የደምቦ ገጽ ውጭ አድራሻ የለውም');

  const missing = await fetch(`${BASE}/api/definitely-not-here`, { method: 'POST', body: '{}' });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'NO_ROUTE');
});

test('R-12 / RU-08 / CI-01፦ የምንጭ መስኮች በAPIና በገጹ መካከ ይዛመዳሉ', async () => {
  // የጉድለት ዘሩ፦ ገጹ ያልተመዘገበ መስክ ሲጠይቅ ማሳው በዝግታ [—/—] ያሳያል — የምንጭ ማረጋገጫ ግን ግዴታ ነው
  const id = (await call('POST /api/session', {})).json.session_id;
  const { json } = await call('POST /api/text', { session_id: id, text: 'የበቆሎ ዘር እንዴት ይዘራል' });
  assert.ok(json.claims.length > 0, 'ለHTTP መልስ የምንጭ ዝርዝር አለ');
  const claim = json.claims[0];
  for (const key of ['claim_id', 'captured_at', 'valid_until', 'risk_level', 'verification']) {
    assert.ok(key in claim, `የclaim መስክ ጎድሏል፦ ${key}`);
  }
  for (const key of ['kind', 'id', 'captured_at', 'license_scope']) {
    assert.ok(key in claim.source, `የclaim.source መስክ ጎድሏል፦ ${key}`);
  }
  const page = readFileSync(join(REPO, 'app', 'public', 'index.html'), 'utf8');
  assert.match(page, /c\.source \?\? \{\}/, 'ገጹ የምንጩን ዝርዝር በተመዘገበው nested ቅርጸት ያነባል');
  assert.ok(!/source_kind|source_id/.test(page), 'ገጹ በAPI ላይ ያልተመዘገቡ መስኮችን አይጠይቅም');
});

test('R-14 / F-20 / F-22 / CI-01፦ የናሙና ዝርዝር በHTTP ላይ ነው፤ የተጠበቀ ውጤቱ ከማኒፌስት ይዛመዳል', async () => {
  const listed = await call('GET /api/update/samples');
  assert.equal(listed.status, 200);
  const names = listed.json.samples.map((s) => s.name);
  assert.ok(!names.includes('MANIFEST.json'), 'ማኒፌስት ናሙና ተብሎ አይቀርጥም');
  const manifest = JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures', 'updates', 'MANIFEST.json'), 'utf8'));
  for (const c of manifest.cases) {
    const found = listed.json.samples.find((s) => s.name === c.file);
    assert.ok(found, `የማኒፌስት ናሙና በዝርዝሩ ላይ የለም፦ ${c.file}`);
    assert.equal(found.expected, c.expect_ok ? 'ACCEPTED' : 'REJECTED', `${c.file} — የተጠበቀው ውጤት ሌላ ተናግሯል`);
    assert.equal(found.expected_code, c.expect_code, `${c.file} — የተጠበቀው ኮድ አልተመዘገበም`);
  }
  const picked = await call('GET /api/update/sample', { name: 'tamper-payload.json' });
  assert.equal(picked.json.ok, true);
  assert.match(picked.json.envelope.update_id, /^upd-/);

  const before = await call('GET /api/status');
  const verify = await call('POST /api/update', { action: 'verify', envelope: picked.json.envelope });
  assert.equal(verify.json.ok, false, 'የተሳሳተ payload ፊርማ ማለፊያ የለም');
  assert.equal(verify.json.code, 'PAYLOAD_HASH_MISMATCH');
  const after = await call('GET /api/status');
  assert.equal(after.json.updates.installed_version, before.json.updates.installed_version, 'ማረጋገጥ ብቁ መዝገብን አይቀይርም');
  assert.equal(after.json.knowledge.file_sha256, before.json.knowledge.file_sha256, 'የእውቀት መዝገብ ሃሽ ለውጥ የለም');

  // path traversal፦ ደብተር ውጪ ያለ ፋይል በስም መጠየግ አይቻልም
  for (const bad of ['../../package.json', '..%2F..%2Fpackage.json', 'keys.json/', '']) {
    const r = await call('GET /api/update/sample', { name: bad });
    assert.equal(r.json.code, 'SAMPLE_NOT_FOUND', `አደገኛ ስም ተቀብሏል፦ ${bad}`);
  }
});

test('F-07/NR-01፦ ያልተመዘገበ session_id ሲመጣ አዲስ ክፍለ-ጊዜ በዝግታ አይፈጠርም — 409 SESSION_UNKNOWN', async () => {
  const before = (await call('GET /api/metrics')).json.sessions.active;
  const r = await call('POST /api/text', { session_id: 'sess-unknown-xyz', text: 'የበቆሎ ዘር እንዴት ይዘራል' });
  assert.equal(r.status, 409, 'ያልታወቀ ክፍለ-ጊዜ ግልጽ ውድቀት መመለስ አለበት');
  assert.equal(r.json.code, 'SESSION_UNKNOWN');
  assert.equal(r.json.next.new_session, 'POST /api/session', 'ደንበኛው ሊከተለው የሚገባው መንገድ ተነግሯል');
  const after = (await call('GET /api/metrics')).json.sessions.active;
  assert.equal(after, before, 'ያልታወቀ መለያ ማድጊያ (session) ሊፈጥር አይገባም — F-07 የአድላ ጉዳት');
});

test('F-07/NR-01፦ የክፍለ-ጊዜ ብዛት ወሰን አለው፤ ከወሰን በላይ ቢያንስ-የተጠቀመው ይወገዳል', async () => {
  const limits = (await call('GET /api/metrics')).json.sessions;
  assert.ok(Number.isInteger(limits.max_sessions) && limits.max_sessions > 0, 'የክፍለ-ጊዜ ወሰን ተመዝግቧል');
  const ids = [];
  for (let i = 0; i < limits.max_sessions + 4; i += 1) ids.push((await call('POST /api/session', {})).json.session_id);
  const now = (await call('GET /api/metrics')).json.sessions;
  assert.ok(now.active <= limits.max_sessions, `ያለ ገደብ አደለ፦ active=${now.active} > limit=${limits.max_sessions}`);
  assert.ok(now.sessions_evicted >= 4, `ከወሰን በላይ የተፈጠሩት ማስወገድ ይጠበቅ ነበር፦ ${now.sessions_evicted}`);
  const rejected = await call('POST /api/text', { session_id: ids[0], text: 'የበቆሎ ዘር እንዴት ይዘራል' });
  assert.equal(rejected.json.code, 'SESSION_UNKNOWN', 'የተወገደ ክፍለ-ጊዜ ግልጽ ውድቀት መመለስ አለበት');
  const alive = await call('POST /api/text', { session_id: ids[ids.length - 1], text: 'የበቆሎ ዘር እንዴት ይዘራል' });
  assert.equal(alive.status, 200, 'የቅርቡ ክፍለ-ጊዜ ሥራ ላይ መሆን አለበት');
});

test('F-07/F-11፦ የተከታታይ ውይይት ታሪክና የልኬት ናሙና ወሰን አላቸው (memory growth የለም)', async () => {
  const limits = (await call('GET /api/metrics')).json.sessions;
  assert.ok(Number.isInteger(limits.max_session_history) && limits.max_session_history > 8, 'የታሪክ ወሰን ተመዝግቧል');
  assert.ok(Number.isInteger(limits.max_latency_samples), 'የልኬት ናሙና ወሰን ተመዝግቧል');
  const id = (await call('POST /api/session', {})).json.session_id;
  for (let i = 0; i < limits.max_session_history + 10; i += 1) {
    const r = await call('POST /api/text', { session_id: id, text: i % 2 ? 'ተጨማሪ ዝርዝር' : 'የበቆሎ ዘር እንዴት ይዘራል' });
    assert.equal(r.status, 200, `ዙር ${i} ወደቀ`);
  }
  const now = (await call('GET /api/metrics')).json.sessions;
  assert.ok(now.history_max <= limits.max_session_history, `ታሪክ ከወሰን በላይ አደለ፦ ${now.history_max}`);
  assert.ok(now.history_records >= 1, 'የተራሉ ታሪክ መዝገቦች ተቆጥረዋል');
  const turns = (await call('GET /api/metrics')).json.text_turn_ms.n;
  assert.ok(turns <= limits.max_latency_samples, `የልኬት ናሙና ከወሰን በላይ አደለ፦ ${turns}`);
});


test('Issue #6: HTTP pure tone returns no_speech without advancing dialogue or speech latency', async () => {
  const id = (await call('POST /api/session', {})).json.session_id;
  const before = (await call('GET /api/metrics')).json;
  const n=16000, wav=Buffer.alloc(44+n*2);
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(n*2,40);
  for(let i=0;i<n;i++)wav.writeInt16LE(Math.round(9000*Math.sin(2*Math.PI*440*i/16000)),44+2*i);
  const result=(await call('POST /api/audio',{session_id:id,locale:'am',wav_base64:wav.toString('base64')})).json;
  assert.equal(result.type,'no_speech');assert.equal(result.code,'NON_SPEECH_CAPTURE');assert.equal(result.transcript,undefined);
  const after=(await call('GET /api/metrics')).json;
  assert.deepEqual(after.asr_ms,before.asr_ms);
  assert.equal(result.turn,undefined);
});
