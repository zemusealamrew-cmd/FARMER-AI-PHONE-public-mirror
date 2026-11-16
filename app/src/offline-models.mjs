// Optional G1 research backend. Local stdio only; never fetches models at runtime.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
const root = new URL('../', import.meta.url);
const python = () => process.env.G1_MODEL_PYTHON ?? fileURLToPath(new URL(process.platform === 'win32' ? '.tmp/model-venv/Scripts/python.exe' : '.tmp/model-venv/bin/python', root));
export const offlineModelsEnabled = () => process.env.G1_OFFLINE_MODELS === '1';
let worker, pending, timer;
export function offlineModelStatus() {
  return { enabled: offlineModelsEnabled(), python_present: existsSync(python()), engine: 'local-safetensors-cpu', network_required: false, gate: 'G1_RESEARCH_ONLY', acceptance: 'REQUIRES EVIDENCE', tts_noncommercial_opt_in: process.env.G1_NONCOMMERCIAL_RESEARCH === '1' };
}
export function stopOfflineWorker(code = 'OFFLINE_MODEL_INTERRUPTED') {
  const child = worker; worker = null;
  if (pending) { const resolve = pending; pending = null; clearTimeout(timer); resolve({ ok: false, code, text: null }); }
  if (child) {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch { child.kill(); }
  }
}
export function runOfflineModel(job, timeoutMs = 180000) {
  if (!offlineModelsEnabled()) return Promise.resolve({ ok: false, code: 'OFFLINE_MODELS_DISABLED' });
  if (pending) return Promise.resolve({ ok: false, code: 'OFFLINE_MODEL_BUSY' });
  if (!worker) {
    worker = spawn(python(), [fileURLToPath(new URL('src/offline_models.py', root))], {
      // Windows child stdio would otherwise use the ANSI code page (cp1252):
      // Amharic job input is mojibaked and non-ANSI results kill the worker
      // with UnicodeEncodeError. Pin UTF-8 on both protocol pipes.
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const current = worker;
    // Keep third-party warnings out of responses, logs and microphone evidence.
    current.stderr.on('data', () => {});
    createInterface({ input: current.stdout }).on('line', line => {
      if (worker !== current || !pending) return;
      let result; try { result = JSON.parse(line); } catch { stopOfflineWorker('OFFLINE_MODEL_PROTOCOL_ERROR'); return; }
      const resolve = pending; pending = null; clearTimeout(timer); resolve(result);
    });
    current.once('error', () => { if (worker === current) stopOfflineWorker('OFFLINE_MODEL_SPAWN_FAILED'); });
    current.once('exit', () => { if (worker === current) stopOfflineWorker('OFFLINE_MODEL_EXITED'); });
  }
  return new Promise(resolve => {
    pending = resolve;
    timer = setTimeout(() => stopOfflineWorker('OFFLINE_MODEL_TIMEOUT'), timeoutMs);
    worker.stdin.write(JSON.stringify(job) + '\n', error => { if (error) stopOfflineWorker(); });
  });
}
