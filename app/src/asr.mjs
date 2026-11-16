import { offlineModelsEnabled, runOfflineModel, offlineModelStatus } from './offline-models.mjs';
import { inspectSpeechSignal, validUtterance } from './speech-presence.mjs';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');

export const WHISPER_LOCALES = ['am', 'en'];
export const UNSUPPORTED_LOCALES = { om: 'WHISPER_HAS_NO_AFAAN_OROMO_MODEL' };
// በ16 kHz mono PCM16 ዝቅተኛው ጠቃሚ ርዝመት — ከዚያ በታች ላይት ማንበብ ጉዳት ነው (R-02 / F-08)
export const MIN_CAPTURE_SECONDS = 0.3;
// እነዚህ ኮዶች ሲመዘገቡ የኢንጂኑ ሂደት በቁሙ አልተነሳም ማለት ነው — ስለዚህ ፈጣን ውጤታቸው በlatency
// ስርጭት ውስጥ ሊታከም አይገባም (F-11 የጊዜ መለኪያ ትክክለኛነት)
export const INPUT_GUARD_CODES = new Set([
  'AUDIO_FORMAT_INVALID',
  'AUDIO_FORMAT_UNSUPPORTED',
  'AUDIO_UNREADABLE',
  'AUDIO_TOO_SHORT',
  'SILENT_CAPTURE',
  'NON_SPEECH_CAPTURE',
]);

// የተዘጋ ማይክና 5 ሚሊ-ሰከንድ ናሙና በዝግ ሁኔታ ወደ ኢንጂን መላክ «አልተረዳሁም» ይልናል — ገበሬው ስለ
// ችግኙ ምንም የማይነግረው ደጋጋሚ ሙከራ ይፈጥራል። ስለዚህ ግብዩቱ መታመሹ በራሱ ይታወቃል (F-08)።
export function inspectWav(buffer) {
  const bad = (code, detail, extra = {}) => ({
    ok: false,
    code,
    detail,
    sample_rate: null,
    channels: null,
    bits: null,
    seconds: 0,
    peak: 0,
    ...extra,
  });
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    return bad('AUDIO_FORMAT_INVALID', `not enough bytes for a WAV header (${buffer?.length ?? 0})`);
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return bad('AUDIO_FORMAT_INVALID', `header is ${JSON.stringify(buffer.toString('ascii', 0, 12))}, expected RIFF/WAVE`);
  }
  let fmt = null;
  let dataAt = -1;
  let dataLen = 0;
  for (let p = 12; p + 8 <= buffer.length; p += 1) {
    const id = buffer.toString('ascii', p, p + 4);
    const size = buffer.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        rate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataAt = body;
      dataLen = Math.max(0, Math.min(size, buffer.length - body));
      break;
    }
    if (size === 0) break;
    p = body + size + (size % 2) - 1;
  }
  if (!fmt) return bad('AUDIO_FORMAT_INVALID', 'fmt chunk missing');
  if (dataAt < 0 || dataLen === 0) return bad('AUDIO_FORMAT_INVALID', 'data chunk missing or empty');
  if (!(fmt.bits === 16 && (fmt.format === 1 || fmt.format === 0xFFFE)) && !(fmt.bits === 32 && fmt.format === 3)) {
    return bad('AUDIO_FORMAT_UNSUPPORTED', `format=${fmt.format} bits=${fmt.bits} (need PCM16 or IEEE float32)`, {
      sample_rate: fmt.rate,
      channels: fmt.channels,
      bits: fmt.bits,
    });
  }
  const bytesPerFrame = fmt.channels * (fmt.bits / 8);
  const frames = Math.floor(dataLen / bytesPerFrame);
  const seconds = frames / fmt.rate;
  let peak = 0;
  if (fmt.bits === 16) {
    for (let i = dataAt; i + 1 < dataAt + dataLen; i += 2) peak = Math.max(peak, Math.abs(buffer.readInt16LE(i)));
  } else {
    for (let i = dataAt; i + 3 < dataAt + dataLen; i += 4) peak = Math.max(peak, Math.abs(buffer.readFloatLE(i)));
  }
  const shape = { sample_rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, seconds: +seconds.toFixed(3), peak };
  if (seconds < MIN_CAPTURE_SECONDS) {
    return bad('AUDIO_TOO_SHORT', `${seconds.toFixed(3)}s < ${MIN_CAPTURE_SECONDS}s minimum`, shape);
  }
  if (peak === 0) return bad('SILENT_CAPTURE', 'every sample is digital zero — the microphone delivered no signal', shape);
  return { ok: true, code: 'INPUT_OK', detail: null, ...shape };
}

