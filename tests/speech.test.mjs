// F-08 / R-02 / R-03 / R-05 / CI-03 / NR-03፦ የድምጅ መንገድ ማስረጃ-ተኮር ፍተሻ።
// ደንቡ፦ ያልተጫነ ብቃት "ተሳካ" ብሎ አይመዘገብም። ኢንጂኑ ወይም ድምጽ ሲጎድል ግልጽ ኮድ ይመለሳል።
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asrStatus, INPUT_GUARD_CODES, transcribe, UNSUPPORTED_LOCALES, WHISPER_LOCALES } from '../app/src/asr.mjs';
import { listVoices, LOCALE_TO_CULTURE, synthesize, ttsStatus, voiceForLocale } from '../app/src/tts.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'farmerspeech-'));
const fakeBin = join(dir, 'fake-bin.txt');
const fakeModel = join(dir, 'fake-model.bin');
writeFileSync(fakeBin, 'not a whisper binary', 'utf8');
writeFileSync(fakeModel, 'not a ggml model', 'utf8');

test('R-02 / CI-03፦ ASR ሁኔታው የተሰነዘ መሆኑንና ኢንተርኔት እንደማያስፈልግ በግልጽ ይናገራል', () => {
  const s = asrStatus();
  assert.equal(s.engine, 'whisper.cpp');
  assert.equal(s.network_required, false, 'የASR መንገድ በአካባቢ ብቻ ነው');
  assert.equal(typeof s.ready, 'boolean');
  assert.ok(WHISPER_LOCALES.includes('am'), 'አማርኛ በምርጫዎች ውስጥ አለ (WER ግን REQUIRES EVIDENCE)');
  assert.equal(UNSUPPORTED_LOCALES.om, 'WHISPER_HAS_NO_AFAAN_OROMO_MODEL', 'አፋን ኦሮሞ ሞዴል የለም — በዝግጅት ተነግሯል');
});

test('F-08 / R-02፦ ኢንጂኑ ሳይጫን transcribe "ተሳካ" አይልም (ASR_NOT_INSTALLED / ASR_MODEL_MISSING)', async () => {
  const noBin = await transcribe(join(dir, 'missing.wav'), { overrides: { bin: join(dir, 'nope.exe'), model: join(dir, 'nope.bin') } });
  assert.equal(noBin.ok, false);
  assert.equal(noBin.code, 'ASR_NOT_INSTALLED');
  assert.equal(noBin.text, null, 'ያልተጫነ ኢንጂን የተፈጠረ ጽሑፍ አይሰጥም');

  const noModel = await transcribe(join(dir, 'missing.wav'), { overrides: { bin: fakeBin, model: join(dir, 'nope.bin') } });
  assert.equal(noModel.ok, false);
  assert.equal(noModel.code, 'ASR_MODEL_MISSING');
});

