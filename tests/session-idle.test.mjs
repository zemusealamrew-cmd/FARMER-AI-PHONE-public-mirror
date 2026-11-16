// F-07 / NR-01 / R-38፦ ያሰማራ ክፍለ-ጊዜ (idle session) በጊዜ ወሰን ይወገዳል?
// ደንቡ፦ ገደቡ በኮድ ውስጥ መኖሩ በቂ አይደለም — በእውነተኛ ሂደት ላይ ጊዜው ተሰምሮ መወገዱ መታየት አለበው።
// SESSION_IDLE_MS በENV ሲጠራጨር ፍተሻው አጭር ጊዜ ይጠቀማል፤ የማሳያው ነባሪ ዋጋ 30 ደቂቃ ነው።
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SESSION_SMOKE_PORT ?? 8941);
const BASE = `http://127.0.0.1:${PORT}`;
const IDLE_MS = 250;
const EVIDENCE = join(mkdtempSync(join(tmpdir(), 'farmersidle-')), 'idle-events.jsonl');

let child = null;

async function call(route, body) {
  const [method, path] = route.split(' ');
  const query = method === 'GET' && body ? `?${new URLSearchParams(body)}` : '';
  const res = await fetch(`${BASE}${path}${query}`, method === 'GET'
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, json: await res.json() };
}

const sleep = (ms) => new Promise((d) => setTimeout(d, ms));

before(async () => {
  child = spawn(process.execPath, [join(REPO, 'app', 'server.mjs')], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SESSION_IDLE_MS: String(IDLE_MS), EVIDENCE_PATH: EVIDENCE, UPDATE_STATE_DIR: join(REPO, '.tmp', 'session-idle-state') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await call('GET /api/status')).status === 200) return;
    } catch {
      // እንደገና እንሞክራለን
    }
    await sleep(100);
  }
  throw new Error(`ማሳያ አልተጀመረም፦ ${stderr.slice(0, 300)}`);
});

after(() => {
  child?.kill();
});

test('F-07፦ የተሰየመው የidle ወሰን በወሰን ሪፖርት ውስጥ ግልጽ ነው', async () => {
  const s = await call('GET /api/status');
  assert.equal(s.json.limits.resource.session_idle_ms, IDLE_MS, 'ENV ወሰኑ ሪፖርት መድረስ አለበት');
  const m = await call('GET /api/metrics');
  assert.equal(m.json.sessions.session_idle_ms, IDLE_MS, 'metrics ላም ሪፖርት ተደርጓል');
});

test('F-07/NR-01፦ ያሰማራ ክፍለ-ጊዜ ከጊዜ በኋላ ይወገዳል — ተወግዶ የቀረ መለያ 409 ይመልሳል', async () => {
  const before = (await call('GET /api/metrics')).json.sessions;
  const stale = (await call('POST /api/session', {})).json.session_id;
  await sleep(IDLE_MS + 120);
  // ሁለተኛው ክፍለ-ጊዜ ሽረቱን (sweep) ያሰጫል
  const fresh = (await call('POST /api/session', {})).json.session_id;
  const after = (await call('GET /api/metrics')).json.sessions;
  assert.ok(after.sessions_evicted > before.sessions_evicted, 'ያሰማራ ክፍለ-ጊወ ሲወገድ ተቆጣጣሪው መጨመር አለበት');
  const dead = await call('POST /api/text', { session_id: stale, text: 'የበቆሎ ዘር እንዴት ይዘራል' });
  assert.equal(dead.status, 409, 'የጊዜው ያለፈ ክፍለ-ጊዜ መልሰው ግልጽ ውድቀት መመለስ አለበት');
  assert.equal(dead.json.code, 'SESSION_UNKNOWN');
  const alive = await call('POST /api/text', { session_id: fresh, text: 'የበቆሎ ዘር እንዴት ይዘራል' });
  assert.equal(alive.status, 200, 'አዲሱ ክፍለ-ጊዜ ሥራ ላይ መሆን አለበት');
  assert.ok(existsSync(EVIDENCE), 'የማስረጃ መዝገቡ ተጽፏል');
  const log = readFileSync(EVIDENCE, 'utf8');
  assert.ok(log.includes('"session_idle_expired"'), 'ማስወገዱ በማስረጃ መዝገብ ተመዝግቧል');
});

test('F-07፦ idle ማጽዳት ከsession ወሰን ጋር አብሮ ይሠራል (active ≤ limit)', async () => {
  const limit = (await call('GET /api/metrics')).json.sessions.max_sessions;
  for (let i = 0; i < limit + 3; i += 1) await call('POST /api/session', {});
  const now = (await call('GET /api/metrics')).json.sessions;
  assert.ok(now.active <= limit, `ያለ ገደብ አደለ፦ active=${now.active}`);
});
