// Actual HTTP -> pinned local LLM evaluation. No inference test doubles.
// Supply --root <archived-checkout> --out <report.json> --label <ref>.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { platform, release, totalmem, cpus } from 'node:os';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const root = resolve(option('--root', '.'));
const out = resolve(option('--out', 'evidence/context-real-inference.json'));
const label = option('--label', 'working-tree');
const port = Number(option('--port', '8981'));
const base = `http://127.0.0.1:${port}`;
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const cases = [
  { id: 'am-name-count-correction', locale: 'am', turns: [
    'ስሜ ሀና ነው። ሁለት በሬዎች አሉኝ።',
    'ስሜ ማን ነው፣ ስንት በሬዎች አሉኝ?',
    'ትክክለኛው ብዛት ሶስት ነው። አሁን ስንት በሬዎች አሉኝ?'],
    expected: [null, { name: ['ሀና', 'ሐና'], count: ['ሁለት', '2', '፪'] }, { count: ['ሶስት', 'ሦስት', '3', '፫'] }] },
  { id: 'om-name-count-correction', locale: 'om', turns: [
    'Maqaan koo Caalaa dha. Sangoota lama qaba.',
    'Maqaan koo eenyu? Sangoota meeqa qaba?',
    'Lakkoofsi sirriin sadii dha. Amma sangoota meeqa qaba?'],
    expected: [null, { name: ['Caalaa'], count: ['lama', '2'] }, { count: ['sadii', '3'] }] },
];
const report = {
  date: new Date().toISOString(), label, gate: 'G1 HOLD',
  scope: 'diagnostic synthetic text cases with real pinned local inference; not held-out native-speaker acceptance',
  native_speaker_signoff: false, training_performed: false, microphone_used: false,
  host: { platform: platform(), release: release(), logical_cpus: cpus().length, memory_bytes: totalmem() },
  hashes: Object.fromEntries(['app/server.mjs', 'app/src/offline_models.py', 'app/src/model_prompt.py', 'app/src/offline-models.mjs', 'app/src/generation-guard.mjs', 'model_registry/offline-g1-profile.json'].map(p => [p, hash(join(root, p))])),
  results: [], errors: [],
  measurement_limits: ['Model RSS fields are process-lifetime high-water marks, not per-turn samples.',
    'Keyword recall scores are diagnostic only; they cannot certify meaning, fluency or safety.',
    'Published failure examples are not an independent held-out acceptance set.'],
};
mkdirSync(dirname(out), { recursive: true });
const save = () => writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
const state = join(root, 'app/.tmp/context-check-' + port);
mkdirSync(state, { recursive: true });
writeFileSync(join(state, 'prompt-hashes.jsonl'), '');
const server = spawn(process.execPath, ['app/server.mjs'], { cwd: root,
  env: { ...process.env, PORT: String(port), G1_OFFLINE_MODELS: '1',
    EVIDENCE_PATH: join(state, 'events.jsonl'), UPDATE_STATE_DIR: join(state, 'updates'), BUILD_REF: label,
    G1_PROMPT_TRACE_PATH: join(state, 'prompt-hashes.jsonl') },
  stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
server.stderr.on('data', b => { stderr += b; });
server.stdout.on('data', () => {});
const post = async (path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(240000) });
  return { http: response.status, ...await response.json() };
};
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw new Error('SERVER_EXITED: ' + stderr);
    try { ready = (await fetch(base + '/api/status')).ok; } catch {}
    if (ready) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!ready) throw new Error('SERVER_NOT_READY');
  for (const example of cases.filter(c => !option('--locale') || c.locale === option('--locale'))) {
    const { session_id } = await post('/api/session', {});
    for (let i = 0; i < example.turns.length; i++) {
      const start = performance.now();
      const traceBytes = statSync(join(state, 'prompt-hashes.jsonl')).size;
      const result = await post('/api/text', { session_id, locale: example.locale, text: example.turns[i] });
      const expected = example.expected[i];
      const checks = expected ? Object.fromEntries(Object.entries(expected).map(([key, tokens]) =>
        [key, result.code === 'GENERATED' && tokens.some(token => String(result.text).toLowerCase().includes(token.toLowerCase()))])) : null;
      if (statSync(join(state, 'prompt-hashes.jsonl')).size <= traceBytes) throw new Error('NO_FRESH_REAL_WORKER_PROMPT_TRACE');
      const prompt = JSON.parse(readFileSync(join(state, 'prompt-hashes.jsonl'), 'utf8').trim().split('\n').at(-1));
      const firstHash = createHash('sha256').update(example.turns[0]).digest('hex');
      const currentHash = createHash('sha256').update(example.turns[i]).digest('hex');
      const userHashes = prompt.messages.filter(m => m.role === 'user').map(m => m.content_sha256);
      if (userHashes.at(-1) !== currentHash) throw new Error('PROMPT_TRACE_DOES_NOT_MATCH_CURRENT_REQUEST');
      report.results.push({ case: example.id, turn: i + 1, locale: example.locale,
        input: example.turns[i], wall_ms: Math.round(performance.now() - start), diagnostic_recall: checks,
        actual_worker_prompt: { ...prompt, first_user_turn_present: userHashes.includes(firstHash) }, result });
      save();
      console.log(JSON.stringify({ label, case: example.id, turn: i + 1, code: result.code, diagnostic_recall: checks }));
    }
  }
  report.completed = true;
} catch (error) {
  report.errors.push(String(error.stack ?? error));
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) { server.kill(); await new Promise(r => server.once('exit', r)); }
  report.server_stderr = stderr.slice(-2000);
  save();
}
