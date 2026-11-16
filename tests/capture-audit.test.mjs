// Signal-conversion and local-diagnostic regressions, NOT owner-microphone acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../app/public/capture-audit.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../app/public/index.html', import.meta.url), 'utf8');
function api(extra = {}) {
  const context = { Blob, setTimeout, clearTimeout, ...extra };
  runInNewContext(source, context);
  return context.CaptureAudit;
}
const tone = (rate, hz, seconds = 1) => Float32Array.from({ length: rate * seconds }, (_, i) => 0.2 * Math.sin(2 * Math.PI * hz * i / rate));
const rms = input => Math.sqrt(input.reduce((sum, v) => sum + v * v, 0) / input.length);
const track = () => ({ label: 'private device label', enabled: true, muted: false, readyState: 'live', getSettings: () => ({ deviceId: 'private-id', groupId: 'private-group', sampleRate: 48000, channelCount: 1 }) });
const stream = () => ({ getAudioTracks: () => [track()] });

test('capture conversion: 20kHz at 48kHz must not alias into a 4kHz whistle at 16kHz', () => {
  const out = api().resample(tone(48000, 20000), 48000, 16000);
  assert.equal(out.length, 16000);
  assert.ok(rms(out.subarray(1600, -1600)) < 0.001, 'stopband RMS must be below 0.001 for this diagnostic stimulus');
});

test('capture conversion: retain voice-band components and exact duration at 44.1/48kHz', () => {
  for (const rate of [44100, 48000]) for (const hz of [250, 1000, 3000]) {
    const out = api().resample(tone(rate, hz), rate, 16000);
    assert.equal(out.length, 16000);
    const expected = tone(16000, hz);
    const error = out.subarray(160, -160).map((v, i) => v - expected[i + 160]);
    assert.ok(rms(error) < 0.001, `${rate}/${hz} passband error`);
  }
});

test('capture diagnostics: five seconds with one click is distinguishable from continuous signal', () => {
  const click = new Float32Array(80000); click[1600] = 0.5;
  const audit = api().signal(click, 16000);
  assert.equal(audit.seconds, 5);
  assert.equal(audit.nonzero_frames, 1);
  assert.equal(audit.windows_at_or_above_one_pcm16_lsb, 1);
  assert.ok(audit.longest_digital_zero_seconds > 4);
  assert.equal(audit.speech_verified, false);
  assert.equal(api().signal(new Float32Array(80000), 16000).nonzero_frames, 0);
});

test('capture conversion: WAV header and every quantized sample match the converted PCM', () => {
  const context = {};
  runInNewContext(html.slice(html.indexOf('function encodeWav('), html.indexOf('function abToB64(')), context);
  const pcm = api().resample(tone(44100, 1000), 44100, 16000);
  const bytes = context.encodeWav(pcm, 16000), header = new DataView(bytes);
  assert.equal(bytes.byteLength, 32044);
  assert.equal(header.getUint32(24, true), 16000);
  assert.equal(header.getUint16(22, true), 1);
  assert.equal(header.getUint16(34, true), 16);
  assert.equal(header.getUint32(40, true), 32000);
  for (let i = 0; i < pcm.length; i++) assert.ok(Math.abs(header.getInt16(44 + i * 2, true) / 32768 - pcm[i]) < 2 / 32768);
});

class NativeRecorder {
  constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    setTimeout(() => { this.ondataavailable({ data: new Blob(['late-local-bytes'], { type: this.mimeType }) }); this.onstop(); }, 1);
  }
}
test('capture diagnostics: cancellation drops late native chunks and never retains a playable Blob', async () => {
  const a = api({ MediaRecorder: NativeRecorder });
  const pending = a.begin(stream(), { state: 'running', sampleRate: 48000 }, true);
  const result = await a.finish(pending, false);
  assert.equal(result.blob, null); assert.equal(result.report.native.bytes, 0);
  assert.equal(result.report.native.code, 'DISCARDED');
  await new Promise(resolve => setTimeout(resolve, 10)); // exercise the late dataavailable callback
  assert.equal(pending.native.chunks.length, 0);
});

test('capture diagnostics: independent native reference finishes and counts PCM callbacks', async () => {
  const a = api({ MediaRecorder: NativeRecorder });
  const pending = a.begin(stream(), { state: 'running', sampleRate: 48000 }, true);
  a.frame(pending, { inputBuffer: { sampleRate: 48000, numberOfChannels: 1 } }, 4096);
  const result = await a.finish(pending, true);
  assert.equal(result.report.callbacks, 1); assert.equal(result.report.frames, 4096);
  assert.equal(result.report.buffer_sample_rate, 48000);
  assert.ok(result.blob.size > 0); assert.equal(result.report.native.code, 'STOPPED');
});

test('capture diagnostics: metadata excludes device IDs, labels and audio when native recorder is unavailable', async () => {
  const a = api(), pending = a.begin(stream(), { state: 'running', sampleRate: 48000 }, false);
  const result = await a.finish(pending, true), text = JSON.stringify(result.report);
  assert.equal(result.report.native.code, 'UNSUPPORTED');
  assert.doesNotMatch(text, /private-id|private-group|private device label|deviceId|groupId|base64/);
  assert.equal(result.report.speech_verified, false);
});

test('capture conversion: invalid samples or rates fail explicitly rather than becoming a tiny artifact', () => {
  assert.throws(() => api().resample(Float32Array.of(NaN), 48000, 16000), /NONFINITE_PCM/);
  assert.throws(() => api().resample(Float32Array.of(0), 0, 16000), /INVALID_SAMPLE_RATE/);
});
