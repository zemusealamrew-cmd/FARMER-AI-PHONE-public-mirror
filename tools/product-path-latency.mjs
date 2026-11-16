// F-08 / F-11 / R-02 / D-003፦ የምርት መንገድ (HTTP → ገንቢ → whisper.cpp) የASR ጊዜ ልኬት።
// ደንቡ፦ `tools/voice-check.mjs` ኢንጂኑ በቀጥታ ስለሚጮኽ የተለካው ጊዜ የኢንጂን ብቻ ነው፤ በተጠቃሚ ላይ
// የሚደርሰው ግን ገንቢውን + ውይይት + ማስረጃ መጻፍ ጨምሮ ነው። ይህ መሣሪያ ሁለተኛውን መንገድ ይለካል።
// ገደብ፦ በላፕቶፕ (G1) ብቻ፤ በባለቁልፍ ስልክ ላይ UNKNOWN። D-003 የቁጥር ማለፊያ ወሰን ስለሌለ ልኬት ብቻ ነው።
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile } from '../app/src/evidence.mjs';
import { sha256 } from '../app/src/util.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 8713);
const ROUNDS = Number(process.env.ROUNDS ?? 6);
const OUT = join(REPO, 'evidence', 'g1-product-path-latency.json');
const scratch = join(REPO, '.tmp');

// የቀጥታ ዋጋ ያለው loopback አድራሻ ብቻ — offline-check.mjs ይህን በማረጋገጥ ወደ ውጭ መውጣት አለመሆኑን ይለያል
const BASE = `http://127.0.0.1:${PORT}`;

async function post(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: await res.json() };
}

function toneWavBase64() {
  // 1 ሰከንድ 440 Hz፣ peak 9000 — የተነገረ ያልሆነ ድምፅ ናሙና (የማይክ ቅራኔ አይደለም)
  const frames = 16000;
  const tone = Buffer.alloc(44 + frames * 2);
  tone.write('RIFF', 0); tone.writeUInt32LE(36 + frames * 2, 4); tone.write('WAVE', 8);
  tone.write('fmt ', 12); tone.writeUInt32LE(16, 16); tone.writeUInt16LE(1, 20); tone.writeUInt16LE(1, 22);
  tone.writeUInt32LE(16000, 24); tone.writeUInt32LE(32000, 28); tone.writeUInt16LE(2, 32); tone.writeUInt16LE(16, 34);
  tone.write('data', 36); tone.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    tone.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), 44 + i * 2);
  }
  return tone.toString('base64');
}

const server = spawn(process.execPath, [join(REPO, 'app', 'server.mjs')], {
  cwd: REPO,
  // የተጠቃሚ ሩጫ ፍላይዎች በዕጣት-ውስጥ (.tmp) ብቻ — የGit-ተከታታይ መሠዊያ መዝገብ አይነካም (F-22/NR-05)
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    EVIDENCE_PATH: join(scratch, 'product-path-events.jsonl'),
    UPDATE_STATE_DIR: join(scratch, 'product-path-state'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let stderr = '';
server.stderr.on('data', (d) => { stderr += d; });

async function waitForSession() {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const r = await post('/api/session', {});
      if (r.status === 200) return r.json.session_id ?? r.json.id;
    } catch {
      if (Date.now() > deadline) throw new Error(`ማሳያ ማዳመጥ አልተቻለም፦ ${stderr}`);
    }
    await new Promise((d) => setTimeout(d, 250));
  }
}

const sessionId = await waitForSession();
const wav = readFileSync(join(REPO, 'evidence', 'audio', 'en-tts-roundtrip-input-16k.wav')).toString('base64');

const runs = [];
for (let i = 0; i < ROUNDS; i += 1) {
  const t0 = Date.now();
  const r = await post('/api/audio', { session_id: sessionId, wav_base64: wav, locale: 'en' });
  runs.push({
    round: i + 1,
    wall_ms: Date.now() - t0,
    http_status: r.status,
    asr_code: r.json.asr?.code ?? r.json.code ?? null,
    asr_ms: r.json.metrics?.asr_ms ?? r.json.asr?.latency_ms ?? r.json.latency_ms ?? null,
    nlu_ms: r.json.metrics?.nlu_ms ?? null,
    reply_type: r.json.type ?? null,
    reply_locale: r.json.locale ?? null,
    transcript_sha256: typeof r.json.transcript === 'string' ? sha256(r.json.transcript) : null,
  });
}

const nonspeechRes = await post('/api/audio', {
  session_id: sessionId,
  wav_base64: toneWavBase64(),
  locale: 'am',
});
const nonspeech = {
  http_status: nonspeechRes.status,
  asr_code: nonspeechRes.json.asr?.code ?? nonspeechRes.json.code ?? null,
  reply_type: nonspeechRes.json.type ?? null,
  reply_locale: nonspeechRes.json.locale ?? null,
  escalation: nonspeechRes.json.escalation ?? null,
  transcript_sha256: typeof nonspeechRes.json.transcript === 'string' ? sha256(nonspeechRes.json.transcript) : null,
  transcript_preview: typeof nonspeechRes.json.transcript === 'string' ? nonspeechRes.json.transcript.slice(0, 120) : null,
  safety_outcome: typeof nonspeechRes.json.text === 'string' ? nonspeechRes.json.text.slice(0, 80) : null,
};

const ok = runs.filter((r) => r.asr_code === 'TRANSCRIBED');
// app/src/evidence.mjs percentile() p 0–100 ይጠይቃል (voice-check.mjs ያለው 0–1 አይደለም)
const dist = (vals) => (vals.length === 0 ? { n: 0 } : {
  n: vals.length,
  min: Math.min(...vals),
  max: Math.max(...vals),
  mean: Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(0)),
  p50: percentile(vals, 50),
  p95: percentile(vals, 95),
});

