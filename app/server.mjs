import { inspectGeneratedReply } from './src/generation-guard.mjs';
import { offlineModelsEnabled, offlineModelStatus, runOfflineModel, stopOfflineWorker } from './src/offline-models.mjs';
import { classifyRisk } from './src/safety.mjs';
import { inspectSpeechSignal } from './src/speech-presence.mjs';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeBase } from './src/knowledge.mjs';
import { Dialogue } from './src/dialogue.mjs';
import { dialogueSystemPrompt } from './src/dialogue_prompt.mjs';
import { conversationFacts, factsReminder } from './src/dialogue_facts.mjs';
import { SmsGateway } from './src/sms.mjs';
import { FmAdapter } from './src/fm.mjs';
import { AI_PHASES, CallController } from './src/call.mjs';
import { UpdateService } from './src/update.mjs';
import { asrStatus, inspectWav, transcribe } from './src/asr.mjs';
import { ttsStatus, synthesize } from './src/tts.mjs';
import { EvidenceLog, measure, percentile, resourceSnapshot } from './src/evidence.mjs';
import { describeNow } from './src/etime.mjs';
import { newId, nowIso, sha256 } from './src/util.mjs';

const APP = dirname(fileURLToPath(import.meta.url)); // …/repo/app
const REPO = resolve(APP, '..'); // …/repo — የመረጃና ማስታወሻ ደብተሮች እዚህ ናቸው
const PUB = join(APP, 'public');
const TMP = join(APP, '.tmp');
mkdirSync(TMP, { recursive: true });

const PORT = Number(process.env.PORT ?? 8710);
const HOST = process.env.HOST ?? '127.0.0.1';
const AI_PHASE_VALUES = new Set(Object.values(AI_PHASES));

// UPDATE_STATE_DIR፦ የዝማኔ ሁኔታና መቆራረጥ በተናጠል ማሰባሰቢያ ሊከወኑ ይችላሉ — ሙከራ የማሽኑን ሁኔታ አይበላሸም (F-22)
const UPDATE_STATE_DIR = process.env.UPDATE_STATE_DIR ?? join(REPO, 'data', 'updates');

// F-22 / NR-05 / R-14፦ የተተገበረው ዝማኔ የGit-ተከታታይ የመሠዊያ መዝገቡን አይቀይርም። በG1 ላይ
// መሠዊያው በማከማቻ ውስጥ ስለሆነ (እና ሃሹ በመዝገቡ §10 ላይ ስለተመዘገበ) አንድ ዴሞ ዝማኔ ሲተገበር
// ማስረጃው ዋጋ ያጣለትና የፍተሻዎቹ መሠረት ይበላሹ ነበር። ስለዚህ ለእውነተኛ ሩጫ የሚሠራው ቅጂ
// በዕጣት-ውስጥ (gitignored) ይኖራል፤ መሠዊያው ንባብ ብቻ ነው።
const BASELINE_KB = join(REPO, 'data', 'knowledge', 'entries.json');
const RUNTIME_KB = join(UPDATE_STATE_DIR, 'applied', 'entries.json');
function resolveKbPath() {
  if (process.env.KB_PATH) return process.env.KB_PATH;
  mkdirSync(dirname(RUNTIME_KB), { recursive: true });
  if (!existsSync(RUNTIME_KB)) copyFileSync(BASELINE_KB, RUNTIME_KB);
  return RUNTIME_KB;
}
const kbPath = resolveKbPath();
const kb = KnowledgeBase.load(kbPath);
const evidence = new EvidenceLog({
  // EVIDENCE_PATH፦ የሙከራና የG1 ሩጫ ማስረጃዎች በተናጅል መዝገብ እንዲታዘዙ (የተጠቃሚ ማስረጃ አይቀላቀሉም)
  path: process.env.EVIDENCE_PATH ?? join(REPO, 'evidence', 'g1-demo-events.jsonl'),
  gate: 'G1',
  device: 'laptop-windows',
  build: process.env.BUILD_REF ?? 'working-tree',
});

const updates = new UpdateService({
  keysPath: process.env.UPDATE_KEYS_PATH ?? join(REPO, 'data', 'updates', 'keys.json'),
  statePath: join(UPDATE_STATE_DIR, 'state.json'),
  kbPath,
  backupDir: join(UPDATE_STATE_DIR, 'backups'),
  log: (record) => evidence.record('update_event', record),
});

