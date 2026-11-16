// R-02 / R-03 / F-08 / F-11 / OP-01፦ የድምጅ ችሎታ አንድ-ትዕዛዝ ማስረጃ መሣሪያ።
// ዓላማ፦ "ተሞክሮ አለ" የሚለው ቃል ብቻ እንዳይሆን — የግብይት ፋይል፣ የኢንጂን/ሞዴል ሃሽ፣ የጊዜና የማሽን
// ሀብት መለኪያ፣ የተሳካ ወይም የተሳነ ውጤት ኮድ በአንድ JSON ላይ ይደረጋሉ። ማከማቻው ውስጥ ያሉት
// ኮረጫና ሞዴል (app/bin, app/models) ከGit ውጭ ስለሆኑ ይህ መሣሪያ በእያንዳንዱ ማሽን ላይ ያለውን
// እውነተኛ ሁኔታ ይመዘግባል እንጂ አስቀድሞ የተጻፈ ውጤት አይናገርም።
// ምሳሌዎች፦
//   node tools/voice-check.mjs --wav app/.tmp/my-am.wav --locale am --reference "የበቆሎ ዘር ማዘጋጀት"
//   node tools/voice-check.mjs --tts-sample "Hello farmer" --locale en --show-text
//   node tools/voice-check.mjs --list-voices
//   node tools/voice-check.mjs --wav evidence/audio/en-tts-roundtrip-input-16k.wav --locale en --reference "…" --repeat 12   (የp50/p95 መነሻ-ውሂብ)
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asrPaths, asrStatus, INPUT_GUARD_CODES, transcribe, WHISPER_LOCALES } from '../app/src/asr.mjs';
import { synthesize, ttsStatus, voiceForLocale } from '../app/src/tts.mjs';
import { resourceSnapshot } from '../app/src/evidence.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
export const VERDICTS = ['MET', 'PARTIAL', 'GAP', 'UNKNOWN', 'REQUIRES_EVIDENCE', 'N/A'];

export function parseArgs(argv) {
  const out = { locale: 'am', out: join(REPO, 'evidence', 'voice-check.json'), showText: false, listVoices: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--show-text') out.showText = true;
    else if (a === '--list-voices') out.listVoices = true;
    else if (a === '--roundtrip') out.roundtrip = true;
    else if (['--wav', '--locale', '--reference', '--tts-sample', '--out', '--tts-locale', '--repeat'].includes(a)) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[++i];
    }
    else return { error: `ያልታወቀ፦ ${a}` };
  }
  if (out.wav) out.wav = resolve(out.wav);
  if (out.out) out.out = resolve(out.out);
  if (out.repeat !== undefined && repeatTotal(out.repeat) === null) return { error: `--repeat ኢንቲጀር ≥1 መሆን አለበት፦ ${out.repeat}` };
  return out;
}

export function sha256Prefix(buf, chars = 16) {
  return createHash('sha256').update(buf).digest('hex').slice(0, chars);
}

