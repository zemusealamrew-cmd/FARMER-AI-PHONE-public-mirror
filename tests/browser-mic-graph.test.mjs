// Issue #5 / F-08: instrumented Web Audio API contract test, NOT a real-browser or human-speech acceptance test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../app/public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('async function startRecording()');
const end = html.indexOf("$('micBtn').onclick = startRecording;", start);
assert.ok(start >= 0 && end > start, 'recording functions are present in the HTML');
const recordingFunctions = html.slice(start, end);
const auditSource = readFileSync(new URL('../app/public/capture-audit.js', import.meta.url), 'utf8');
const encodeFunction = html.slice(html.indexOf('function encodeWav('), html.indexOf('function abToB64('));
assert.doesNotMatch(recordingFunctions, /getAudioTracks\(\)\[0\]\.connect\(/, 'MediaStreamTrack has no connect()');
assert.match(recordingFunctions, /createMediaStreamSource\(stream\)/, 'Web Audio source must be created from MediaStream');

function instrument({ denied = false, sourceFails = false } = {}) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', value: '', hidden: false, open: false,
      showModal() { this.open = true; },
      close() { this.open = false; },
      pause() { this.paused = true; },
      removeAttribute(name) { delete this[name]; },
      load() {},
    });
    return elements.get(id);
  };
  const node = () => ({
    connections: [], disconnected: false,
    connect(target) { this.connections.push(target); },
    disconnect() { this.disconnected = true; },
  });
  const track = { stopped: false, label: 'Test microphone', getSettings() { return { sampleRate: 48000, channelCount: 1, echoCancellation: true, noiseSuppression: false }; }, stop() { this.stopped = true; } };
  // Deliberately no track.connect(): standard MediaStreamTrack is not an AudioNode.
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const phases = [];
  const sent = [];
  const timers = [];
  const urls = [], revoked = [];
  let contextInstance = null;
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 16000;
      this.destination = node();
      this.closed = false;
      contextInstance = this;
    }
    createMediaStreamSource(actual) {
      assert.equal(actual, stream);
      if (sourceFails) throw new Error('source init failed');
      this.source = node();
      return this.source;
    }
    createScriptProcessor(size, inputs, outputs) {
      assert.equal(size, 4096);
      assert.equal(inputs, 1);
      assert.equal(outputs, 1);
      this.processor = node();
      return this.processor;
    }
    createGain() {
      this.gainNode = { ...node(), gain: { value: 1 } };
      return this.gainNode;
    }
    async resume() { this.state = 'running'; }
    async close() { this.closed = true; this.state = 'closed'; }
  }
  const state = { aiKey: true, recording: null };
  const sandbox = {
    S: state,
    $: el,
    navigator: { mediaDevices: { async getUserMedia() {
      if (denied) throw Object.assign(new Error('permission denied'), { name: typeof denied === 'string' ? denied : 'NotAllowedError' });
      return stream;
    } } },
    AudioContext: FakeAudioContext,
    location: { hostname: 'localhost' },
    Blob,
    URL: { createObjectURL(blob) { urls.push(blob); return `blob:local-preview/${urls.length}`; }, revokeObjectURL(url) { revoked.push(url); } },
    aiPhase: async (phase) => { phases.push(phase); },
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: () => {},
    post: async (path, body) => {
      sent.push({ path, body });
      return { type: 'unknown', code: 'TEST_RESPONSE' };
    },
    resample: (samples, from, to) => {
      assert.equal(from, 16000);
      assert.equal(to, 16000);
      return samples;
    },
    encodeWav: (samples, rate) => {
      assert.equal(rate, 16000);
      return new Uint8Array(44 + samples.length * 2);
    },
    abToB64: () => 'INSTRUMENTED_WAV',
    renderAnswer: () => {},
    updateInteractionControls: () => {},
    show: (id, value) => { el(id).textContent = JSON.stringify(value); },
  };
  runInNewContext(auditSource + encodeFunction + recordingFunctions + '\nglobalThis.__recordingHooks = { startRecording, stopRecording, cancelRecording, sendCapturedWav: typeof sendCapturedWav === "function" ? sendCapturedWav : undefined };', sandbox);
  return {
    startRecording: sandbox.__recordingHooks.startRecording,
    stopRecording: sandbox.__recordingHooks.stopRecording,
    hooks: sandbox.__recordingHooks, sandbox, urls, revoked,
    state, el, stream, track, phases, sent, timers,
    ctx: () => contextInstance,
  };
}