const SAMPLE_DIRS = [
  { dir: join(REPO, 'data', 'updates', 'samples'), origin: 'demo-sample' },
  { dir: join(REPO, 'tests', 'fixtures', 'updates'), origin: 'test-fixture' },
];
// ናሙናው በስም ብቻ ይመረጣል — መንገድ መፃፍ የለውም (path traversal ዝግ)
const SAFE_NAME = /^[A-Za-z0-9._-]+\.json$/;

// በMANIFEST.json የተቀመጡት የተጠበቁ ውጤቶች ናሙናውን ዕርጅት አንድ አድራሻ ላይ ይሰጣሉ (F-20 — ሌላ ምንጭ አይፈጠርም)
function expectationsFor(dir) {
  const manifestPath = join(dir, 'MANIFEST.json');
  if (!existsSync(manifestPath)) return new Map();
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return new Map((manifest.cases ?? []).map((c) => [c.file, c]));
  } catch {
    return new Map();
  }
}

function listUpdateSamples() {
  const samples = [];
  for (const { dir, origin } of SAMPLE_DIRS) {
    if (!existsSync(dir)) continue;
    const expectations = expectationsFor(dir);
    for (const name of readdirSync(dir).filter((f) => SAFE_NAME.test(f) && f !== 'MANIFEST.json').sort()) {
      let env;
      try {
        env = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      } catch {
        samples.push({ name, origin, readable: false });
        continue;
      }
      // envelope ያልሆነ ፋይል ናሙና ተብሎ አይቀርጥም
      if (!env.update_id) continue;
      const case_ = expectations.get(name) ?? null;
      samples.push({
        name,
        origin,
        update_id: env.update_id ?? null,
        version: env.version ?? null,
        key_id: env.key_id ?? null,
        expected: case_ ? (case_.expect_ok ? 'ACCEPTED' : 'REJECTED') : null,
        expected_code: case_?.expect_code ?? null,
        note: case_?.note ?? null,
      });
    }
  }
  return samples;
}

function readUpdateSample(name) {
  if (!SAFE_NAME.test(String(name ?? ''))) return null;
  for (const { dir, origin } of SAMPLE_DIRS) {
    const file = join(dir, String(name));
    if (existsSync(file) && statSync(file).isFile()) {
      return { origin, envelope: JSON.parse(readFileSync(file, 'utf8')) };
    }
  }
  return null;
}

// F-07/NR-01 — የሀብት ገደቦች። ዋጋዎቹ በdocs/RESOURCE_LATENCY_AND_ENERGY_BUDGET_v1_0_AM.md
// ተመዝግበዋል፤ በዚህ ማሳያ የተለኩ ቁጥሮችም በevidence/g1-resource-budget.json አሉ።
// ዓላማ፦ የላፕቶፕ ሂደት ያለ ገደብ እያደለ አይኖር — session፣ ታሪክና የልኬት ናሙናዎች ሁሉ ወሰን አላቸው።
const MAX_SESSIONS = 16;
const MAX_SESSION_HISTORY = 64;
const MAX_LATENCY_SAMPLES = 2000;
const SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_MS ?? 30 * 60 * 1000);
const RESOURCE_LIMITS = {
  max_sessions: MAX_SESSIONS,
  max_session_history: MAX_SESSION_HISTORY,
  max_latency_samples: MAX_LATENCY_SAMPLES,
  session_idle_ms: SESSION_IDLE_MS,
  max_body_bytes: 12 * 1024 * 1024,
};
const dropped = { latency_samples: 0, history_records: 0, sessions_evicted: 0 };

class SessionError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const sessions = new Map();

function touch(session) {
  session.last_used = Date.now();
  return session;
}

function pushHistory(session, record) {
  session.history.push(record);
  if (session.history.length > MAX_SESSION_HISTORY) {
    session.history.splice(0, session.history.length - MAX_SESSION_HISTORY);
    dropped.history_records += 1;
  }
}

function sweepIdleSessions() {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, s] of sessions) {
    if ((s.last_used ?? s.created_at_ms) < cutoff) {
      sessions.delete(id);
      dropped.sessions_evicted += 1;
      evidence.record('session_idle_expired', { session_id: id, idle_limit_ms: SESSION_IDLE_MS });
    }
  }
}