test('NR-03 / CI-03፦ የቋንቋ ድጋፍ በኮድ ይለያል — አፋን ኦሮሞ ASR_LOCALE_UNSUPPORTED ይመልሳል', async () => {
  const r = await transcribe(join(dir, 'missing.wav'), { locale: 'om', overrides: { bin: fakeBin, model: fakeModel } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ASR_LOCALE_UNSUPPORTED');
  assert.equal(r.detail, UNSUPPORTED_LOCALES.om);
});

test('R-02፦ ያልተገኘ ድምጅ ፋይል AUDIO_NOT_FOUND ይመልሳል', async () => {
  const r = await transcribe(join(dir, 'definitely-missing.wav'), { locale: 'am', overrides: { bin: fakeBin, model: fakeModel } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AUDIO_NOT_FOUND');
});

// የተገኘ እውነተኛ ጉድለት መዝጊያ፦ whisper ከapp/bin ማቅለሚያ (cwd) ስለሚነሳ አንጻራዊ መንገድ ፋይሉ ሳይነበብ ASR_FAILED ይመልሳል።
test('F-08 / R-02፦ አንጻራዊ የድምጅ መንገድ ወደ ፈላጭ መንገድ ይቀየራል — ፋይሉ ሳይታይ አይከሽፍም', async () => {
  const wavName = 'relative-check.wav';
  writeFileSync(join(dir, wavName), wav16kMono(1, 9000));
  const before = process.cwd();
  process.chdir(dir);
  try {
    const r = await transcribe(wavName, { locale: 'am', overrides: { bin: fakeBin, model: fakeModel } });
    assert.notEqual(r.code, 'AUDIO_NOT_FOUND', `ፋይሉ በተመለከተው ማቅለሚያ ውስጥ ስላለ AUDIO_NOT_FOUND መመለስ አይችልም (${r.detail})`);
    assert.ok(['ASR_SPAWN_FAILED', 'ASR_FAILED', 'ASR_TIMEOUT'].includes(r.code), `የተጠበቀ የውርርድ ኮድ፦ ${r.code}`);
    assert.equal(r.text, null, 'ኢንጂኑ ስላልሠራ ጽሑፍ አይፈጠርም');
    const missing = await transcribe('no-such-file-here.wav', { locale: 'am', overrides: { bin: fakeBin, model: fakeModel } });
    assert.equal(missing.code, 'AUDIO_NOT_FOUND');
    assert.ok(isAbsolute(missing.detail), 'የስህተት ማስታወሻው ፈላጭ መንገድ ይዞ ይኖራል — የት እንደሚፈልግ ለመርጀር ይጠቅማል');
  } finally {
    process.chdir(before);
  }
});

// በትይዩ ሩጫ የwhisper ልጅ ሲወድቅ (RAM ውድድር) ውጤቱ latency_ms ስሌተነበረ ፍተሻው ያለ-ምክንያት ይሰበር ነበር።
test('F-08 / F-11፦ ኢንጂኑ ሲወድቅም የጊዜ ልኬት አይጠፋም (latency ማስረጃ ለሁሉም ውጤት)', async () => {
  const wav = writeToneWav(join(dir, 'tone-failpath.wav'));
  const spawnFail = await transcribe(wav, { locale: 'am', overrides: { bin: fakeBin, model: fakeModel } });
  assert.equal(spawnFail.ok, false, 'ጽሑፍ የያዘ ፋይል እንደ ማቅለሚያ ስለሆነ ውጤቱ ሊሳካ አይችልም');
  assert.ok(['ASR_SPAWN_FAILED', 'ASR_FAILED', 'ASR_TIMEOUT'].includes(spawnFail.code), `የውርርድ ስህተት ኮድ፦ ${spawnFail.code}`);
  assert.ok(Number.isFinite(spawnFail.latency_ms), `የስህተት ውጤት ጊዜ መመዝገብ አለው (${spawnFail.latency_ms}ms)`);
  const st = asrStatus();
  if (st.binary_present) {
    // እውነተኛ ማቅለሚያ + ሐሰተኛ ሞዴል፦ ኢንጂኑ በእውነት ተነስቶ በመውደቁ ላይ ጊዜው ተመዝግቧል እንደሆነ ይረጋገጣል
    const modelFail = await transcribe(wav, { locale: 'am', overrides: { bin: st.binary_path, model: fakeModel } });
    assert.equal(modelFail.ok, false, 'በሐሰተኛ ሞዴል መተርጎም አይሳካም');
    assert.ok(['ASR_FAILED', 'ASR_TIMEOUT'].includes(modelFail.code), `የሞዴል ስህተት ኮድ፦ ${modelFail.code}`);
    assert.ok(Number.isFinite(modelFail.latency_ms), `የሞዴል ስህተት ጊዜ መመዝገብ አለው (${modelFail.latency_ms}ms)`);
  }
});

function wav16kMono(seconds, tone = 0) {
  const frames = 16000 * seconds;
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * 2, 40);
  // የተሞላ (tone>0) ናሙና የግብይት ጥበቃውን አልፎ ወደ ኢንጂኑ መንገድ ደርሷል፤ ዜሮ ግን ተከላከላል (F-08)
  if (tone) {
    for (let i = 0; i < frames; i += 1) buf.writeInt16LE(Math.round(tone * Math.sin((2 * Math.PI * (220 * i + 0.02 * i * i)) / 16000)), 44 + i * 2);
  }
  return buf;
}

test('F-08 / R-02፦ ማንኛውም ያልተጠየቀ ውጤት "ውህደት ያልሆነ" ሆኖ ይመዘገባል (no fabricated transcript)', async () => {
  // fake bin/model ስለሆኑ የASR ሂደቱ ሊሳካ አይችልም፤ ዋና ማረጋገጫ — ok:true ከሆነ text ግዴታ አለ
  const r = await transcribe(join(dir, 'audio.wav'), { locale: 'am', overrides: { bin: fakeBin, model: fakeModel } });
  if (r.ok) {
    assert.equal(typeof r.text, 'string');
    assert.ok(r.text.length > 0, 'ok:true ማለት እውነተኛ ጽሑፍ አለ ማለት ነው');
    assert.equal(r.engine, 'whisper.cpp');
  } else {
    assert.ok(
      ['ASR_FAILED', 'ASR_SPAWN_FAILED', 'ASR_TIMEOUT', 'AUDIO_NOT_FOUND', 'EMPTY_TRANSCRIPT'].includes(r.code),
      `የማይታወቅ የውርርድ ኮድ፦ ${r.code}`,
    );
    assert.equal(r.text, null);
  }
});

test('R-03 / CI-03፦ የTTS ድጋፍ መለያ ከተጫኑ ድምጾች ዝርዝር ጋር ይዛመዳል (no self-claim)', () => {
  const listing = listVoices();
  assert.ok(['VOICES_LISTED', 'SAPI_WINDOWS_ONLY', 'SAPI_QUERY_FAILED'].includes(listing.code), listing.code);
  const status = ttsStatus();
  assert.equal(status.engine, 'windows_sapi');
  assert.equal(status.network_required, false, 'TTS በአካባቢ ብቻ');
  for (const loc of ['am', 'om', 'en']) {
    const expected = listing.voices.some((v) => String(v.culture).toLowerCase() === LOCALE_TO_CULTURE[loc].toLowerCase());
    assert.equal(status.locale_support[loc].available, expected, `${loc} ድጋፍ ከዝርዝሩ ጋር አይዛመድም`);
  }
});

test('R-03 / F-08፦ የአማርኛ/ኦሮሚያ ድምጽ ሳይኖር "NO_LOCAL_VOICE" ብቻ ነው፣ ድምጽ አይፈጠርም', () => {
  for (const loc of ['am', 'om']) {
    const v = voiceForLocale(loc);
    if (!v.ok) {
      assert.equal(v.code, process.platform === 'win32' ? (listVoices().ok ? 'NO_LOCAL_VOICE' : listVoices().code) : 'SAPI_WINDOWS_ONLY');
      assert.ok(Array.isArray(v.available ?? v.voices), 'የተጫኑ ድምጾች ዝርዝር ለማስረጃ ተብሎ ተገልጿል');
    } else {
      assert.equal(v.code, 'VOICE_FOUND');
      assert.equal(String(v.culture).toLowerCase(), LOCALE_TO_CULTURE[loc].toLowerCase());
    }
  }
});

test('R-03 / CI-01፦ synthesize ግብይት ከጎደለ ግልጽ ስህተት ይመልሳል (no silent write)', () => {
  const empty = synthesize('   ', { locale: 'en', outPath: join(dir, 'empty.wav') });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'EMPTY_TEXT');
  const noPath = synthesize('hello', { locale: 'en' });
  assert.equal(noPath.ok, false);
  assert.equal(noPath.code, 'OUTPUT_PATH_REQUIRED');
});

test('R-03 / F-11 / CI-14፦ ቢያንስ አንድ የሚሰራ ድምጽ ካለ ወደ WAV ይነበራል፤ የለም ከሆነ በኮድ ይገለጻል', () => {
  const en = voiceForLocale('en');
  if (!en.ok) {
    const r = synthesize('the market price is verified', { locale: 'en', outPath: join(dir, 'en.wav') });
    assert.equal(r.ok, false);
    assert.equal(r.code, en.code, 'የተሰኘው ድምጽ በማይኖርበት ጊዜ "ተሳካ" አይልም');
    return;
  }
  const out = join(dir, 'en.wav');
  const r = synthesize('the market price is verified', { locale: 'en', outPath: out });
  assert.equal(r.code, 'SYNTHESIZED');
  assert.ok(r.bytes > 44, `WAV ይዘት አለው (${r.bytes} bytes)`);
  const head = readFileSync(out).subarray(0, 12);
  assert.equal(head.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(head.subarray(8, 12).toString('ascii'), 'WAVE');
});

// 16 kHz mono ሙሉ ጸጥታ WAV — የግብይት ጥበቃው ዝግ ግብይት እንደሚይዝ ለማረጋገጥ (F-08)
function writeSilenceWav(path, seconds = 0.5) {
  const buf = wav16kMono(seconds);
  writeFileSync(path, buf);
  return path;
}

// ድምፅ ያለው (440 Hz ሳይን) WAV — የኢንጂኑ መንገድ በእውነት እስከመጨረሻው እንዲደርስ ለማድረግ (F-08 / F-11)
function writeToneWav(path, seconds = 0.5, amplitude = 9000) {
  const buf = wav16kMono(seconds, amplitude);
  writeFileSync(path, buf);
  return path;
}

test('F-08 / R-02 / CI-03፦ ኢንጂኑ ተጭኖ ሲገኝ መንገዱ ሳይቋረጥ ውጤት ወይም ግልጽ ኮድ ይመልሳል', async () => {
  // ይህ ቅርንጫፍ በነበረው ማሽኑ ላይ ብቻ ይሮጣል። ቀደም ሲል ፍተሻው "ያልተጫነ" አቅጣጫ ብቻ ስለሚሞክር የተሰበረው መንገድ ድረስ ደርሶ አልታየም ነበር።
  const status = asrStatus();
  if (!status.ready) {
    assert.ok(true, 'ASR ዝግጁ አይደለም — ይህ ፍተሻ አልሮጠም (GAP፣ ማስረጃ REQUIRES EVIDENCE)');
    return;
  }
  const wav = writeToneWav(join(dir, 'tone-16k.wav'));
  let r;
  try {
    r = await transcribe(wav, { locale: 'am', threads: 2, timeoutMs: 90000 });
  } catch (error) {
    assert.fail(`የASR መንገድ ሊደመደም አይገባም፦ ${error.message}`);
  }
  assert.ok(Number.isFinite(r.latency_ms), `የASR የጊዜ ልኬት ተመዝግቧል (${r.latency_ms}ms)`);
  assert.ok(!INPUT_GUARD_CODES.has(r.code), `ናሙና ድምፅ ስላለ የግብይት ጥበቃው ሊከላከል አይገባም፦ ${r.code}`);
  if (r.ok) {
    assert.equal(r.code, 'TRANSCRIBED');
    assert.equal(r.engine, 'whisper.cpp');
    assert.match(r.text, /[\p{L}\p{N}]/u, 'ቃል የሌለው ጽሑፍ "ተሳካ" ተብሎ አይመለስም (F-08)');
  } else {
    assert.ok(
      ['EMPTY_TRANSCRIPT', 'NO_VALID_UTTERANCE', 'ASR_FAILED', 'ASR_SPAWN_FAILED', 'ASR_TIMEOUT'].includes(r.code),
      `ያልታወቀ የASR ኮድ፦ ${r.code}`,
    );
    assert.equal(r.text, null, 'ያልተረጋገጠ ውጤት የተፈጠረ ጽሑፍ እንዳይይድ');
  }
});

test('F-08 / R-02 / CI-03፦ ዝግ ግብይት ለኢንጂን ሳይደርስ በግልጽ ኮድ ይቆማል (no 6-8s wasted run)', async () => {
  const status = asrStatus();
  if (!status.ready) {
    assert.ok(true, 'ASR ዝግጁ አይደለም — ይህ ፍተሻ አልሮጠም (GAP፣ ማስረጃ REQUIRES EVIDENCE)');
    return;
  }
  const wav = writeSilenceWav(join(dir, 'silence-guard.wav'), 1);
  const pids = [];
  const t0 = Date.now();
  const r = await transcribe(wav, { locale: 'am', threads: 2, timeoutMs: 90000, onSpawn: (pid) => pids.push(pid) });
  assert.equal(r.ok, false, 'ሙሉ ጸጥታ የተሳካ ትርጓሜ ሆኖ አይመለስም');
  assert.equal(r.code, 'SILENT_CAPTURE');
  assert.equal(r.text, null, 'የተፈጠረ ጽሑፍ የለ');
  assert.equal(pids.length, 0, 'whisper ፈጽሞ አልተነሳም — የ6-8 ሰከንድ ጉዳት ተከላክሏል');
  assert.ok(Date.now() - t0 < 2000, `ጥበቃው ወዲያውኑ ቆሟል (${Date.now() - t0}ms)`);
  assert.equal(r.audio.peak, 0, 'የጫጫታ ልኬት ለማስረጃ ተገልጿል');
  assert.equal(r.audio.seconds, 1, 'የናሙና ርዝመት ለማስረጃ ተገልጿል');
});


test('F-11፦ የASR መንገድ የልጅ ሂደት PID ለማስረጃ መለኪያ በትክክል አንዴ ያልፋል', async () => {
  const status = asrStatus();
  if (!status.ready) {
    assert.ok(true, 'ASR ዝግጁ አይደለም — ይህ ፍተሻ አልሮጠም (GAP፣ ማስረጃ REQUIRES EVIDENCE)');
    return;
  }
  // PID ማልፎ የሚፈተሸው ኢንጂኑ ተነስቶ ስለሆነ ድምፅ ያለው ናሙና ያስፈልጋል — ዝግ ከሆነ ጥበቃው ይከላከላል
  const wav = writeToneWav(join(dir, 'spawn-pid.wav'));
  const pids = [];
  const r = await transcribe(wav, { locale: 'am', threads: 2, timeoutMs: 90000, onSpawn: (pid) => pids.push(pid) });
  assert.equal(pids.length, 1, 'spawn ሲሆን አንዴ ብቻ ጠሪው ይጠራል');
  assert.ok(Number.isInteger(pids[0]) && pids[0] > 0, `የልጅ ሂደት PID ተመዘገበ (${pids[0]})`);
  assert.ok(typeof r.code === 'string', 'የPID ማልፎ ውጤቱን አያበላሸም');
});

test('Issue #6: successful ASR process emitting only [BEEP] is NO_VALID_UTTERANCE, not TRANSCRIBED', async () => {
  if (process.platform === 'win32') return; // POSIX fixture executable; utterance classifier is cross-platform.
  const { chmodSync } = await import('node:fs');
  const bin=join(dir,'annotation-asr');
  writeFileSync(bin,"#!/bin/sh\nprintf '[BEEP]\\n'\n");chmodSync(bin,0o755);
  const file=join(dir,'annotation-input.wav');writeFileSync(file,wav16kMono(1,9000));
  const result=await transcribe(file,{locale:'am',overrides:{bin,model:fakeModel}});
  assert.equal(result.ok,false);assert.equal(result.code,'NO_VALID_UTTERANCE');assert.equal(result.text,null);
});