// whisper 16 kHz mono PCM ብቻ ይቀበላል፤ SAPI/Windows WAVs ብዙውን 22050 Hz ወይም ስቴሪዮ ናቸው።
// ይህ ወደ "ASR_FAILED" ሳይሄድ በራስ-ሰር ወደ 16k mono ይቀይራል (የተገኘ እውነተኛ ጉድለት መሠረት)።
export function toWav16kMono(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return { ok: false, code: 'NOT_A_RIFF_WAV' };
  const fmt = buf.readUInt16LE(20);
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (fmt !== 1 || bits !== 16) return { ok: false, code: 'NOT_PCM16', fmt, bits };
  if (rate === 16000 && channels === 1) return { ok: true, changed: false, buffer: buf, rate, channels };
  const frames = (buf.length - 44) / 2 / channels;
  const ratio = 16000 / rate;
  const m = Math.max(1, Math.floor(frames * ratio));
  const pcm = Buffer.alloc(m * 2);
  for (let i = 0; i < m; i += 1) {
    const t = i / ratio;
    const i0 = Math.floor(t);
    const f = t - i0;
    const at = (idx) => {
      if (idx >= frames) return 0;
      let s = 0;
      for (let c = 0; c < channels; c += 1) s += buf.readInt16LE(44 + (idx * channels + c) * 2);
      return s / channels;
    };
    const v = Math.round(at(i0) * (1 - f) + at(i0 + 1) * f);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  const w = Buffer.alloc(44 + m * 2);
  w.write('RIFF', 0);
  w.writeUInt32LE(36 + m * 2, 4);
  w.write('WAVE', 8);
  w.write('fmt ', 12);
  w.writeUInt32LE(16, 16);
  w.writeUInt16LE(1, 20);
  w.writeUInt16LE(1, 22);
  w.writeUInt32LE(16000, 24);
  w.writeUInt32LE(32000, 28);
  w.writeUInt16LE(2, 32);
  w.writeUInt16LE(16, 34);
  w.write('data', 36);
  w.writeUInt32LE(m * 2, 40);
  pcm.copy(w, 44);
  return { ok: true, changed: true, buffer: w, rate, channels, seconds: Math.round((m / 16000) * 100) / 100 };
}

export function peakAmp(buf) {
  let peak = 0;
  for (let i = 44; i + 1 < buf.length; i += 2) {
    const v = Math.abs(buf.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}

export function words(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean);
}

export function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let before = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? before : 1 + Math.min(before, prev[j], prev[j - 1]);
      before = tmp;
    }
  }
  return prev[b.length];
}

export function errorRate(reference, hypothesis) {
  const r = words(reference);
  const h = words(hypothesis);
  if (!r.length) return { wer: null, cer: null, note: 'REFERENCE_EMPTY' };
  const dist = editDistance(r, h);
  const rc = String(reference).replaceAll(/\s+/g, '').split('');
  const hc = String(hypothesis ?? '').replaceAll(/\s+/g, '').split('');
  return {
    wer: Math.round((dist / r.length) * 10000) / 10000,
    cer: rc.length ? Math.round((editDistance(rc, hc) / rc.length) * 10000) / 10000 : null,
    reference_words: r.length,
    hypothesis_words: h.length,
  };
}

export function assetInventory() {
  const { bin, model } = asrPaths();
  const list = [bin, model, join(dirname(bin), 'whisper.dll'), join(dirname(bin), 'ggml.dll')];
  return list.map((p) => {
    if (!existsSync(p)) return { path: p, present: false };
    const b = readFileSync(p);
    return {
      path: p,
      present: true,
      bytes: b.length,
      sha256_16: sha256Prefix(b),
      tracked_in_git: false,
      note: 'app/bin and app/models are gitignored — the hashes below describe this machine only',
    };
  });
}

function versionProbe() {
  const { bin } = asrPaths();
  if (!existsSync(bin)) return { ok: false, code: 'ASR_NOT_INSTALLED' };
  const run = spawnSync(bin, ['--help'], { cwd: dirname(bin), encoding: 'utf8', timeout: 30000, windowsHide: true });
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const line = text.split(/\r?\n/).find((l) => /whisper-cli|version/i.test(l));
  return { ok: Boolean(line), code: line ? 'PROBED' : 'VERSION_NOT_PRINTED', line: line ?? null };
}

function deviceProbe() {
  const cpus = os.cpus();
  return {
    ok: true,
    code: 'PROBED',
    platform: `${process.platform} ${os.release()}`,
    cpu: cpus[0]?.model ?? null,
    logical_threads: cpus.length,
    ram_total_mb: Math.round(os.totalmem() / 1048576),
    ram_free_mb: Math.round(os.freemem() / 1048576),
  };
}

function freeRamMb() {
  return Math.round(os.freemem() / 1048576);
}

// tasklist /fo csv /nh → "whisper-cli.exe","1234","Console","1","412,456 K"
export function parseTasklistRssKb(stdout, pid) {
  const rows = String(stdout ?? '').split(/\r?\n/).filter((l) => l.trim().startsWith('"'));
  for (const row of rows) {
    const cells = row.match(/"([^"]*)"/g)?.map((c) => c.replace(/"/g, '')) ?? [];
    if (cells.length < 5) continue;
    if (String(cells[1]) !== String(pid)) continue;
    const kb = Number(cells[cells.length - 1].replace(/[^0-9]/g, ''));
    return Number.isFinite(kb) && kb > 0 ? kb : null;
  }
  return null;
}