function newSession() {
  sweepIdleSessions();
  while (sessions.size >= MAX_SESSIONS) {
    let oldestId = null;
    let oldest = Infinity;
    for (const [id, s] of sessions) {
      const at = s.last_used ?? 0;
      if (at < oldest) { oldest = at; oldestId = id; }
    }
    sessions.delete(oldestId);
    dropped.sessions_evicted += 1;
    evidence.record('session_evicted_for_limit', { session_id: oldestId, limit: MAX_SESSIONS });
  }
  const id = newId('sess');
  const sms = new SmsGateway(join(REPO, 'data', 'sms', 'inbox.json'));
  const session = {
    id,
    created_at: nowIso(),
    created_at_ms: Date.now(),
    dialogue: new Dialogue({ kb, locale: 'am' }),
    sms,
    fm: new FmAdapter(join(REPO, 'data', 'fm', 'stations.json'), kb),
    call: new CallController({ log: (record) => evidence.record('call_event', { ...record, session_id: id }) }),
    turns: 0,
    history: [],
  };
  sms.onEvent = (event, detail) => evidence.record('sms_event', { ...detail, event, session_id: id });
  sessions.set(id, session);
  touch(session);
  evidence.record('session_started', { session_id: id, active_sessions: sessions.size, limit: MAX_SESSIONS });
  return session;
}

function getSession(body) {
  const id = body?.session_id;
  // መለያው የማይታወቅ ሲሆን አዲስ session በዝግታ አይፈጠርም — ደንበኛው ግልጽ መልስ ይኖረዋል (F-07)
  if (id) {
    const found = sessions.get(id);
    if (!found) throw new SessionError('SESSION_UNKNOWN');
    return touch(found);
  }
  return newSession();
}

const latency = { ask: [], asr: [], tts: [], fm: [] };

function recordLatency(kind, ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
  const arr = latency[kind];
  // ሙሉ ሲሆን የጪሠናውን ናሙና እንወግዳለን እንጂ የቅርቡን አናስቅር — ቢያንስ መቶኛው የአሁኑን ሁኔታ ይናገራል
  if (arr.length >= MAX_LATENCY_SAMPLES) {
    arr.shift();
    dropped.latency_samples += 1;
  }
  arr.push(ms);
}

// የASR ግብይት ችግኝ እያንዳንዱ ኮድ ለተጠቃሚው የተለየ ትክክለኛ ምክር ይጠይቃል። ዝግ ማይክ "አልተረዳሁም"
// ማለት ገበሬውን ያስቆጣል፤ መሣሪያው ምንም አላደረሰም ማለት ግን የተለየ እርምጃ አለው (F-08 / R-02)።
// G1 neural path keeps the existing provenance and safety gates, but generation is a real LLM.
async function respondForSession(s, text, locale) {
  const baseline = s.dialogue.respond({ text, localeHint: locale });
  if (!offlineModelsEnabled() || baseline.type === 'refuse' || baseline.safety?.blocked) return baseline;
  const epoch = s.aiEpoch ?? 0;
  const selected = baseline.locale;
  const context = (baseline.claims ?? []).map(c => {
    const entry = s.dialogue.kb.entries.find(entry => entry.claim_id === c.claim_id);
    return { claim_id: c.claim_id, text: entry?.answer ?? '', source: c.source, captured_at: c.captured_at, valid_until: c.valid_until, expired: c.expired, verification: c.verification ?? 'UNVERIFIED' };
  });
  s.modelHistory ??= [];
  // Conversation-state assembly: keep the user's own quantity/time statements so the
  // latest correction is marked authoritative instead of being averaged with old facts.
  s.userStatements ??= [];
  s.userStatements.push(String(text).slice(0, 2000));
  s.userStatements = s.userStatements.slice(-8);
  const facts = conversationFacts(s.userStatements);
  const system = { role: 'system', content: dialogueSystemPrompt(selected, context, facts) };
  const userContent = String(text).slice(0, 2000) + factsReminder(selected, facts);
  const messages = [system, ...s.modelHistory.slice(-6), { role: 'user', content: userContent }];
  const generated = await runOfflineModel({ kind: 'dialogue', locale: selected, messages, max_tokens: 160 });
  if (epoch !== (s.aiEpoch ?? 0) || !s.call.assertAiAllowed().allowed) return { type: 'blocked', code: 'CALL_INTERRUPTED', locale: selected };
  // Preserve what the user said even if the model's reply is withheld. Session
  // context stays bounded and volatile; rejected assistant text is never stored.
  s.modelHistory.push({ role: 'user', content: String(text).slice(0, 2000) });
  s.modelHistory = s.modelHistory.slice(-6);
  if (generated.ok) { const quality = inspectGeneratedReply(generated.text, selected, text); if (!quality.ok) { generated.ok = false; generated.code = quality.code; generated.text = null; } }
  if (!generated.ok) return { type: 'model_unavailable', code: generated.code, text: generated.code === 'MODEL_CONTEXT_TOO_LONG'
    ? (selected === 'om' ? 'Gaaffiin kun baay’ee dheeraa dha. Maaloo gabaabsaa irra deebi’aa gaafadhaa.' : 'ጥያቄው ለሞዴሉ በጣም ረጅሟል። እባክዎ አሳጥረው እንደገና ይጠይቁ።')
    : (selected === 'om' ? 'Moodeelli marii hin hojjenne. Irra deebi’aa yaalaa.' : 'የውይይት ሞዴሉ አልሠራም። እንደገና ይሞክሩ።'), locale: selected, model: generated };
  // Generated high-risk instructions do not inherit a source's verification.
  const risk = classifyRisk(generated.text, selected);
  if (risk.level !== 'low') return { ...baseline, type: 'refuse', text: selected === 'om' ? 'Gorsa kana ogeessa waliin mirkaneessaa.' : 'ይህን ምክር ከባለሙያ ጋር ያረጋግጡ።', code: 'GENERATED_RISK_BLOCKED', claims: [] };
  s.modelHistory.push({ role: 'assistant', content: generated.text });
  s.modelHistory = s.modelHistory.slice(-6);
  return { type: 'generated_unverified', code: 'GENERATED', text: generated.text, locale: selected, claims: [], source_context: context, verification: 'MODEL_OUTPUT_UNVERIFIED', model: generated, gate: 'G1_RESEARCH_ONLY' };
}

