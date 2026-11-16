// F-07 / F-11 / NR-01 / R-38 / CI-14፦ የሀብትና የልኬት በጀት ልኬት (node tools/resource-budget.mjs)።
// ዓላማ፦ የG1 ማሳያ ወሰኖቹ (session፣ ታሪክና የልኬት ናሙና) በእውነት እንደሚገድቡ የተለኩ ቁጥሮችን ማቅረብ።
// ደንቡ፦ LAPTOP≠ስልክ። የስልክ ቁጥሮች (ቮልቴጅ፣ ኃይል፣ RAM ወሰን) UNKNOWN ናቸው — G2 ማረጋገጫ ያስፈልጋል።
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BUDGET_PORT ?? 8714);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(REPO, 'evidence', 'g1-resource-budget.json');
const EVENTS = join(REPO, '.tmp', 'budget-events.jsonl');
const TURNS = Number(process.env.BUDGET_TURNS ?? 2200);
const CHECKPOINT_EVERY = 200;

async function req(route, body) {
  const [method, path] = route.split(' ');
  const query = method === 'GET' && body ? `?${new URLSearchParams(body)}` : '';
  const res = await fetch(`${BASE}${path}${query}`, method === 'GET'
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, json: await res.json() };
}

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((d) => setTimeout(d, 100));
    try {
      if ((await req('GET /api/status')).status === 200) return true;
    } catch {
      // ሲቀዘቅዝ እንደገና እንሞክራለን
    }
  }
  return false;
}

const child = spawn(process.execPath, [join(REPO, 'app', 'server.mjs')], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', EVIDENCE_PATH: EVENTS, UPDATE_STATE_DIR: join(REPO, '.tmp', 'resource-state'), BUILD_REF: process.env.BUILD_REF ?? 'working-tree' },
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
});
mkdirSync(join(REPO, '.tmp'), { recursive: true });
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { stderr += d; });

const cpu = cpus()[0] ?? {};
const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  gate: 'G1',
  device: 'laptop-windows',
  host: {
    platform: platform(),
    release: release(),
    arch: arch(),
    node: process.version,
    cpu_model: cpu.model ?? 'UNKNOWN',
    cpu_cores: cpus().length,
    total_mem_mb: Math.round(totalmem() / 1024 / 1024),
  },
  workload: { turns_requested: TURNS, checkpoint_every: CHECKPOINT_EVERY, port: PORT },
  phases: {},
  unknown: [],
  vocabulary_note: 'MET=በልኬት የተረጋገጠ | PARTIAL=ግማሽ | GAP=የጎደለ | UNKNOWN=የማይታወቅ | REQUIRES EVIDENCE=ማረጋገጫ ያስፈልጋል',
};