test('Issue #5: microphone source connects to muted processor and nonzero capture sends WAV', async () => {
  const x = instrument();
  await x.startRecording();
  assert.ok(x.state.recording, 'capture starts without MediaStreamTrack.connect');
  const ctx = x.ctx();
  assert.equal(ctx.source.connections[0], ctx.processor);
  assert.equal(ctx.processor.connections[0], ctx.gainNode);
  assert.equal(ctx.gainNode.gain.value, 0, 'microphone must not echo through laptop speakers');
  assert.equal(ctx.gainNode.connections[0], ctx.destination);
  assert.equal(x.el('recDialog').open, true);
  ctx.processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(8192).fill(0.25) } });
  assert.ok(Number(x.el('recLevel').value) > 0);
  await x.stopRecording(true);
  assert.equal(x.sent.length, 1);
  assert.equal(x.sent[0].path, '/api/audio');
  assert.equal(x.sent[0].body.wav_base64, 'INSTRUMENTED_WAV');
  assert.equal(x.track.stopped, true);
  assert.equal(ctx.source.disconnected, true);
  assert.equal(ctx.processor.disconnected, true);
  assert.equal(ctx.gainNode.disconnected, true);
  assert.equal(ctx.closed, true);
  assert.deepEqual(x.phases, ['LISTENING', 'IDLE']);
  assert.equal(x.state.recording, null);
});

test('Issue #5: preview retains audio locally and cancellation revokes playback without upload', async () => {
  const x = instrument();
  await x.startRecording();
  x.ctx().processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(8192).fill(0.2) } });
  await x.stopRecording('preview');
  assert.equal(x.sent.length, 0);
  assert.ok(x.state.capturePreview);
  assert.equal(x.urls[0].type, 'audio/wav');
  assert.equal(x.el('captureReview').hidden, false);
  assert.equal(x.track.stopped, true);
  await x.hooks.cancelRecording();
  assert.equal(x.state.capturePreview, null);
  assert.equal(x.el('captureReview').hidden, true);
  assert.deepEqual(x.revoked, ['blob:local-preview/1', 'blob:local-preview/2']);
  assert.equal(x.el('captureAudio').paused, true);
  assert.equal(x.sent.length, 0);
});

test('Issue #5: permission/device failures expose distinct stage and browser error codes', async () => {
  for (const [name, code] of [['NotAllowedError','MIC_PERMISSION_DENIED'], ['NotFoundError','MIC_DEVICE_NOT_FOUND'], ['NotReadableError','MIC_DEVICE_UNREADABLE'], ['OverconstrainedError','MIC_CONSTRAINT_UNSATISFIED']]) {
    const x = instrument({ denied: name });
    await x.startRecording();
    const diag = JSON.parse(x.el('micDiagnostics').textContent);
    assert.equal(diag.stage, 'permission/device');
    assert.equal(diag.code, code);
    assert.equal(x.sent.length, 0);
  }
});

test('Issue #5: no processor callbacks differs from recorded silence and never uploads', async () => {
  const x = instrument();
  await x.startRecording();
  await x.stopRecording('preview');
  assert.equal(JSON.parse(x.el('micDiagnostics').textContent).code, 'NO_AUDIO_FRAMES');
  assert.equal(x.sent.length, 0);
  assert.equal(x.urls.length, 0);
});

test('Issue #5: disabled track releases resources and reports initialization stage', async () => {
  const x = instrument(); x.track.enabled = false;
  await x.startRecording();
  assert.equal(JSON.parse(x.el('micDiagnostics').textContent).code, 'MIC_TRACK_UNAVAILABLE');
  assert.equal(x.track.stopped, true);
  assert.equal(x.ctx().closed, true);
  assert.equal(x.sent.length, 0);
});

test('Issue #5: upload failure reports HTTP stage rather than a speech rejection', async () => {
  const x = instrument();
  x.sandbox.post = async () => { throw new TypeError('failed fetch'); };
  await x.startRecording();
  x.ctx().processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(8192).fill(0.2) } });
  await x.stopRecording(true);
  const diag = JSON.parse(x.el('micDiagnostics').textContent);
  assert.equal(diag.stage, 'http'); assert.equal(diag.code, 'AUDIO_UPLOAD_FAILED');
  assert.equal(x.track.stopped, true);
});

test('Issue #5: preview send is blocked after call preemption, key revocation or on remote origin', async () => {
  for (const change of [x => { x.state.callActive = true; }, x => { x.state.aiKey = false; }, x => { x.sandbox.location.hostname = 'example.com'; }]) {
    const x = instrument(); await x.startRecording();
    x.ctx().processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(8192).fill(0.2) } });
    await x.stopRecording('preview');
    const wav = x.state.capturePreview.wav;
    change(x);
    await x.hooks.sendCapturedWav(wav);
    assert.equal(x.sent.length, 0);
    await x.hooks.cancelRecording();
  }
});

