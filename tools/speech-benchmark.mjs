import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editDistance, percentile, runVoiceCheck, words } from './voice-check.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const LOCALES = { amh_asr: 'am', orm_asr: 'om' };

export function validateCorpus(manifest) {
  if (!Array.isArray(manifest?.clips) || manifest.clips.length === 0) throw new Error('የድምፅ ናሙና ዝርዝር ያስፈልጋል።');
  const ids = new Set();
  for (const clip of manifest.clips) {
    if (!clip || !Object.hasOwn(LOCALES, clip.cfg) || typeof clip.id !== 'string' || !clip.id.trim()
      || typeof clip.wav !== 'string' || !clip.wav.trim() || clip.error
      || typeof clip.reference !== 'string' || !clip.reference.trim()) throw new Error('ያልተሟላ የድምፅ ናሙና።');
    const key = `${clip.cfg}/${clip.id}`;
    if (ids.has(key)) throw new Error(`የተደገመ ናሙና፦ ${key}`);
    ids.add(key);
  }
  return manifest;
}

export function scoreTranscript(reference, asr) {
  if (!['TRANSCRIBED', 'EMPTY_TRANSCRIPT'].includes(asr.code)) return null;
  const hypothesis = asr.text ?? '';
  const rw = words(reference);
  const rc = [...reference.replaceAll(/\s+/g, '')];
  if (!rw.length || !rc.length) return null;
  const wordErrors = editDistance(rw, words(hypothesis));
  const charErrors = editDistance(rc, [...hypothesis.replaceAll(/\s+/g, '')]);
  return {
    reference_words: rw.length, reference_chars: rc.length,
    word_errors: wordErrors, char_errors: charErrors,
    wer: wordErrors / rw.length, cer: charErrors / rc.length,
    ethiopic_output: /[\u1200-\u137f\u1380-\u139f\u2d80-\u2ddf\uab00-\uab2f]/u.test(hypothesis),
    latin_output: /\p{Script=Latin}/u.test(hypothesis),
  };
}

export function summariseCorpus(rows) {
  const summaries = {};
  for (const locale of [...new Set(rows.map((row) => row.locale))]) {
    const selected = rows.filter((row) => row.locale === locale);
    const measured = selected.filter((row) => Number.isInteger(row.asr.child_pid) && row.asr.child_pid > 0);
    const times = measured.map((row) => row.asr.engine_ms).filter(Number.isFinite).sort((a, b) => a - b);
    const scores = selected.map((row) => row.score).filter(Boolean);
    const sum = (key) => scores.reduce((total, score) => total + score[key], 0);
    const range = (key) => {
      const values = measured.map((row) => row.asr[key]).filter(Number.isFinite);
      return values.length ? [Math.min(...values), Math.max(...values)] : null;
    };
    const codes = {};
    for (const row of selected) codes[row.asr.code] = (codes[row.asr.code] ?? 0) + 1;
    summaries[locale] = {
      attempted: selected.length, engine_started: measured.length, scored: scores.length, codes,
      corpus_wer: scores.length ? sum('word_errors') / sum('reference_words') : null,
      corpus_cer: scores.length ? sum('char_errors') / sum('reference_chars') : null,
      ethiopic_outputs: scores.filter((score) => score.ethiopic_output).length,
      latin_outputs: scores.filter((score) => score.latin_output).length,
      p50_attempt_ms: percentile(times, 0.5), p95_attempt_ms: percentile(times, 0.95),
      child_rss_peak_mb_range: range('child_rss_peak_mb'),
      child_cpu_avg_one_core_range: range('child_cpu_avg_percent_of_one_core'),
      verdict: 'PARTIAL',
    };
    if (!scores.length) summaries[locale].verdict = 'GAP';
  }
  return summaries;
}