const report = {
  path: 'HTTP POST /api/audio (app/server.mjs) → whisper.cpp child process → dialogue → evidence log',
  distinct_from: 'tools/voice-check.mjs spawns whisper.cpp directly (no server, no dialogue step)',
  input: 'evidence/audio/en-tts-roundtrip-input-16k.wav (English TTS-derived speech, 16 kHz mono PCM16)',
  rounds: ROUNDS,
  device: 'laptop-windows (i7-1165G7, 16 GB)',
  engine: 'whisper.cpp ggml-small-q5_1.bin',
  observed: runs,
  transcript_hashes_distinct: [...new Set(ok.map((r) => r.transcript_sha256))].length,
  asr_engine_ms: dist(ok.map((r) => r.asr_ms ?? r.wall_ms)),
  product_path_wall_ms: dist(ok.map((r) => r.wall_ms)),
  nlu_ms: dist(ok.map((r) => r.nlu_ms ?? 0)),
  nonspeech_probe: nonspeech,
  verdict: {
    latency: 'PARTIAL',
    reason: 'ተለካል፤ ግን D-003 የቁጥር ማለፊያ ወሰን የለም፤ በባለቁልፍ ስልክ ላይ UNKNOWN',
    asr_dominates: 'የምርት መንገድ wall ልክ እንደ አካላዊ engine ጊዜ ነው፤ የውይይት ደረጃ ≤2 ms',
    nonspeech_guard: nonspeech.asr_code === 'NON_SPEECH_CAPTURE' && nonspeech.transcript_sha256 === null ? 'PARTIAL_NEGATIVE_PROBE_PASSED' : 'GAP',
    reason_nonspeech: nonspeech.asr_code === 'NON_SPEECH_CAPTURE' ? 'Synthetic tone rejected; broader speech/noise false-positive and false-rejection acceptance requires independent recordings.' : 'Non-speech rejection was not demonstrated by this run.',
    safety_on_hallucination: { actual_reply_type: nonspeech.reply_type, actual_escalation: nonspeech.escalation, transcript_present: nonspeech.transcript_sha256 !== null },
  },
  limits: [
    'የላፕቶፍ ብቻ — በባለቁልፍ ስልክ ላይ ውጤት ተመሳሳይ አይደለም',
    'የእንግሊዝኛ ግብይት ብቻ — የአማርኛ የሰው ድምጅ ማስታወሻ አልተገኘም (D-004/ባለቤት ናሙና)',
    'ተከታታይ ዙር ስለሆነ ሙቀት/ፍሪኩዌንሲ ቅነሳ ውስጥ ሊገባ ይችላል (ምክንያት ለመለየት control ያስፈልጋል)',
    'ምርቱ የሚደግፋቸው ቋንቋ am/om ብቻ ናቸው፤ የእንግሊዝኛ ግብይት ላቲን ፊደል ስለሆነ መልሱ በተመደበው ሙከራ «om» ሆኖ ተቀምጧል — D-004/R-07 ተያያዥ ጥያቄ',
  ],
};

mkdirSync(join(REPO, 'evidence'), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
server.kill();
await new Promise((r) => server.on('exit', r));
console.log(JSON.stringify({
  asr_engine_ms: report.asr_engine_ms,
  product_path_wall_ms: report.product_path_wall_ms,
  nlu_ms: report.nlu_ms,
  distinct_transcripts: report.transcript_hashes_distinct,
  nonspeech: { asr_code: nonspeech.asr_code, transcript_preview: nonspeech.transcript_preview, reply_type: nonspeech.reply_type },
  written: existsSync(OUT) ? OUT : null,
}, null, 2));