test('Issue #5: failure in resampling is identified before WAV or HTTP', async () => {
  const x = instrument(); x.sandbox.resample = () => { throw new Error('conversion failed'); };
  await x.startRecording();
  x.ctx().processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(8192).fill(0.2) } });
  await x.stopRecording('preview');
  const diag = JSON.parse(x.el('micDiagnostics').textContent);
  assert.equal(diag.stage, 'resampling'); assert.equal(diag.code, 'CAPTURE_ENCODING_FAILED');
  assert.equal(x.sent.length, 0);
});

test('Issue #5: permission denial never opens recorder or posts audio', async () => {
  const x = instrument({ denied: true });
  await x.startRecording();
  assert.equal(x.state.recording, null);
  assert.equal(x.el('recDialog').open, false);
  assert.equal(x.sent.length, 0);
});

test('Issue #5: live meter returns to zero after a transient while capture peak is retained', async () => {
  const x = instrument();
  await x.startRecording();
  const feed = samples => x.ctx().processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
  feed(new Float32Array(4096).fill(0.25));
  assert.ok(Number(x.el('recLevel').value) > 0);
  feed(new Float32Array(4096));
  assert.equal(Number(x.el('recLevel').value), 0, 'silence must not display an earlier transient as current input');
  assert.equal(Number(x.el('recPeak').textContent), 0.25, 'separate capture maximum remains available');
  await x.stopRecording(false);
});

test('Issue #5: recorder displays actual local track settings without persistent device IDs', async () => {
  const x = instrument();
  await x.startRecording();
  const info = JSON.parse(x.el('recDevice').textContent);
  assert.equal(info.label, 'Test microphone');
  assert.equal(info.track_sample_rate, 48000);
  assert.equal(info.context_sample_rate, 16000);
  assert.equal(info.output_sample_rate, 16000);
  assert.equal(info.echo_cancellation, true);
  assert.equal(info.noise_suppression, false);
  assert.equal(info.deviceId, undefined);
  assert.equal(x.sent.length, 0);
  await x.stopRecording(false);
});

test('Issue #5: cancelled capture closes resources and never sends audio', async () => {
  const x = instrument();
  await x.startRecording();
  const ctx = x.ctx();
  ctx.processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(8192).fill(0.4) } });
  await x.stopRecording(false);
  assert.equal(x.sent.length, 0);
  assert.equal(ctx.closed, true);
  assert.equal(x.track.stopped, true);
  assert.equal(x.el('recDialog').open, false);
});

test('Issue #5: silent or too-short capture does not invoke /api/audio', async () => {
  for (const capture of [new Float32Array(8192), new Float32Array(1000).fill(0.2)]) {
    const x = instrument();
    await x.startRecording();
    x.ctx().processor.onaudioprocess({ inputBuffer: { getChannelData: () => capture } });
    await x.stopRecording(true);
    assert.equal(x.sent.length, 0);
    assert.equal(x.track.stopped, true);
    assert.equal(x.ctx().closed, true);
  }
});

test('Issue #5: source initialization failure stops tracks, closes context, and does not post', async () => {
  const x = instrument({ sourceFails: true });
  await x.startRecording();
  assert.equal(x.state.recording, null);
  assert.equal(x.track.stopped, true);
  assert.equal(x.ctx().closed, true);
  assert.equal(x.sent.length, 0);
});

test('Issue #5: AI key off prevents opening microphone', async () => {
  const x = instrument();
  x.state.aiKey = false;
  await x.startRecording();
  assert.equal(x.state.recording, null);
  assert.equal(x.ctx(), null);
  assert.equal(x.sent.length, 0);
});

test('Issue #5: concurrent starts request microphone permission only once', async () => {
  const x = instrument();
  await Promise.all([x.startRecording(), x.startRecording()]);
  assert.equal(x.timers.length, 1);
  await x.stopRecording(false);
});

test('Issue #5: revoked AI key during permission wait releases late stream without opening graph', async () => {
  const x = instrument();
  const pending = x.startRecording();
  x.state.aiKey = false;
  await pending;
  assert.equal(x.track.stopped, true);
  assert.equal(x.ctx(), null);
  assert.equal(x.state.recording, null);
  assert.equal(x.sent.length, 0);
});