function sampleChildRssKb(pid) {
  return new Promise((finish) => {
    execFile('tasklist', ['/fo', 'csv', '/nh', '/fi', `PID eq ${pid}`], { windowsHide: true }, (error, stdout) => {
      finish(error ? null : parseTasklistRssKb(stdout, pid));
    });
  });
}

// PowerShell Get-Process → "epoch_ms|total_cpu_seconds" (InvariantCulture ⇒ ኮማ የለም)።
export function parseCpuTrace(text) {
  const trace = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^(\d+)\|([0-9]+(?:\.[0-9]+)?)$/.exec(line.trim());
    if (m) trace.push({ t_ms: Number(m[1]), cpu_s: Number(m[2]) });
  }
  return trace;
}

// CPU% = (ልጅ ሂደት CPU ሰከንድ) / (የተመለከተው ጊዜ) — ከአንድ ኮር ውጤት እንደ መቶኛ፤ 100 = ኮር 1ሙሉ
export function summariseCpuTrace(trace) {
  if (trace.length < 2) {
    return {
      samples: trace.length,
      cpu_seconds: null,
      avg_percent_of_one_core: null,
      peak_percent_of_one_core: null,
      scope: 'NOT MEASURED — PowerShell gave fewer than 2 rows (non-Windows, or the child ended before the second sample)',
    };
  }
  const span = trace[trace.length - 1].t_ms - trace[0].t_ms;
  const seconds = trace[trace.length - 1].cpu_s - trace[0].cpu_s;
  if (span <= 0 || seconds < 0) {
    return { samples: trace.length, cpu_seconds: null, avg_percent_of_one_core: null, peak_percent_of_one_core: null, scope: 'NOT MEASURED — invalid trace span' };
  }
  let peak = 0;
  for (let i = 1; i < trace.length; i += 1) {
    const dt = trace[i].t_ms - trace[i - 1].t_ms;
    if (dt <= 0) continue;
    const pct = ((trace[i].cpu_s - trace[i - 1].cpu_s) / dt) * 1000 * 100;
    if (pct > peak) peak = pct;
  }
  return {
    samples: trace.length,
    cpu_seconds: Math.round(seconds * 100) / 100,
    avg_percent_of_one_core: Math.round((seconds / (span / 1000)) * 100),
    peak_percent_of_one_core: Math.round(peak),
    scope: 'observed-window only (first→last sample); the CPU used between the last sample and process exit is not counted — Get-Process cannot read a dead PID',
  };
}

// percentile = nearest-rank (ceil(q·n)) — ዋጋዎች ከተደረደሩ በኋላ
export function percentile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(q * sortedValues.length) - 1));
  return sortedValues[idx];
}

// የድግግሞሽ ስፋን (latency distribution)፦ ለD-003 የቁጥር መነሻ-ውሂብ። «አለፈ/አልፈደም» አይልም።
export function summariseLatency(runs) {
  const done = runs.filter((r) => Number.isFinite(r.engine_ms));
  if (done.length < 2) {
    return {
      runs: done.length,
      p50_ms: null, p95_ms: null, min_ms: null, max_ms: null, mean_ms: null, spread_pct: null,
      distinct_transcript_hashes: null, deterministic_transcript: null,
      rss_peak_mb_range: null, cpu_avg_range_pct_of_one_core: null,
      scope: 'NOT MEASURED — fewer than 2 completed ASR runs',
    };
  }
  const sorted = done.map((r) => r.engine_ms).sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const hashes = [...new Set(done.filter((r) => r.ok).map((r) => r.transcript_sha256_16).filter(Boolean))];
  const rss = done.map((r) => r.child_rss_peak_mb).filter(Number.isFinite);
  const cpu = done.map((r) => r.child_cpu_avg_percent_of_one_core).filter(Number.isFinite);
  return {
    runs: done.length,
    successful_runs: done.filter((r) => r.ok === true).length,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    min_ms: sorted[0],
    max_ms: sorted[sorted.length - 1],
    mean_ms: Math.round(mean),
    spread_pct: Math.round(((sorted[sorted.length - 1] - sorted[0]) / mean) * 100),
    distinct_transcript_hashes: hashes.length,
    deterministic_transcript: hashes.length === 0 ? null : hashes.length <= 1,
    rss_peak_mb_range: rss.length ? [Math.min(...rss), Math.max(...rss)] : null,
    cpu_avg_range_pct_of_one_core: cpu.length ? [Math.min(...cpu), Math.max(...cpu)] : null,
    scope: 'per-run whisper-cli wall time (spawn→exit, includes process start) on this laptop; NOT a phone measurement; pass/fail requires the numeric threshold D-003',
  };
}

