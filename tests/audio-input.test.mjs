// F-08 / R-02 / CI-03፦ የግብይት ጥበቃ (inspectWav) ፍተሻ — ኢንጂን የማይጠይቅ ስለሆነ በእያንዳንዱ ማሽን ይሮጣል።
// ደንቡ፦ ያለ ድምፅ ወይም ካልተጫነ ቅርጽ ያለው ግብይት ለኢንጂን ሊላክ አይገባም፤ ማስረጃው በግልጽ ኮድ ይታዘዛል።
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INPUT_GUARD_CODES, inspectWav, MIN_CAPTURE_SECONDS } from '../app/src/asr.mjs';

function pcm16(seconds, { rate = 16000, channels = 1, amplitude = 0 } = {}) {
  const frames = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + frames * channels * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + frames * channels * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(frames * channels * 2, 40);
  if (amplitude) {
    for (let i = 0; i < frames; i += 1) {
      const v = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 440 * i) / rate));
      buf.writeInt16LE(v, 44 + i * channels * 2);
    }
  }
  return buf;
}

test('F-08፦ ድምፅ ያለው 16kHz mono ግብይት ያለ እንቅፋት ያልፋል', () => {
  const r = inspectWav(pcm16(0.5, { amplitude: 0.4 }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.code, 'INPUT_OK');
  assert.equal(r.sample_rate, 16000);
  assert.equal(r.channels, 1);
  assert.equal(r.bits, 16);
  assert.equal(r.seconds, 0.5);
  assert.ok(r.peak > 1000, `ጫጫታ ተለክቷል (${r.peak})`);
});

test('F-08 / R-02፦ ሙሉ ጸጥታ SILENT_CAPTURE ይመልሳል — «አልተረዳሁም» ሳይሆን «ድምፅ አልደረሰም»', () => {
  const r = inspectWav(pcm16(1));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SILENT_CAPTURE');
  assert.equal(r.peak, 0, 'ዜሮ ጫጫታ ለማስረጃ ይገለጻል');
  assert.equal(r.seconds, 1, 'ርዝመቱ ተለክቶ ተካትቷል');
  assert.match(r.detail, /microphone/i, 'ምክንያቱ በግልጽ ተናግሯል');
});

test('F-08፦ ከዝቅተኛው ርዝመት በታች AUDIO_TOO_SHORT ይመልሳል', () => {
  const r = inspectWav(pcm16(0.1, { amplitude: 0.5 }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AUDIO_TOO_SHORT');
  assert.equal(r.seconds, 0.1);
  assert.match(r.detail, new RegExp(String(MIN_CAPTURE_SECONDS)), 'ወሰኑ በማስረጃው ውስጥ ተገልጧል');
});

test('F-08 / CI-03፦ ያልሆነ ወይም የቆራረጠ ድምፅ AUDIO_FORMAT_INVALID ይመልሳል', () => {
  const notWav = inspectWav(Buffer.from('this is definitely not a wav file at all, really'.repeat(2), 'utf8'));
  assert.equal(notWav.ok, false);
  assert.equal(notWav.code, 'AUDIO_FORMAT_INVALID');

  const truncated = inspectWav(Buffer.from('RIFF'));
  assert.equal(truncated.code, 'AUDIO_FORMAT_INVALID', 'አጭር ቁጠራ header ማንበብ አይችልም');

  const noData = pcm16(0.5);
  noData.write('LIST', 36);
  assert.equal(inspectWav(noData).code, 'AUDIO_FORMAT_INVALID', 'data ክፍል ከሌለ መንገዱ አያልፍም');
});

test('F-08፦ የድህረ ገጽ ቅርጽ (8-bit, float32) በግልጽ ይለያል', () => {
  const eight = pcm16(0.5, { amplitude: 0.3 });
  eight.writeUInt16LE(8, 34); // የናሙና ቅጽ ስንብን በመቀየር ያልተደገፈ ቅርጽ ይፍጠራል
  assert.equal(inspectWav(eight).code, 'AUDIO_FORMAT_UNSUPPORTED');

  const f32 = Buffer.alloc(44 + 8000 * 4);
  f32.write('RIFF', 0); f32.writeUInt32LE(36 + 8000 * 4, 4); f32.write('WAVE', 8);
  f32.write('fmt ', 12); f32.writeUInt32LE(16, 16); f32.writeUInt16LE(3, 20); f32.writeUInt16LE(1, 22);
  f32.writeUInt32LE(16000, 24); f32.writeUInt32LE(64000, 28); f32.writeUInt16LE(4, 32); f32.writeUInt16LE(32, 34);
  f32.write('data', 36); f32.writeUInt32LE(8000 * 4, 40);
  for (let i = 0; i < 8000; i += 1) f32.writeFloatLE(0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000), 44 + i * 4);
  const ok = inspectWav(f32);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.bits, 32);
  assert.ok(ok.peak > 0.4 && ok.peak <= 0.6, `የfloat ጫጫታ በትክክል ተለክቷል (${ok.peak})`);
});

test('F-08፦ ከdata በፊት ያለ ቦታ-ሙላ (odd-size) ክፍል አንባቢውን አያዛባም', () => {
  const body = pcm16(0.5, { amplitude: 0.4 });
  const listChunk = Buffer.concat([Buffer.from('LIST', 'ascii'), Buffer.from([5, 0, 0, 0]), Buffer.from('NOTE!', 'ascii'), Buffer.from([0])]);
  const merged = Buffer.concat([body.subarray(0, 36), listChunk, body.subarray(36)]);
  const r = inspectWav(merged);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.seconds, 0.5);
  assert.ok(r.peak > 1000, 'ናሙናው ከትክክለኛው data ክፍል ተነበበ');
});

test('F-08 / F-11፦ የጥበቃ ኮዶች ሁሉ የተመዘገቡና የተለዩ ናቸው (no unknown code reaches latency)', () => {
  for (const code of ['AUDIO_FORMAT_INVALID', 'AUDIO_FORMAT_UNSUPPORTED', 'AUDIO_UNREADABLE', 'AUDIO_TOO_SHORT', 'SILENT_CAPTURE']) {
    assert.ok(INPUT_GUARD_CODES.has(code), `${code} በINPUT_GUARD_CODES ውስጥ ግዴታ ነው`);
  }
  assert.equal(INPUT_GUARD_CODES.has('TRANSCRIBED'), false, 'ተሳክው ሩጫ ጥበቃ አይደለም');
  assert.equal(INPUT_GUARD_CODES.has('ASR_TIMEOUT'), false, 'የኢንጂን ጊዜ ማለፍ በናሙና ጥበቃ አይደለም');
  // ሁሉም የጥበቃ ውጤቶች code/detail/measurement ሦስት ማዕዘን አለው — በማስረጃ መዝገብ ለመያዝ ይህ ያስፈልጋል
  for (const buf of [Buffer.from('x'.repeat(60)), pcm16(0.05), pcm16(0.5)]) {
    const r = inspectWav(buf);
    assert.equal(r.ok, false);
    assert.ok(typeof r.code === 'string' && r.code.length > 0);
    assert.ok(typeof r.detail === 'string' && r.detail.length > 0);
  }
});