const NO_INPUT_CODES = new Set(['SILENT_CAPTURE']);
const NO_SPEECH_CODES = new Set(['EMPTY_TRANSCRIPT', 'AUDIO_TOO_SHORT', 'NON_SPEECH_CAPTURE', 'NO_VALID_UTTERANCE']);
const ASR_USER_TEXT = {
  NON_SPEECH_CAPTURE: 'ንግግር አልተገኘም። እባክዎ እንደገና ይናገሩ።',
  NO_VALID_UTTERANCE: 'የተነገረ ቃል አልተረዳሁም። እንደገና ይናገሩ።',
  EMPTY_TRANSCRIPT: 'ምንም ቃል አልተረዳሁም። እንደገና በግልጽ ይንገሩ።',
  AUDIO_TOO_SHORT: 'የደረሰኝ ድምፅ በጣም አጭር ነው። ሙሉ ቃል የሚገባ ርዝመት ይንገሩ።',
  SILENT_CAPTURE: 'ማይክሮፎኑ ምንም ድምፅ አላደረረም (ሁሉም ናሙና ዜሮ ነው)። ማይክ ፈቃድ፣ ትክክለኛ መሣሪያና የድምፅ አቅም ይፈትሹ።',
  ASR_TIMEOUT: 'የድምፅ መለያ ሂደቱ ጊዜ አልፎበታል። ድምፁን አጭር አድርገው ይሞክሩ።',
  ASR_LOCALE_UNSUPPORTED: 'ይህ ቋንቋ በአካባቢው ያለው የድምፅ መለያ ውስጥ አልተጨመረም።',
  AUDIO_NOT_FOUND: 'የተቀመጠው ድምፅ ፋይል አልተገኘም።',
  AUDIO_FORMAT_INVALID: 'የደረሰኝ ድምፅ ቅርጽ ፊደል አንባቢው ለማንበብ አልበቃም — እንደገና ይሞክሩ።',
  AUDIO_FORMAT_UNSUPPORTED: 'የደረሰኝ ድምፅ ቅርጽ በዚህ ኢንጂን አይደገፍም።',
  AUDIO_UNREADABLE: 'የተቀመጠውን ድምፅ ፋይል ማንበብ አልቻልኩም።',
};

function asrFailureResponse(sessionId, asr) {
  const type = NO_INPUT_CODES.has(asr.code) ? 'no_input'
    : NO_SPEECH_CODES.has(asr.code) ? 'no_speech'
      : 'asr_unavailable';
  return {
    type,
    code: asr.code,
    detail: asr.detail ?? null,
    engine: asr.engine ?? null,
    latency_ms: asr.latency_ms ?? null,
    audio: asr.audio ?? null,
    session_id: sessionId,
    text: ASR_USER_TEXT[asr.code]
      ?? 'የድምፅ መለያ ኢንጂኑ በዚህ ላፕቶፕ ላይ አልተጫነም። በጽሑፍ መጠየቅ ይቻላል፤ የASR ማረጋገጫ REQUIRES EVIDENCE ነው።',
    next: { ask_text: true },
  };
}