// --repeat N ገደብ፦ N አሉታዊ ያልሆነ ኢንቲጀር ብቻ፤ 50 ከላይ ተቆርጧል (ሩጫ ጊዜ ለማስተዳደር)
export function repeatTotal(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, 50);
}

export function cpuSamplerScript(pid) {  if (!Number.isInteger(pid) || pid <= 0) return null;
  return '$ci=[System.Globalization.CultureInfo]::InvariantCulture;'
    + ` for(;;){ try{ $p=Get-Process -Id ${pid} -ErrorAction Stop;`
    + " [Console]::WriteLine([string]::Format($ci,'{0}|{1:0.###}',[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(),$p.CPU)) }"
    + ' catch{ break }; Start-Sleep -Milliseconds 400 }';
}

// ሠራጭ (sidecar) PowerShell ብቻ ይነዳል — የtasklist RSS መለኪያ ዘዴ አይቀየርም
export function startChildCpuSampler(pid) {
  if (process.platform !== 'win32') return () => [];
  const script = cpuSamplerScript(pid);
  if (!script) return () => [];
  const sidecar = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
  let buf = '';
  let stopped = false;
  let finalTrace = [];
  const onData = (chunk) => { if (!stopped) buf += chunk; };
  sidecar.stdout.on('data', onData);
  sidecar.on('error', () => { if (!stopped) buf = ''; });
  return () => {
    if (!stopped) {
      stopped = true;
      sidecar.stdout.off('data', onData);
      finalTrace = parseCpuTrace(buf);
      try { sidecar.kill(); } catch { /* ሰራጭ ራሱ ሞትቷል */ }
    }
    // A queued stdout event can arrive after kill(). Stopping freezes evidence;
    // subsequent calls cannot append a late sample or mutate a prior snapshot.
    return finalTrace.map(sample => ({ ...sample }));
  };
}

async function transcribeSampled(wavPath, locale) {
  const started = process.hrtime.bigint();
  const ramBefore = freeRamMb();
  const samples = [];
  const rssKb = [];
  let childPid = null;
  let sampling = false;
  const poll = setInterval(() => {
    samples.push(freeRamMb());
    // ተደጋጋሚ የtasklist ጥያቄ አይካፈልም — መለኪያው የASR ሂደትን ሳይያስር በተናጠል ይሰራል
    if (childPid && !sampling) {
      sampling = true;
      sampleChildRssKb(childPid).then((kb) => { if (kb) rssKb.push(kb); sampling = false; });
    }
  }, 500);
  let r;
  let stopCpuSampler = null;
  try {
    r = await transcribe(wavPath, {
      locale,
      onSpawn: (pid) => {
        childPid = pid;
        if (!stopCpuSampler) stopCpuSampler = startChildCpuSampler(pid);
      },
    });
  } finally {
    clearInterval(poll);
  }
  const cpu = summariseCpuTrace(stopCpuSampler ? stopCpuSampler() : []);
  const minFree = samples.length ? Math.min(...samples) : null;
  const peakKb = rssKb.length ? Math.max(...rssKb) : null;
  return {
    r,
    ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
    ram: {
      ram_free_before_mb: ramBefore,
      ram_free_min_during_asr_mb: minFree,
      ram_used_proxy_mb: minFree === null ? null : Math.max(0, ramBefore - minFree),
      child_pid: childPid,
      child_rss_peak_mb: peakKb === null ? null : Math.round(peakKb / 1024),
      child_rss_samples: rssKb.length,
      child_rss_scope: peakKb === null
        ? 'NOT MEASURED — tasklist gave no row (non-Windows or process ended before the first sample)'
        : 'የwhisper.cpp ልጅ ሂደት የሥራ-ስብስብ (working set) ከpeak፣ በ500 ms ናሙና',
      logical_processors: os.cpus().length,
      child_cpu_seconds_observed: cpu.cpu_seconds,
      child_cpu_avg_percent_of_one_core: cpu.avg_percent_of_one_core,
      child_cpu_peak_percent_of_one_core: cpu.peak_percent_of_one_core,
      child_cpu_samples: cpu.samples,
      child_cpu_scope: cpu.scope,
    },
  };
}