export function asrPaths(overrides = {}) {
  return {
    bin: overrides.bin ?? process.env.ASR_BIN ?? join(APP_ROOT, 'bin', 'whisper-cli.exe'),
    model: overrides.model ?? process.env.ASR_MODEL ?? join(APP_ROOT, 'models', 'ggml-small-q5_1.bin'),
  };
}

export function asrStatus(overrides = {}) {
  if (offlineModelsEnabled()) return { ...offlineModelStatus(), ready: existsSync(join(APP_ROOT, 'models', 'badrex--Ethio-ASR-multilingual-600M', 'model.safetensors')), supported_locales: ['am', 'om'], unsupported_locales: {}, engine: 'Ethio-ASR-multilingual-600M', note: 'Configured research backend; file presence is not acceptance' };
  const { bin, model } = asrPaths(overrides);
  return {
    binary_present: existsSync(bin),
    model_present: existsSync(model),
    ready: existsSync(bin) && existsSync(model),
    binary_path: bin,
    model_path: model,
    supported_locales: WHISPER_LOCALES,
    unsupported_locales: UNSUPPORTED_LOCALES,
    engine: 'whisper.cpp',
    network_required: false,
  };
}

export function absAudioPath(wavPath) {
  return resolve(wavPath);
}

export function transcribe(wavPath, { locale = 'am', timeoutMs = 120000, overrides = {}, threads = 4, onSpawn = null } = {}) {
  if (offlineModelsEnabled()) return runOfflineModel({ kind: 'asr', path: absAudioPath(wavPath), locale }, timeoutMs);
  // Reject stationary test signals before model availability or process spawning.
  if (existsSync(absAudioPath(wavPath))) {
    try {
      const bytes = readFileSync(absAudioPath(wavPath));
      if (inspectWav(bytes).ok) {
        const signal = inspectSpeechSignal(bytes);
        if (!signal.ok) return Promise.resolve({ ...signal, text: null, latency_ms: 0, engine: 'negative-only-periodicity-v1' });
      }
    } catch {}
  }
  const status = asrStatus(overrides);
  // asrStatus() የሚመልሰው binary_path/model_path ነው፤ bin የሚል መስክ የለውም — ቀጥታ ከasrPaths() ይወሰዳል
  const { bin, model } = asrPaths(overrides);
  if (!status.ready) {
    return Promise.resolve({
      ok: false,
      code: status.binary_present ? 'ASR_MODEL_MISSING' : 'ASR_NOT_INSTALLED',
      detail: `binary=${status.binary_path} model=${status.model_path}`,
      text: null,
    });
  }
  if (!WHISPER_LOCALES.includes(locale)) {
    return Promise.resolve({
      ok: false,
      code: 'ASR_LOCALE_UNSUPPORTED',
      detail: UNSUPPORTED_LOCALES[locale] ?? 'NO_MODEL_FOR_LOCALE',
      text: null,
    });
  }
  // whisper ከbin ማቅለሚያ (cwd) ስለሚነሳ አንጻራዊ መንገድ ወደ "ASR_FAILED" ይበተናል፤ ስለዚህ ፈላጭ መንገድ ያስፈልጋል
  const audioPath = absAudioPath(wavPath);
  if (!existsSync(audioPath)) {
    return Promise.resolve({ ok: false, code: 'AUDIO_NOT_FOUND', detail: audioPath, text: null });
  }

  const started = Date.now();
  // ጥሪ ከመነሳት በፊት ግብዩቱ ያልተሟላ ከሆነ ዝቅተኛ ወጪ ባለው መንገድ ይቆማል፤ በዚህም 5-8 ሰከንድ
  // የሚወስደውን ጉዳትና "አልተረዳሁም" የሚል ሐሰተኛ መልእክት እንከላከላለን (F-08 / R-02)።
  let probe;
  try {
    probe = inspectWav(readFileSync(audioPath));
  } catch (error) {
    probe = { ok: false, code: 'AUDIO_UNREADABLE', detail: String(error?.message ?? error) };
  }
  if (!probe.ok) {
    return Promise.resolve({
      ok: false,
      code: probe.code,
      detail: probe.detail,
      text: null,
      locale,
      latency_ms: Date.now() - started,
      engine: 'whisper.cpp',
      audio: {
        sample_rate: probe.sample_rate ?? null,
        channels: probe.channels ?? null,
        bits: probe.bits ?? null,
        seconds: probe.seconds ?? 0,
        peak: probe.peak ?? 0,
      },
    });
  }

  return new Promise((done) => {
    const args = [
      '-m', model,
      '-f', audioPath,
      '-l', locale,
      '-t', String(threads),
      '-nt',
      '-np',
    ];
    // ማቅለሚያው ፋይል ከሆነ ግን ካልተሮጥ (EFTYPE/EACCES) spawn በራሱ ስህተት ያነሳል — ያንገበግብ አትቅመጥ፣ ግልጽ ኮድ ተመለስ (F-08)
    let child;
    try {
      child = spawn(bin, args, { cwd: dirname(bin), windowsHide: true });
      // የልጅ ሂደት PID ለማስረጃ መለኪያ (peak RSS) ብቻ — ተጠቃሚው አካላዊ ምላሽ ላይ ለውጥ የለውም (F-11)
      if (typeof onSpawn === 'function') onSpawn(child.pid ?? null);
    } catch (error) {
      done({ ok: false, code: 'ASR_SPAWN_FAILED', detail: String(error?.message ?? error), text: null, latency_ms: Date.now() - started, engine: 'whisper.cpp' });
      return;
    }
    let out = '';
    let err = '';
    // የኢንጂን ስህተት ውጤቶችም latency_ms ይዘዋሉ፦ የወደቀ ዙር ጊዜ ካልተመዘገበ የF-11 ማስረጃ ስርጭት «ምን ያህል ቆይቶ ወደቀ?» አያየም
    const timer = setTimeout(() => {
      child.kill();
      done({
        ok: false,
        code: 'ASR_TIMEOUT',
        detail: `exceeded ${timeoutMs}ms`,
        text: null,
        latency_ms: Date.now() - started,
      });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ ok: false, code: 'ASR_SPAWN_FAILED', detail: String(error.message), text: null, latency_ms: Date.now() - started, engine: 'whisper.cpp' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ').trim();
      if (code !== 0) {
        done({ ok: false, code: 'ASR_FAILED', detail: err.slice(-800), exit_code: code, text: null, latency_ms: Date.now() - started, engine: 'whisper.cpp' });
        return;
      }
      // ፊደል ወይም ቁጅር የሌለው ጽሑፍ (ለምሳሌ ከጽንግውና ከረጅም ጸጥታ የሚመጣ ",") የተረዳ አነጋገር አይደለም።
      // በተሳካ ውጤት ሆኖ ለAI መላክ ጉዳት ስለሆነ በግልጽ ኮድ ብቻ ይመዘገባል (F-08 / R-02)።
      if (!validUtterance(text)) {
        done({
          ok: false,
          code: /\[[^\]]+\]/.test(text) ? 'NO_VALID_UTTERANCE' : 'EMPTY_TRANSCRIPT',
          detail: text ? `no words in output: ${JSON.stringify(text).slice(0, 80)}` : 'no words in output',
          text: null,
          locale,
          latency_ms: Date.now() - started,
          engine: 'whisper.cpp',
        });
        return;
      }
      done({
        ok: true,
        code: 'TRANSCRIBED',
        text,
        locale,
        latency_ms: Date.now() - started,
        engine: 'whisper.cpp',
        model: model.split(/[\\/]/).pop(),
      });
    });
  });
}
