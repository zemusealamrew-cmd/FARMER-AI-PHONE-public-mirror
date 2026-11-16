// G1 ASR Windows I/O regression tests (proven product defects).
//   (i)  the python worker must speak UTF-8 over its stdio pipes on Windows,
//        where the default ANSI code page (cp1252 here) otherwise raises
//        UnicodeDecodeError / UnicodeEncodeError for Amharic job data;
//   (ii) read_audio() must work on non-ASCII Windows paths.
// These tests use the real product worker app/src/offline_models.py and a
// missing audio path, so no model weights are loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { runOfflineModel, offlineModelStatus, stopOfflineWorker } from '../app/src/offline-models.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const WORKER = join(ROOT, 'app', 'src', 'offline_models.py');
const PYTHON = process.env.G1_MODEL_PYTHON
  ?? join(ROOT, '.tmp', process.platform === 'win32' ? 'model-venv/Scripts/python.exe' : 'model-venv/bin/python');
const AMHARIC_DIR = 'ፋርመር ai';
const MISSING_PATH = 'C:\\Users\\DY Group\\OneDrive\\Documents\\ChatGPT\\' + AMHARIC_DIR + '\\.tmp\\__does_not_exist__.wav';
const skip = !existsSync(PYTHON) ? 'python worker runtime not present (set G1_MODEL_PYTHON)' : false;

function bareEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.PYTHONUTF8;
  delete env.PYTHONIOENCODING;
  for (const key of ['PYTHONLEGACYWINDOWSSTDIO']) delete env[key];
  return env;
}

function spawnWorker(env) {
  const child = spawn(PYTHON, [WORKER], { cwd: ROOT, env });
  const out = [];
  const err = [];
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.on('data', (chunk) => err.push(chunk));
  const done = new Promise((resolveDone) => child.once('close', (code) => resolveDone({ code, out: Buffer.concat(out), err: Buffer.concat(err) })));
  return { child, done };
}

test('product worker round-trips non-ASCII job data on Windows', { skip }, async () => {
  const saved = { enabled: process.env.G1_OFFLINE_MODELS, python: process.env.G1_MODEL_PYTHON, utf8: process.env.PYTHONUTF8, ioenc: process.env.PYTHONIOENCODING };
  try {
    // Reproduce the real product environment: the Node backend inherits
    // process.env, and a real host does not export PYTHONUTF8.
    delete process.env.PYTHONUTF8;
    delete process.env.PYTHONIOENCODING;
    process.env.G1_OFFLINE_MODELS = '1';
    process.env.G1_MODEL_PYTHON = PYTHON;
    const status = offlineModelStatus();
    assert.equal(status.enabled, true);
    const result = await runOfflineModel({ kind: 'asr', locale: 'am', path: MISSING_PATH }, 120000);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OFFLINE_MODEL_FAILED', 'expected the worker to report the missing input file, not to die on pipe encoding: ' + JSON.stringify(result));
    assert.match(String(result.detail), new RegExp(AMHARIC_DIR), 'the Unicode path must survive the JSON pipe unchanged');
    assert.ok(!result.detail.includes('\uFFFD'));
  } finally {
    stopOfflineWorker();
    if (saved.enabled === undefined) delete process.env.G1_OFFLINE_MODELS; else process.env.G1_OFFLINE_MODELS = saved.enabled;
    if (saved.python === undefined) delete process.env.G1_MODEL_PYTHON; else process.env.G1_MODEL_PYTHON = saved.python;
    if (saved.utf8 !== undefined) process.env.PYTHONUTF8 = saved.utf8;
    if (saved.ioenc !== undefined) process.env.PYTHONIOENCODING = saved.ioenc;
  }
});

test('worker decodes UTF-8 job input even when spawned without PYTHONUTF8', { skip }, async () => {
  const { child, done } = spawnWorker(bareEnv());
  child.stdin.write(JSON.stringify({ kind: 'asr', locale: 'am', path: MISSING_PATH }) + '\n');
  child.stdin.end();
  const { code, out, err } = await done;
  assert.equal(code, 0, 'worker must not die on stdin decoding; stderr=' + err.toString('utf8').slice(-400));
  const line = out.toString('utf8').trim().split('\n').filter(Boolean).pop();
  const result = JSON.parse(line);
  assert.equal(result.ok, false);
  assert.match(String(result.detail), new RegExp(AMHARIC_DIR));
});

test('worker writes UTF-8 job output even when spawned without PYTHONUTF8', { skip }, async () => {
  const { child, done } = spawnWorker(bareEnv());
  // ASCII-only JSON: the non-ASCII text exists only in the result, isolating
  // the stdout encode direction from the stdin decode direction.
  child.stdin.write(JSON.stringify({ kind: 'asr', locale: 'am', path: MISSING_PATH }, null, 0).replace(/[^\x00-\x7F]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
  child.stdin.end();
  const { code, out, err } = await done;
  assert.equal(code, 0, 'worker must not die on stdout encoding; stderr=' + err.toString('utf8').slice(-400));
  const result = JSON.parse(out.toString('utf8').trim().split('\n').filter(Boolean).pop());
  assert.equal(result.ok, false);
  assert.match(String(result.detail), new RegExp(AMHARIC_DIR));
});

test('read_audio regression: python helper reads soundfile from memory (non-ASCII path)', { skip: skip || (process.platform !== 'win32' ? 'windows-specific path test' : false) }, async () => {
  const script = join(HERE, 'asr_quality_test.py');
  const result = await new Promise((resolveRun) => {
    const child = spawn(PYTHON, [script], { cwd: ROOT, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    const out = []; const err = [];
    child.stdout.on('data', (c) => out.push(c)); child.stderr.on('data', (c) => err.push(c));
    child.once('close', (code) => resolveRun({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }));
  });
  assert.equal(result.code, 0, 'python read_audio regression suite failed:\n' + result.out + result.err);
});