function json(res, code, payload) {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-farmer-ai-gate': 'G1-LAPTOP-ONLY',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((done, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 12 * 1024 * 1024) {
        fail(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return done({});
      try {
        done(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        fail(error);
      }
    });
    req.on('error', fail);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = resolve(PUB, rel);
  if (!target.startsWith(PUB) || !existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(target));
}

const routes = {
  'GET /api/status': () => {
    const asr = asrStatus();
    const tts = ttsStatus();
    return {
      gate: 'G1 — የላፕቶፕ ማሳያ ብቻ፤ የስልክ ማረጋገጫ አይደለም (G2 NOT RUN)',
      offline_model_runtime: offlineModelStatus(),
    offline_by_design: true,
      outbound_requests: 0,
      server_host: HOST,
      now: describeNow(),
      knowledge: { kb_version: kb.version, kb_status: kb.status, entries: kb.entries.length, file_sha256: kb.hash },
      asr,
      tts,
      updates: {
        keys_present: existsSync(join(REPO, 'data', 'updates', 'keys.json')),
        installed_version: updates.state().installed_version,
        monotonic_counter: updates.state().monotonic_counter,
        applied: updates.state().applied.length,
      },
      limits: {
        g1_authorized: 'laptop demo only',
        g2_not_started: 'real phone hardware not tested',
        g3_not_authorized: 'field testing not authorized',
        g4: 'NO-GO',
        resource: RESOURCE_LIMITS,
      },
    };
  },

  'POST /api/session': (body) => {
    const s = newSession();
    return { session_id: s.id, created_at: s.created_at };
  },

  'POST /api/text': async (body) => {
    const s = getSession(body);
    const pre = s.call.assertAiAllowed();
    if (!pre.allowed) {
      evidence.record('ask_blocked_by_call', { session_id: s.id, text_sha256: sha256(String(body.text ?? '')) });
      return { type: 'blocked', code: 'CALL_ACTIVE', text: 'ጥሪ ስለሚሰራ AI ተከልክሏል።', session_id: s.id };
    }
    // የተዛመደው ዙር ተቋረጠ በሚል ከፊተኛው ቁጥር ይታሰራል (R-37 የመቀጠል ፈቃድ ለትክክለኛው ዙር)
    s.call.aiStarted(s.id, 'THINKING', { turn: s.turns + 1 });
    const { result, ms } = await measure(() => Promise.resolve(respondForSession(s, String(body.text ?? ''), body.locale)));
    if (result.type === 'blocked') return { ...result, session_id: s.id };
    recordLatency('ask', ms);
    s.turns += 1;
    pushHistory(s, { at: nowIso(), ms, kind: 'text', verdict: result.type });
    s.call.aiFinished();
    evidence.record('text_turn', { session_id: s.id, ms: Math.round(ms), type: result.type, claims: result.claims?.length ?? 0, kb_version: result.kb_version, risk: result.risk?.level ?? null, locale: result.locale });
    return { session_id: s.id, turn: s.turns, metrics: { ms: Math.round(ms) }, ...result };
  },

  'POST /api/audio': async (body) => {
    const s = getSession(body);
    const pre = s.call.assertAiAllowed();
    if (!pre.allowed) return { type: 'blocked', code: 'CALL_ACTIVE', session_id: s.id };
    const wav = Buffer.from(String(body.wav_base64 ?? ''), 'base64');
    if (wav.length < 100) return { type: 'error', code: 'AUDIO_TOO_SMALL', session_id: s.id };
    const locale = body.locale ?? 'am';
    // ለውጪ መዝገብ ከመጻፍና ኢንጂን ከማነሳሳት በፊት ግብይቱ ራሱ ይታወቃል — ያለ ድምፅ ያለው ጥያቄ
    // 5-8 ሰከንድ በኋላ "አልተረዳሁም" ሳይሆን ወዲያውኑ ትክክለኛ ምክር ያገኛል (F-08 / R-02)።
    const shape = inspectWav(wav);
    const probe = shape.ok ? { ...shape, ...inspectSpeechSignal(wav) } : shape;
    if (!probe.ok) {
      evidence.record('asr_attempt', {
        session_id: s.id,
        locale,
        ok: false,
        code: probe.code,
        bytes: wav.length,
        ms: 0,
        audio: { seconds: probe.seconds, peak: probe.peak, sample_rate: probe.sample_rate, channels: probe.channels, bits: probe.bits },
        note: 'ግብይቱ ስለተዘጋ ኢንጂኑ አልነሳም',
      });
      return asrFailureResponse(s.id, {
        ...probe,
        engine: 'whisper.cpp',
        latency_ms: 0,
        audio: { sample_rate: probe.sample_rate, channels: probe.channels, bits: probe.bits, seconds: probe.seconds, peak: probe.peak },
      });
    }
    const file = join(TMP, `${newId('rec')}.wav`);
    writeFileSync(file, wav);
    const started = Date.now();
    const epoch = s.aiEpoch ?? 0;
    s.call.aiStarted(s.id, 'THINKING', { turn: s.turns + 1 });
    const asr = await transcribe(file, { locale, overrides: { bin: body.asr_bin, model: body.asr_model } });
    evidence.record('asr_attempt', {
      session_id: s.id,
      locale,
      ok: asr.ok,
      code: asr.code,
      bytes: wav.length,
      ms: Date.now() - started,
      transcript_sha256: asr.ok ? sha256(asr.text) : null,
    });
    if (epoch !== (s.aiEpoch ?? 0) || !s.call.assertAiAllowed().allowed) return { type: 'blocked', code: 'CALL_INTERRUPTED', session_id: s.id };
    if (!asr.ok) { s.call.aiFinished(); return asrFailureResponse(s.id, asr); }
    recordLatency('asr', asr.latency_ms);
    // የተዛመደው ዙር ተቋረጠ በሚል ከፊተኛው ቁጥር ይታሰራል (R-37 የመቀጠል ፈቃድ ለትክክለኛው ዙር)
    s.call.aiStarted(s.id, 'THINKING', { turn: s.turns + 1 });
    const { result, ms } = await measure(() => Promise.resolve(respondForSession(s, asr.text, locale)));
    recordLatency('ask', ms);
    if (result.type === 'blocked') return { ...result, session_id: s.id };
    s.call.aiFinished();
    s.turns += 1;
    pushHistory(s, { at: nowIso(), ms, kind: 'audio', verdict: result.type });
    evidence.record('audio_turn', { session_id: s.id, asr_ms: asr.latency_ms, nlu_ms: Math.round(ms), type: result.type, engine: asr.engine, model: asr.model });
    return { session_id: s.id, turn: s.turns, transcript: asr.text, asr, metrics: { asr_ms: asr.latency_ms, nlu_ms: Math.round(ms) }, ...result };
  },

  'POST /api/tts': async (body) => {
    const session = getSession(body);
    const epoch = session.aiEpoch ?? 0;
    if (!session.call.assertAiAllowed().allowed) return { ok: false, code: 'CALL_ACTIVE' };
    const text = String(body.text ?? '');
    if (!text) return { ok: false, code: 'EMPTY_TEXT' };
    const out = join(TMP, `${newId('tts')}.wav`);
    const started = Date.now();
    if (offlineModelsEnabled()) session.call.aiStarted(session.id, 'SPEAKING', { turn: session.turns });
    const result = offlineModelsEnabled()
      ? await runOfflineModel({ kind: 'tts', text, locale: body.locale ?? 'am', path: out })
      : synthesize(text, { locale: body.locale ?? 'am', outPath: out, rate: body.rate ?? 0 });
    if (epoch !== (session.aiEpoch ?? 0) || !session.call.assertAiAllowed().allowed) return { ok: false, code: 'CALL_INTERRUPTED' };
    if (offlineModelsEnabled()) session.call.aiFinished();
    if (result.ok) recordLatency('tts', Date.now() - started);
    evidence.record('tts_attempt', {
      ok: result.ok,
      code: result.code,
      locale: body.locale ?? 'am',
      chars: text.length,
      ms: Date.now() - started,
      bytes: result.bytes ?? null,
      voice: result.voice ?? null,
    });
    if (!result.ok) {
      return { ...result, text_display: text, note: 'የአማርኛ/አፋን ኦሮሞ ድምፅ ምንጭ በዚህ ላፕቶፕ ላይ የለም። ጽሑፍ ብቻ ይታያል፤ TTS ጥራት REQUIRES EVIDENCE።' };
    }
    const wav = readFileSync(result.path).toString('base64');
    return { ...result, wav_base64: wav, text_display: text };
  },

  // R-04 / RU-13 / F-18፦ የAI ደረጃ ማዳመጥና መናገር ሲጀምርና ሲያልቅ ይነገራል፤ ጥሪ ሲመጣ በዚህ ደረጃ ላይ ተመሠርቶ ይቋረጣል።
  // በእውነተኛ ስልክ AI ራሱ ደረጃውን ለጥሪ አገልግሎት ይነግራል፤ በG1 ማሳያ ደግሞ አሳሽው ይዘግባል — ስለዚህ ማሽከርከር እንጂ MET አይደለም
  'POST /api/ai/phase': (body) => {
    const s = getSession(body);
    const kind = String(body.phase ?? '');
    if (kind === 'IDLE') {
      s.call.aiFinished();
      return { session_id: s.id, allowed: true, phase: s.call.phase };
    }
    if (!AI_PHASE_VALUES.has(kind)) {
      return { session_id: s.id, allowed: false, code: 'BAD_AI_PHASE', phase: s.call.phase };
    }
    const r = s.call.aiPhase(kind, { sessionId: s.id, turn: s.turns, topicId: s.dialogue.lastTopicId ?? null });
    return { session_id: s.id, ...r, phase: s.call.phase };
  },

  'POST /api/call': (body) => {
    const s = getSession(body);
    const kind = body.kind ?? 'normal';
    if (body.action === 'incoming') {
      s.aiEpoch = (s.aiEpoch ?? 0) + 1;
      stopOfflineWorker();
      const r = s.call.incoming({ from: body.from ?? 'unknown', kind });
      return {
        session_id: s.id,
        ...r,
        phase: s.call.phase,
        note: r.preempted
          ? 'AI ዙሩ ተቋረጠ፤ ጥሪ ቅድሚያ አለው (R-04፣ RU-13፣ RG-34-01)። መልሶ ለመጀመር ፈቃድ ያስፈልጋል።'
          : 'AI ስላልሠራ ጥሪ ብቻ ተቀብሏል።',
      };
    }
    if (body.action === 'outgoing') {
      s.aiEpoch = (s.aiEpoch ?? 0) + 1;
      stopOfflineWorker();
      return { session_id: s.id, ...s.call.outgoing({ to: body.to ?? 'unknown', kind }) };
    }
    if (body.action === 'accept') return { session_id: s.id, ...s.call.accept(), phase: s.call.phase };
    if (body.action === 'end') {
      const r = s.call.end();
      return { session_id: s.id, ...r, phase: s.call.phase, note: r.resume_requires_consent ? 'AI ለመቀጠል የተጠቃሚ ፈቃድ ያስፈልጋል (R-37)' : 'AI አልተከላከለም' };
    }
    return { ok: false, code: 'UNKNOWN_ACTION' };
  },

  'GET /api/sms': (body) => {
    const s = getSession(body);
    return { session_id: s.id, permissions: s.sms.permissions, messages: s.sms.list(), note: 'የSMS ይዘት የሚነበበው በAI ቁልፍና በፈቃድ ብቻ (R-12፣ R-37፣ RU-05)' };
  },

  'POST /api/sms/permission': (body) => {
    const s = getSession(body);
    const result = s.sms.setPermission(body.scope, Boolean(body.value));
    return { session_id: s.id, permissions: s.sms.permissions, ...result };
  },

  'POST /api/sms/read': (body) => {
    const s = getSession(body);
    const result = s.sms.read(body.id, { aiKey: Boolean(body.ai_key), locale: body.locale ?? 'am' });
    return { session_id: s.id, ...result };
  },

  'POST /api/sms/extract': (body) => {
    const s = getSession(body);
    return { session_id: s.id, ...s.sms.extractKnowledge(body.id) };
  },

  'GET /api/fm': (body) => {
    const s = getSession(body);
    return {
      session_id: s.id,
      // የጣቢያ መረጃው በዳሰቢው መሠረት ነው (frequency_mhz/language/region) — ተለውጠው የማይታወቁ ስሞች አይፈጠሩም
      stations: s.fm.stations,
      broadcasts: s.fm.broadcasts,
      hardware_note: 'ይህ የG1 ማስመሰያ ነው፤ እውነተኛ FM→PCM መዳረሻ በG2 ይፈተሻል (F-12፣ VE-02፣ HC-02)',
    };
  },

  'POST /api/fm/ingest': async (body) => {
    const s = getSession(body);
    // ናሙናውን ከደረጃው መረጃ (broadcast_id) ወይም ከጽሑፍ ይውስዳል — ሁለቱም ከሌሉ "undefined" የሚል ግቤት አይፈጠርም
    const fixture = body.broadcast_id ? s.fm.broadcasts.find((b) => b.id === body.broadcast_id) : null;
    if (body.broadcast_id && !fixture) return { session_id: s.id, ok: false, code: 'UNKNOWN_BROADCAST' };
    const text = String(fixture?.text ?? body.text ?? '');
    if (!text.trim()) return { session_id: s.id, ok: false, code: 'BROADCAST_TEXT_REQUIRED' };
    const input = {
      station_id: body.station_id ?? fixture?.station_id,
      text,
      captured_at: fixture?.captured_at ?? body.captured_at,
      signal_quality: fixture?.signal_quality ?? body.signal_quality ?? 0.5,
      topic_id: fixture?.topic_id ?? body.topic_id ?? null,
    };
    const { result, ms } = await measure(() => Promise.resolve(s.fm.ingest(input)));
    recordLatency('fm', ms);
    const conflicts = result.claim ? s.fm.conflicts(result.claim) : [];
    evidence.record('fm_ingest', {
      session_id: s.id,
      station_id: input.station_id,
      broadcast_id: body.broadcast_id ?? null,
      stale: result.claim?.stale,
      conflicts: conflicts.length,
      ms: Math.round(ms),
    });
    return { session_id: s.id, ms: Math.round(ms), ...result, conflicts };
  },

  'POST /api/fm/ask': (body) => {
    const s = getSession(body);
    const ask = s.fm.ask(body.topic_id);
    const turn = ask.answer ? s.dialogue.respond({ text: body.text ?? '', localeHint: body.locale ?? 'am' }) : null;
    evidence.record('fm_ask', { session_id: s.id, present_as_today: ask.presentAsToday ?? null, note: ask.note ?? null });
    return { session_id: s.id, ...ask, turn };
  },

  'POST /api/update': async (body) => {
    if (body.action === 'verify') return { mode: 'verify', ...updates.verify(body.envelope ?? body) };
    if (body.action === 'apply') {
      const before = { version: updates.state().installed_version, hash: sha256(readFileSync(kbPath, 'utf8')).slice(0, 12) };
      const result = updates.apply(body.envelope ?? body);
      if (result.applied) kb.reload();
      evidence.record('update_apply', { before, after_version: updates.state().installed_version, applied: result.applied, code: result.code });
      return { ...result, before, kb_version: kb.version, kb_status: kb.status };
    }
    if (body.action === 'rollback') {
      const result = updates.rollback(body.update_id, { reason: body.reason ?? 'owner_request' });
      kb.reload();
      return { ...result, kb_version: kb.version };
    }
    if (body.action === 'state') return updates.state();
    return { ok: false, code: 'UNKNOWN_ACTION' };
  },

  'GET /api/update/samples': () => ({ samples: listUpdateSamples() }),

  'GET /api/update/sample': (body) => {
    const found = readUpdateSample(body.name);
    if (!found) return { ok: false, code: 'SAMPLE_NOT_FOUND', name: String(body.name ?? '') };
    return { ok: true, ...found };
  },

  'GET /api/evidence': () => ({ chain: evidence.verifyChain(), count: evidence.entries().length, path: evidence.path }),

  'GET /api/metrics': () => {
    const p = (arr) => ({ p50: percentile(arr, 50), p95: percentile(arr, 95), n: arr.length });
    return {
      text_turn_ms: p(latency.ask),
      asr_ms: p(latency.asr),
      tts_ms: p(latency.tts),
      fm_ingest_ms: p(latency.fm),
      process: resourceSnapshot(),
      sessions: {
        active: sessions.size,
        history_max: Math.max(0, ...[...sessions.values()].map((s) => s.history.length)),
        ...RESOURCE_LIMITS,
        ...dropped,
      },
    };
  },

  'POST /api/metrics/reset': () => {
    for (const k of Object.keys(latency)) latency[k] = [];
    for (const k of Object.keys(dropped)) dropped[k] = 0;
    return { ok: true };
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) {
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, code: 'NO_ROUTE' }));
    return;
  }
  try {
    const body = req.method === 'POST'
      ? await readBody(req)
      : Object.fromEntries(url.searchParams.entries());
    const out = await handler(body);
    json(res, 200, out);
  } catch (error) {
    if (error instanceof SessionError) {
      evidence.record('session_rejected', { code: error.code, route: key });
      return json(res, 409, { ok: false, code: error.code, next: { new_session: 'POST /api/session' } });
    }
    evidence.record('server_error', { code: 'HANDLER_EXCEPTION', message: String(error.message), route: key });
    json(res, 500, { ok: false, code: 'HANDLER_EXCEPTION', detail: String(error.message) });
  }
});

server.listen(PORT, HOST, () => {
  evidence.record('server_started', { host: HOST, port: PORT, pid: process.pid, kb_hash: kb.hash });
  console.log(`G1 offline demo → http://${HOST}:${PORT}  (ማስታወሻ፦ የላፕቶፕ ማሳያ ብቻ፤ G2/G3/G4 አልተፈቀዱም)`);
});

// Terminate the dedicated inference process group, including native LLM children.
process.once('SIGTERM', () => {
  stopOfflineWorker();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
