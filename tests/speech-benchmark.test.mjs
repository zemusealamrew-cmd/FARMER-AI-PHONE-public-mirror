import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightCorpus, scoreTranscript, summariseCorpus, validateCorpus, writeCheckpoint } from '../tools/speech-benchmark.mjs';

const clip = { cfg: 'amh_asr', id: 'one', wav: 'one.wav', reference: 'የበቆሎ ቅጠል' };
const row = (locale, reference, text, code, childPid, ms) => {
  const asr = { text, code, child_pid: childPid, engine_ms: ms };
  return { locale, asr, score: scoreTranscript(reference, asr) };
};

test('F-11፦ የስብስብ ማጣቀሻ፣ ቋንቋና መለያ ይፈተሻሉ', () => {
  const valid = { clips: [clip] };
  assert.equal(validateCorpus(valid), valid);
  for (const value of [null, {}, { clips: [] }, { clips: [null] }, { clips: [clip, clip] },
    { clips: [{ ...clip, cfg: 'en' }] }, { clips: [{ ...clip, reference: ' ' }] },
    { clips: [{ ...clip, error: 'HTTP_403' }] }, { clips: [{ ...clip, wav: '' }] }]) {
    assert.throws(() => validateCorpus(value));
  }
});

test('F-08 / CI-03፦ የላቲን ውጤት ከአማርኛ ማጣቀሻ ጋር ያለው ስህተት አይደበቅም', () => {
  const score = scoreTranscript('የበቆሎ ቅጠል', { code: 'TRANSCRIBED', text: 'yebekolo kitel' });
  assert.equal(score.wer, 1);
  assert.equal(score.ethiopic_output, false);
  assert.equal(score.latin_output, true);
  assert.equal(scoreTranscript('የበቆሎ ቅጠል', { code: 'TRANSCRIBED', text: 'የበቆሎ ቅጠል' }).cer, 0);
});

test('F-08፦ ባዶ ውጤት ይመዘናል፤ ያልተደገፈና ጊዜ ያለፈበት ግን አይመዘንም', () => {
  const empty = scoreTranscript('በቆሎ', { code: 'EMPTY_TRANSCRIPT', text: null });
  assert.equal(empty.wer, 1);
  assert.equal(empty.cer, 1);
  for (const code of ['ASR_TIMEOUT', 'ASR_LOCALE_UNSUPPORTED', 'SILENT_CAPTURE', 'ASR_FAILED']) {
    assert.equal(scoreTranscript('በቆሎ', { code, text: null }), null);
  }
  assert.equal(scoreTranscript('', { code: 'TRANSCRIBED', text: 'hello' }), null);
});

test('F-11፦ የWER ድምር በቃል ብዛት ይመዘናል፤ የጥበቃ ጊዜ ወደ p95 አይገባም', () => {
  const report = summariseCorpus([
    row('am', 'a b c', 'a b x', 'TRANSCRIBED', 42, 5000),
    row('am', 'd', '', 'EMPTY_TRANSCRIPT', 43, 8000),
    row('am', 'e', null, 'ASR_TIMEOUT', 44, 120000),
    row('am', 'f', null, 'SILENT_CAPTURE', null, 1),
    row('om', 'boqqolloo', null, 'ASR_LOCALE_UNSUPPORTED', null, 1),
  ]);
  assert.equal(report.am.corpus_wer, 0.5);
  assert.equal(report.am.attempted, 4);
  assert.equal(report.am.engine_started, 3);
  assert.equal(report.am.scored, 2);
  assert.equal(report.am.p50_attempt_ms, 8000);
  assert.equal(report.am.p95_attempt_ms, 120000);
  assert.equal(report.om.p50_attempt_ms, null);
  assert.equal(report.om.corpus_wer, null);
  assert.equal(report.om.verdict, 'GAP');
  assert.equal(report.am.child_rss_peak_mb_range, null);
  assert.equal(report.am.child_cpu_avg_one_core_range, null);
});

test('F-11፦ ያልተለካ RAM/CPU ዜሮ ተብሎ አይቀርብም', () => {
  const measured = row('am', 'በቆሎ', 'በቆሎ', 'TRANSCRIBED', 45, 6000);
  measured.asr.child_rss_peak_mb = 475;
  measured.asr.child_cpu_avg_percent_of_one_core = 180;
  const missing = row('am', 'በቆሎ', 'በቆሎ', 'TRANSCRIBED', 46, 7000);
  missing.asr.child_rss_peak_mb = null;
  missing.asr.child_cpu_avg_percent_of_one_core = null;
  const result = summariseCorpus([measured, missing]).am;
  assert.deepEqual(result.child_rss_peak_mb_range, [475, 475]);
  assert.deepEqual(result.child_cpu_avg_one_core_range, [180, 180]);
  assert.equal(result.ethiopic_outputs, 2);
  assert.equal(result.verdict, 'PARTIAL');
  assert.deepEqual(summariseCorpus([]), {});
});

test('F-11፦ CER የፊደል ድምር ነው እንጂ የናሙና አማካይ አይደለም', () => {
  const result = summariseCorpus([
    row('am', 'abc', 'abd', 'TRANSCRIBED', 1, 1),
    row('am', 'x', '', 'EMPTY_TRANSCRIPT', 2, 2),
  ]).am;
  assert.equal(result.corpus_cer, 0.5);
});

test('F-11፦ የውጤት መንገድ ግቤትን አይደርብም፤ የሌላ ቅርጽ ድምፅ አይቀየርም', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-input-'));
  const manifestPath = join(dir, 'manifest.json');
  const wavPath = join(dir, 'one.wav');
  const b = Buffer.alloc(46);
  b.write('RIFF', 0); b.writeUInt32LE(38, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(2, 40);
  writeFileSync(wavPath, b);
  const manifest = JSON.stringify({ clips: [clip] });
  writeFileSync(manifestPath, manifest);
  assert.throws(() => preflightCorpus(manifestPath, manifestPath));
  assert.throws(() => preflightCorpus(manifestPath, wavPath));
  assert.equal(readFileSync(manifestPath, 'utf8'), manifest);
  assert.deepEqual(readFileSync(wavPath), b);
  assert.equal(preflightCorpus(manifestPath, join(dir, 'out.json')).hashes.length, 1);
  b.writeUInt32LE(22050, 24);
  writeFileSync(wavPath, b);
  assert.throws(() => preflightCorpus(manifestPath, join(dir, 'out.json')), /16kHz/);
  assert.deepEqual(readFileSync(wavPath), b);
});

test('F-11፦ የተቋረጠ checkpoint እንደተጠናቀቀ አይቀርብም፣ የጽሕፈት ስህተት ቀድሞውን አያጠፋም', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-checkpoint-'));
  const path = join(dir, 'out.json');
  const report = { planned: 20, rows: [{ id: 'one' }], finished_at: null };
  writeCheckpoint(report, path);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), report);
  assert.throws(() => writeCheckpoint({ bad: 1n }, path));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), report);
  writeCheckpoint({ ...report, rows: [{ id: 'one' }, { id: 'two' }] }, path);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).finished_at, null);
});