export async function runVoiceCheck(opts) {
  const report = {
    tool: 'voice-check',
    at: new Date().toISOString(),
    gate: 'G1',
    device: 'laptop-windows',
    locale: opts.locale,
    offline_only: true,
    engine: { asr: 'whisper.cpp', tts: 'windows_sapi' },
    assets: assetInventory(),
    version_probe: versionProbe(),
    device_probe: deviceProbe(),
    asr: null,
    tts: null,
    roundtrip: null,
    verdicts: {},
    resource: resourceSnapshot(),
    resource_scope_note: 'rss/heap in `resource` is the Node process only; the whisper.cpp child peak working set is measured separately as `child_rss_peak_mb` via tasklist (null = NOT MEASURED); child CPU is `child_cpu_seconds_observed` / `child_cpu_avg_percent_of_one_core` from a PowerShell Get-Process sidecar over one core (null = NOT MEASURED)',
    limits_note: 'ይህ በላፕቶፕ ላይ ያለ ሙከራ ነው፤ የባለቁልፍ ስልክ አቅምን አያረጋግጥም። laptop test != phone field verification.',
  };

  const tts = ttsStatus();
  report.tts = {
    engine: tts.engine,
    code: tts.code,
    installed_cultures: tts.voices.map((v) => v.culture),
    locale_support: tts.locale_support,
  };

  if (opts.wav) {
    if (!existsSync(opts.wav)) {
      report.asr = { ok: false, code: 'WAV_NOT_FOUND', detail: opts.wav, text: null };
      report.verdicts.asr = 'GAP';
    } else {
      const raw = readFileSync(opts.wav);
      const conv = toWav16kMono(raw);
      let playPath = opts.wav;
      let converted = null;
      if (conv.ok && conv.changed) {
        converted = { from_rate: conv.rate, from_channels: conv.channels, seconds: conv.seconds };
        playPath = join(dirname(opts.wav), `voicecheck-16k-${sha256Prefix(raw, 8)}.wav`);
        writeFileSync(playPath, conv.buffer);
      } else if (!conv.ok) {
        converted = { error: conv.code };
      }
      const peak = peakAmp(conv.ok && conv.buffer ? conv.buffer : raw);
      const { r, ms, ram } = await transcribeSampled(playPath, opts.locale);
      report.asr = {
        ok: r.ok === true,
        code: r.code,
        locale: opts.locale,
        input_path: opts.wav,
        input_bytes: raw.length,
        input_sha256_16: sha256Prefix(raw),
        peak_amplitude: peak,
        silent_input: peak === 0,
        input_guard: INPUT_GUARD_CODES.has(r.code),
        converted,
        latency_ms: r.latency_ms ?? ms,
        engine_ms: ms,
        ...ram,
        ram_note: ram.child_rss_peak_mb === null
          ? 'system free-RAM delta is a proxy; whisper child RSS NOT MEASURED in this run'
          : `whisper child peak working set ${ram.child_rss_peak_mb} MB from ${ram.child_rss_samples} samples; free-RAM delta is a separate proxy`,
        cpu_note: ram.child_cpu_seconds_observed === null
          ? 'whisper child CPU NOT MEASURED in this run'
          : `whisper child CPU ${ram.child_cpu_seconds_observed}s over ${ram.child_cpu_samples} samples = avg ${ram.child_cpu_avg_percent_of_one_core}% of one core (peak ${ram.child_cpu_peak_percent_of_one_core}%)`,
        words: r.ok ? words(r.text).length : 0,
        transcript_sha256: r.ok ? createHash('sha256').update(r.text).digest('hex') : null,
        text: opts.showText && r.ok ? r.text : null,
        detail: r.ok ? null : String(r.detail ?? '').slice(0, 400),
      };
      if (opts.reference) report.asr.error_rates = errorRate(opts.reference, r.ok ? r.text : '');
      const total = INPUT_GUARD_CODES.has(r.code) ? 0 : repeatTotal(opts.repeat);
      if (total && total > 1) {
        const runRow = (label, res) => ({
          run: label,
          ok: res.r.ok === true,
          code: res.r.code ?? null,
          engine_ms: res.ms,
          transcript_sha256_16: res.r.ok ? sha256Prefix(String(res.r.text ?? '')) : null,
          child_pid: res.ram.child_pid,
          child_rss_peak_mb: res.ram.child_rss_peak_mb,
          child_rss_samples: res.ram.child_rss_samples,
          child_cpu_seconds_observed: res.ram.child_cpu_seconds_observed,
          child_cpu_avg_percent_of_one_core: res.ram.child_cpu_avg_percent_of_one_core,
          child_cpu_peak_percent_of_one_core: res.ram.child_cpu_peak_percent_of_one_core,
          child_cpu_samples: res.ram.child_cpu_samples,
          ram_free_min_during_asr_mb: res.ram.ram_free_min_during_asr_mb,
        });
        const runs = [runRow(1, { r, ms, ram })];
        for (let k = 2; k <= total; k += 1) runs.push(runRow(k, await transcribeSampled(playPath, opts.locale)));
        const dist = summariseLatency(runs);
        report.latency = {
          repeat_total: runs.length,
          input_sha256_16: sha256Prefix(raw),
          locale: opts.locale,
          runs,
          distribution: dist,
          note: dist.p50_ms === null
            ? 'የሙከራ ስፋን NOT MEASURED — ከ2 በታች ሙሉ ሩጫ'
            : `p50 ${dist.p50_ms} ms፣ p95 ${dist.p95_ms} ms በ${dist.runs} ተደጋጋሚ እውነተኛ ሩጫ። መነሻ-ውሂብ ብቻ — «አለፈ» ለማለት የD-003 ወን ያስፈልጋል።`,
        };
        report.verdicts.latency = dist.p50_ms === null ? 'GAP' : 'PARTIAL';
      }
      if (peak === 0) report.verdicts.asr = 'GAP';
      else if (r.ok) report.verdicts.asr = 'PARTIAL';
      else if (r.code === 'EMPTY_TRANSCRIPT') report.verdicts.asr = 'PARTIAL';
      else if (['ASR_NOT_INSTALLED', 'ASR_MODEL_MISSING'].includes(r.code)) report.verdicts.asr = 'REQUIRES_EVIDENCE';
      else report.verdicts.asr = 'GAP';
      // የግብይት ጥበቃ ሲቆም ኢንጂኑ ስላልተነሳ የጊዜ ስርጭት አይተላለፍም — "አልተለካም" በግልጽ ይባላል (F-11)
      if (INPUT_GUARD_CODES.has(r.code)) report.verdicts.latency = 'GAP';
    }
  }

  if (opts.ttsSample) {
    const loc = opts.ttsLocale || opts.locale;
    const outPath = join(REPO, 'app', '.tmp', `voicecheck-tts-${Date.now()}.wav`);
    mkdirSync(dirname(outPath), { recursive: true });
    const ttsStart = process.hrtime.bigint();
    const s = synthesize(opts.ttsSample, { locale: loc, outPath });
    const ttsMs = Math.round(Number(process.hrtime.bigint() - ttsStart) / 1e6);
    report.tts.sample = s.ok
      ? {
          ok: true,
          code: s.code,
          locale: loc,
          voice: s.voice,
          culture: s.culture,
          synthesis_ms: ttsMs,
          bytes: s.bytes,
          path: s.path,
          sha256_16: sha256Prefix(readFileSync(s.path)),
          intelligibility: 'REQUIRES_EVIDENCE (human listening required)',
        }
      : { ok: false, code: s.code, locale: loc, synthesis_ms: ttsMs, available_cultures: s.available_cultures ?? [] };
    const v = voiceForLocale(loc);
    report.verdicts.tts = v.ok ? 'PARTIAL' : 'GAP';
  }

  if (opts.roundtrip && report.tts.sample?.ok) {
    const rtRaw = readFileSync(report.tts.sample.path);
    const rtConv = toWav16kMono(rtRaw);
    let rtPath = report.tts.sample.path;
    if (rtConv.ok && rtConv.changed) {
      rtPath = join(dirname(rtPath), `voicecheck-rt16k-${sha256Prefix(rtConv.buffer, 8)}.wav`);
      writeFileSync(rtPath, rtConv.buffer);
    }
    const rtPeak = peakAmp(rtConv.ok ? rtConv.buffer : rtRaw);
    const { r: back, ms: rtMs, ram: rtRam } = await transcribeSampled(rtPath, opts.locale);
    report.roundtrip = {
      ok: back.ok === true,
      code: back.code,
      locale: opts.locale,
      engine_ms: rtMs,
      ...rtRam,
      tts_input_path: rtPath,
      tts_input_peak_amplitude: rtPeak,
      tts_input_silent: rtPeak === 0,
      converted_to_16k: Boolean(rtConv.ok && rtConv.changed),
      latency_ms: back.latency_ms ?? null,
      transcript_sha256: back.ok ? createHash('sha256').update(back.text).digest('hex') : null,
      text: opts.showText && back.ok ? back.text : null,
      error_rates: errorRate(opts.ttsSample ?? '', back.ok ? back.text : ''),
      note: 'TTS output is a synthetic machine voice, not a human speaker; the ASR path runs on real PCM bytes',
    };
  }

  if (!report.verdicts.asr) report.verdicts.asr = opts.wav ? 'GAP' : 'REQUIRES_EVIDENCE';
  if (!report.verdicts.tts) report.verdicts.tts = report.tts.locale_support?.[opts.locale]?.available ? 'PARTIAL' : 'GAP';
  if (report.roundtrip) report.verdicts.roundtrip = report.roundtrip.ok ? 'PARTIAL' : 'GAP';

  for (const k of Object.keys(report.verdicts)) {
    if (!VERDICTS.includes(report.verdicts[k])) throw new Error(`የተሳሳተ የማስረጃ ቃል፦ ${report.verdicts[k]}`);
  }
  return report;
}

export function writeReport(report, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outPath;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    console.log(`usage: node tools/voice-check.mjs [--wav path] [--locale am|en|om] [--reference text] [--tts-sample text] [--roundtrip] [--repeat N] [--list-voices] [--out file] [--show-text]`);
    console.log(`error: ${opts.error}`);
    process.exit(2);
  }
  if (opts.listVoices) {
    const st = ttsStatus();
    console.log(`ASR ready: ${asrStatus().ready} | locales: ${WHISPER_LOCALES.join(',')}`);
    console.log(`TTS cultures: ${st.voices.map((v) => `${v.culture} (${v.name})`).join('; ') || 'none'}`);
    for (const [loc, info] of Object.entries(st.locale_support)) console.log(`  ${loc}: ${info.available ? 'VOICE_FOUND' : info.code}`);
    process.exit(0);
  }
  const report = await runVoiceCheck(opts);
  const path = writeReport(report, opts.out ?? join(REPO, 'evidence', 'voice-check.json'));
  console.log(`voice-check → ${path}`);
  console.log(JSON.stringify({ verdicts: report.verdicts, asr_code: report.asr?.code ?? null, tts_code: report.tts.sample?.code ?? report.tts.code, latency: report.latency?.distribution ?? null }, null, 0));
}