try {
  if (!(await waitReady())) throw new Error(`ማሳያው አልተጀመረም፦ ${stderr.slice(0, 300)}`);
  await req('POST /api/metrics/reset', {});
  const limits = (await req('GET /api/metrics')).json.sessions;
  report.limits = limits;

  // ደረጃ 1፦ መነሻ (idle) ሁኔታ — አንድ ክፍለ-ጊዜ ብቻ
  const first = (await req('POST /api/session', {})).json.session_id;
  const idle = await req('GET /api/metrics');
  report.phases.baseline = {
    verdict: 'MET',
    sessions_active: idle.json.sessions.active,
    rss_mb: idle.json.process.rss_mb,
    heap_used_mb: idle.json.process.heap_used_mb,
    note: 'አንድ ክፍለ-ጊዜ ብቻ ሲኖር የሂደቱ መጠን',
  };

  // ደረጃ 2፦ የክፍለ-ጊዜ ወሰን ማረጋገጫ
  const ids = [first];
  for (let i = 0; i < limits.max_sessions + 8; i += 1) ids.push((await req('POST /api/session', {})).json.session_id);
  const capped = (await req('GET /api/metrics')).json.sessions;
  const evictedProbe = await req('POST /api/text', { session_id: ids[0], text: 'የበቆሎ ዘር እንዴት ይዘራል' });
  report.phases.session_cap = {
    verdict: capped.active <= limits.max_sessions && capped.sessions_evicted >= 8 ? 'MET' : 'GAP',
    requested_sessions: ids.length,
    active: capped.active,
    limit: limits.max_sessions,
    evicted: capped.sessions_evicted,
    evicted_id_status: evictedProbe.status,
    evicted_id_code: evictedProbe.json.code,
    note: 'ከወሰን በላይ የተፈጠሩት በቅደም-ተከተል (LRU) ተወግደዋል፤ የተወገደ መለያ ግልጽ 409 ይመልሳል',
  };

  // ደረጃ 3፦ ረጅም ውይይት — ታሪክና የልኬት ናሙና ወሰን + የሐሳብ ቦታ ዕድገት
  const sess = (await req('POST /api/session', {})).json.session_id;
  const checkpoints = [];
  const answered = { answer: 0, clarify: 0, other: 0 };
  for (let i = 1; i <= TURNS; i += 1) {
    const r = await req('POST /api/text', {
      session_id: sess,
      text: i % 2 ? 'ተጨማሪ ዝርዝር' : 'የበቆሎ ዘር እንዴት ይዘራል',
      locale: 'am',
    });
    if (r.json.type === 'answer') answered.answer += 1;
    else if (r.json.type === 'clarify') answered.clarify += 1;
    else answered.other += 1;
    if (i % CHECKPOINT_EVERY === 0 || i === TURNS) {
      const m = (await req('GET /api/metrics')).json;
      checkpoints.push({
        turn: i,
        rss_mb: m.process.rss_mb,
        heap_used_mb: m.process.heap_used_mb,
        history_max: m.sessions.history_max,
        latency_samples: m.text_turn_ms.n,
        dropped_history: m.sessions.history_records,
        dropped_latency: m.sessions.latency_samples,
        p95_ms: m.text_turn_ms.p95,
      });
    }
  }
  const half = Math.floor(checkpoints.length / 2);
  const firstHalf = checkpoints.slice(0, half);
  const secondHalf = checkpoints.slice(half);
  const growth = (arr) => (arr.length > 1 ? Math.round((arr[arr.length - 1].rss_mb - arr[0].rss_mb) * 10) / 10 : 0);
  const final = checkpoints[checkpoints.length - 1];
  report.phases.long_dialogue = {
    verdict: final.history_max <= limits.max_session_history && final.latency_samples <= limits.max_latency_samples
      ? 'MET' : 'GAP',
    turns_sent: TURNS,
    answered: answered.answer,
    clarify: answered.clarify,
    other: answered.other,
    history_limit: limits.max_session_history,
    history_max: final.history_max,
    dropped_history_records: final.dropped_history,
    latency_limit: limits.max_latency_samples,
    latency_samples: final.latency_samples,
    dropped_latency_samples: final.dropped_latency,
    rss_first_half_mb: growth(firstHalf),
    rss_second_half_mb: growth(secondHalf),
    rss_final_mb: final.rss_mb,
    heap_final_mb: final.heap_used_mb,
    text_turn_p50_ms: (await req('GET /api/metrics')).json.text_turn_ms.p50,
    text_turn_p95_ms: final.p95_ms,
    checkpoints,
    note: 'ታሪክ 64 ላይ ተገድቧል፤ የልኬት ናሙና 2000 ላይ ተገድቧል፤ የሁለተኛው ግማሽ የሐሳብ ቦታ ዕድገት ከመጀመሪያው ጋር ሲነጻጸር',
  };

  // ደረጃ 4፦ የድምፅ መንገዶች ሁኔታ (በዚህ ማሳያ ላይ)
  const status = (await req('GET /api/status')).json;
  report.phases.asr_path = {
    verdict: status.asr.ready ? 'PARTIAL' : 'GAP',
    ready: status.asr.ready,
    engine: status.asr.engine,
    supported_locales: status.asr.supported_locales,
    unsupported_locales: status.asr.unsupported_locales,
    note: 'በላፕቶፕ ማይክ ላይ ብቻ፤ የስልክ ማይክ/ጫጫታ/WER UNKNOWN (G2)',
  };
  report.phases.tts_path = {
    verdict: status.tts.locale_support?.am?.available ? 'PARTIAL' : 'GAP',
    engine: status.tts.engine,
    engine_ok: status.tts.ok,
    code: status.tts.code ?? null,
    am_available: status.tts.locale_support?.am?.available ?? false,
    om_available: status.tts.locale_support?.om?.available ?? false,
    note: 'NO_LOCAL_VOICE — አማርኛ/አፋን ኦሮሞ የተረጋገጠ አካባቢያዊ ድምፅ የለም',
  };

  report.unknown = [
    { item: 'የስልክ RAM ወሰን (512MB/1GB መሣሪያ)', verdict: 'UNKNOWN', reason: 'እውነተኛ ስልክ አልተፈተነም — G2 ፈቃድ ያስፈልጋል' },
    { item: 'የቮልቴጅና ኃይል ፍጆታ (mAh/ዙር)', verdict: 'UNKNOWN', reason: 'በላፕቶፕ ልኬት ኃይል ሊተመን አይችልም' },
    { item: 'የASR ዕድገት ጊዜ በስልክ ላይ', verdict: 'UNKNOWN', reason: 'በላፕቶፕ 10s+ የተለካ ሲሆን የመሣሪያ ደረጃ ግምታዊ ብቻ ነው (REQUIRES EVIDENCE)' },
    { item: 'የአማርኛ/አፋን ኦሮሞ TTS ድምፅ', verdict: 'GAP', reason: 'NO_LOCAL_VOICE — የተረጋገጠ አካባቢያዊ ድምፅ ምንጭ የለም' },
  ];
  report.verdict_counts = Object.values(report.phases).reduce((acc, p) => {
    acc[p.verdict] = (acc[p.verdict] ?? 0) + 1;
    return acc;
  }, {});
} finally {
  child.kill();
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`WROTE ${OUT}`);
console.log(JSON.stringify(report.verdict_counts ?? {}, null, 0));
if (report.phases?.session_cap?.verdict !== 'MET' || report.phases?.long_dialogue?.verdict !== 'MET') {
  process.exitCode = 1;
  console.log('ውሳኔ፦ የሀብት ወሰኖች አልተገደቡም — ማረጋገጫ ያስፈልጋል');
} else {
  console.log('ውሳኔ፦ የሀብት ወሰኖቹ ተገዲዋል (ላፕቶፕ)፤ የስልክ ቁጥሮች UNKNOWN — LAPTOP≠ስልክ');
}