export function writeCheckpoint(report, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const temp = `${outPath}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  renameSync(temp, outPath);
}

export function preflightCorpus(manifestPath, outPath) {
  const raw = readFileSync(manifestPath);
  const manifest = validateCorpus(JSON.parse(raw.toString('utf8')));
  const paths = manifest.clips.map((clip) => resolve(dirname(manifestPath), clip.wav));
  const output = existsSync(outPath) ? statSync(outPath) : null;
  for (const path of [manifestPath, ...paths]) {
    const input = statSync(path);
    if (resolve(path) === resolve(outPath) || (output && input.dev === output.dev && input.ino === output.ino)) {
      throw new Error('ውጤቱ የግቤት ፋይልን መደረብ አይችልም።');
    }
  }
  const hashes = paths.map((path) => {
    const b = readFileSync(path);
    if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 16) !== 'WAVEfmt '
      || b.readUInt32LE(16) !== 16 || b.readUInt16LE(20) !== 1 || b.readUInt16LE(22) !== 1
      || b.readUInt32LE(24) !== 16000 || b.readUInt16LE(34) !== 16 || b.toString('ascii', 36, 40) !== 'data'
      || b.readUInt32LE(40) !== b.length - 44 || (b.length - 44) % 2) {
      throw new Error(`ስብስቡ 44-byte ራስጌ ያለው 16kHz mono PCM16 WAV ይፈልጋል፦ ${path}`);
    }
    return sha256(b);
  });
  return { raw, manifest, hashes };
}

export async function benchmark(manifestPath, outPath) {
  const { raw, manifest, hashes } = preflightCorpus(manifestPath, outPath);
  const report = {
    tool: 'speech-benchmark', at: new Date().toISOString(), finished_at: null,
    gate: 'G1', manifest_sha256: sha256(raw),
    source: manifest.source ?? null, source_license_claim: manifest.license ?? null,
    acquisition: { fetched_at: manifest.fetched_at ?? null, decoder: manifest.decoder ?? null },
    planned: manifest.clips.length, concurrency: 1, rows: [], summary: {},
    code_sha256: Object.fromEntries(['speech-benchmark.mjs', 'voice-check.mjs', '../app/src/asr.mjs', '../app/src/tts.mjs'].map((path) => [path, sha256(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), path)))])),
    run_settings: { threads: 4, timeout_ms: 120000, normalization: 'none', prompting: 'none' },
    method: 'ማጣቀሻውና ውጤቱ ሳይተረጎሙ የቃል/ፊደል ርቀት፤ የሁሉም ስህተት ድምር ÷ የማጣቀሻ ድምር። ባዶ ውጤት ይቆጠራል፤ ጊዜ ያለፈበትና ያልተደገፈ ቋንቋ አይመዘንም።',
    timing_scope: 'ኢንጂኑ የተነሳባቸው ሙከራዎች ብቻ፤ የተሳሳቱና ጊዜ ያለፈባቸው ይካተታሉ። የተለያዩ ናሙናዎች እንጂ የአንድ ግቤት ድግግሞሽ አይደሉም።',
    limitation: 'ቀድሞ የወረደ የድምፅ ስብስብ፤ ቀጥታ ማይክ፣ የገበሬ መስክ ወይም ሙሉ የድምፅ ማሳያ አይደለም። ሌሎች የማሽኑ ሂደቶች አልተገደቡም። D-003/D-004 አልጸደቁም።',
  };
  writeCheckpoint(report, outPath);
  for (const clip of manifest.clips) {
    const wav = resolve(dirname(manifestPath), clip.wav);
    const inputHash = sha256(readFileSync(wav));
    if (inputHash !== hashes[report.rows.length]) throw new Error(`የድምፅ ግቤት በሩጫው መሀል ተቀይሯል፦ ${clip.id}`);
    const locale = LOCALES[clip.cfg];
    const result = await runVoiceCheck({ wav, locale, showText: true });
    if (report.assets && JSON.stringify(report.assets) !== JSON.stringify(result.assets)) {
      throw new Error('የኢንጂን/ሞዴል ሃሽ በሩጫው መሀል ተቀይሯል።');
    }
    if (!report.assets) {
      report.assets = result.assets;
      report.device = result.device_probe;
      report.version = result.version_probe;
      report.resource_scope = result.resource_scope_note;
      report.tts = result.tts;
    }
    report.rows.push({
      id: clip.id, locale, cfg: clip.cfg, split: clip.split ?? null,
      input_path: clip.wav, input_sha256: inputHash,
      reference: clip.reference, reference_sha256: sha256(clip.reference),
      asr: result.asr, score: scoreTranscript(clip.reference, result.asr),
    });
    report.summary = summariseCorpus(report.rows);
    writeCheckpoint(report, outPath);
    console.log(`${report.rows.length}/${report.planned} ${locale} ${clip.id} ${result.asr.code} ${result.asr.engine_ms} ms`);
  }
  report.finished_at = new Date().toISOString();
  writeCheckpoint(report, outPath);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifestPath, outPath, ...extra] = process.argv.slice(2);
  if (!manifestPath || !outPath || extra.length || resolve(manifestPath) === resolve(outPath)) {
    console.error('አጠቃቀም፦ node tools/speech-benchmark.mjs <manifest.json> <ውጤት.json>');
    process.exitCode = 2;
  } else {
    const report = await benchmark(resolve(manifestPath), resolve(outPath));
    console.log(JSON.stringify(report.summary, null, 2));
  }
}
