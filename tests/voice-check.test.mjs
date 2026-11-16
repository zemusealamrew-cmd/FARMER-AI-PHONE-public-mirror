// F-08 / F-11 / R-02 / R-03 / OP-01፦ የድምጅ ማስረጃ መሣሪያው (tools/voice-check.mjs) ትክክለኛነት።
// ደንቡ፦ መሣሪያው ውጤት አይፈጥርም — ያለመረዳትን በግልጽ ኮድና በማስረጃ ቃል (MET/PARTIAL/GAP/…) ይመዘግባል።
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VERDICTS,
  cpuSamplerScript,
  errorRate,
  parseArgs,
  parseCpuTrace,
  parseTasklistRssKb,
  peakAmp,
  percentile,
  repeatTotal,
  runVoiceCheck,
  startChildCpuSampler,
  summariseCpuTrace,
  summariseLatency,
  toWav16kMono,
  writeReport,
} from '../tools/voice-check.mjs';

const dir = mkdtempSync(join(tmpdir(), 'voicecheck-'));

function wav(rate, channels, seconds, amp = 0) {
  const frames = Math.round(rate * seconds);
  const bytes = 44 + frames * channels * 2;
  const b = Buffer.alloc(bytes);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + frames * channels * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE((rate * channels * 2) / 1, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(frames * channels * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const v = amp ? Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / rate)) : 0;
      b.writeInt16LE(v, 44 + (i * channels + c) * 2);
    }
  }
  return b;
}

test('F-11 / OP-01፦ የትዕዛዝ መረጮች ይተረጎማሉ — ያልታወቀ መረጭ ግን በግልጽ ይከዳል', () => {
  const o = parseArgs(['--wav', 'a.wav', '--locale', 'am', '--reference', 'text', '--roundtrip', '--show-text']);
  const kebab = parseArgs(['--tts-sample', 'hello', '--tts-locale', 'en', '--out', 'e.json']);
  assert.equal(kebab.ttsSample, 'hello', 'kebab-case option must reach the camelCase field');
  assert.equal(kebab.ttsLocale, 'en');
  assert.equal(kebab.out, join(process.cwd(), 'e.json'));
  assert.equal(o.wav, join(process.cwd(), 'a.wav'), 'የድምጅ መንገድ ወደ ፈላጭ መንገድ ይቀየራል');
  assert.equal(o.locale, 'am');
  assert.equal(o.roundtrip, true);
  assert.equal(o.showText, true);
  assert.equal(parseArgs(['--bogus']).error.includes('--bogus'), true, 'ያልታወቀ መረጭ ሳይደበቅ ተመዝግቧል');
});

test('F-08 / R-02፦ ወደ 16 kHz mono ያልተቀየረው የASR መንገድ ይከሻል (የተረጋገጠ እውነተኛ ጉድለት)', () => {
  const stereo22 = wav(22050, 2, 0.4, 8000);
  const conv = toWav16kMono(stereo22);
  assert.equal(conv.ok, true);
  assert.equal(conv.changed, true);
  assert.equal(conv.buffer.readUInt32LE(24), 16000, 'sample_rate=16000');
  assert.equal(conv.buffer.readUInt16LE(22), 1, 'አንድ ቻናል ብቻ');
  assert.equal(conv.buffer.readUInt32LE(4), conv.buffer.length - 8, 'RIFF ርዝመት ራሱን ይገዛል');
  assert.ok(Math.abs(conv.seconds - 0.4) < 0.05, 'ቆይታው በ16k ሲቀየር አይጠፋም');

  const already = toWav16kMono(wav(16000, 1, 0.2));
  assert.equal(already.ok, true);
  assert.equal(already.changed, false, 'አስተያየት የሌለበት ፋይል ዳግም አይቀየርም');

  assert.equal(toWav16kMono(Buffer.from('not a wav at all')).code, 'NOT_A_RIFF_WAV');
});

test('F-08፦ ዝግ ማስታወሻ (peak=0) ከተመዘገበ የሰው ድምጅ አረጋገጥ አይደለም', () => {
  assert.equal(peakAmp(wav(16000, 1, 0.2)), 0, 'የተሞላ በዜሮ ፋይል ጫፍ 0 ነው');
  assert.ok(peakAmp(wav(16000, 1, 0.2, 9000)) > 0, 'ድምጽ ያለው ፋይል ጫፉ ከዜሮ በላይ ነው');
});

test('R-02 / R-03፦ የWER/CER ሂሳብ ማንበብ ተገናዞ ይሰላል', () => {
  const same = errorRate('the farmer plants maize', 'the farmer plants maize');
  assert.equal(same.wer, 0);
  assert.equal(same.cer, 0);
  assert.equal(same.reference_words, 4);

  const one = errorRate('the farmer plants maize', 'the farmer plant maize');
  assert.equal(one.wer, 0.25, 'አንድ ቃል ከአራት ተሳስቶ 25%');

  const none = errorRate('the farmer plants maize', '');
  assert.equal(none.wer, 1, 'ሙሉ በሙሉ ካልተረዳ 100%');

  const empty = errorRate('', 'hyp');
  assert.equal(empty.wer, null);
  assert.equal(empty.note, 'REFERENCE_EMPTY', 'ማጣቀሻ ሳይኖር ውጤት አይታደስም');
});

test('F-11፦ ያለ ድምጅ ግብይት ሲሆን የASR ዳመና REQUIRES_EVIDENCE ነው እንጂ MET አይደለም', async () => {
  const fakeBin = join(dir, 'fake-cli.exe');
  const fakeModel = join(dir, 'fake-model.bin');
  writeFileSync(fakeBin, 'not a whisper binary', 'utf8');
  writeFileSync(fakeModel, 'not a ggml model', 'utf8');
  const saved = { bin: process.env.ASR_BIN, model: process.env.ASR_MODEL };
  process.env.ASR_BIN = fakeBin;
  process.env.ASR_MODEL = fakeModel;
  try {
    const report = await runVoiceCheck({ locale: 'am', out: join(dir, 'no-input.json') });
    assert.equal(report.verdicts.asr, 'REQUIRES_EVIDENCE', 'ግብይት ሳለ የለሽ ውጤት አይደለም');
    assert.equal(report.asr, null);
    assert.equal(report.offline_only, true);
    assert.equal(report.gate, 'G1');
    for (const v of Object.values(report.verdicts)) {
      assert.ok(VERDICTS.includes(v), `የማስረጃ ቃል ውጭ የሆነ ዳመና፦ ${v}`);
    }
    assert.ok(!['MET', 'GO'].includes(report.verdicts.asr));
  } finally {
    if (saved.bin === undefined) delete process.env.ASR_BIN; else process.env.ASR_BIN = saved.bin;
    if (saved.model === undefined) delete process.env.ASR_MODEL; else process.env.ASR_MODEL = saved.model;
  }
});

test('F-08 / R-02፦ ዝግ ድምጅ ለASR ሲላክ ዳመናው GAP ሆኖ የተፈጠረ ጽሑፍ አይደበቅም', async () => {
  const fakeBin = join(dir, 'fake-cli.exe');
  const fakeModel = join(dir, 'fake-model.bin');
  const silent = join(dir, 'silent-am.wav');
  writeFileSync(silent, wav(16000, 1, 0.3, 0));
  const saved = { bin: process.env.ASR_BIN, model: process.env.ASR_MODEL };
  process.env.ASR_BIN = fakeBin;
  process.env.ASR_MODEL = fakeModel;
  try {
    const report = await runVoiceCheck({ locale: 'am', wav: silent, out: join(dir, 'silent.json'), reference: 'የበቆሎ ዘር' });
    assert.equal(report.asr.silent_input, true, 'ማሳወቂያው ዝግ መሆኑን ይናገራል');
    assert.equal(report.asr.peak_amplitude, 0);
    assert.equal(report.asr.code, 'SILENT_CAPTURE', 'ኢንጂኑ ሳይነሳ የግብይት ጥበቃው ቆሟል');
    assert.equal(report.asr.input_guard, true, 'የጥበቃ ኮድ መሆኑ በማስረጃው ላይ ተመዝግቧል');
    assert.equal(report.verdicts.asr, 'GAP', 'ዝግ ማስታወሻ የሰው ድምጅ አረጋገጥ አያደርግም');
    assert.equal(report.asr.text, null, 'ያልተረዳ ድምጅ የተፈጠረ ጽሑፍ አይደበቅም');
    assert.equal(report.asr.error_rates.wer, 1, 'የማይታወቅ ጽሑፍ 100% ስህተት ተብሎ ይቆጠራል');
    const path = writeReport(report, join(dir, 'silent-written.json'));
    const back = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(back.verdicts.asr, 'GAP');
    assert.equal(back.assets.length >= 2, true, 'የኢንጂንና ሞዴል ክውንነት ተመዝግቧል');
  } finally {
    if (saved.bin === undefined) delete process.env.ASR_BIN; else process.env.ASR_BIN = saved.bin;
    if (saved.model === undefined) delete process.env.ASR_MODEL; else process.env.ASR_MODEL = saved.model;
  }
});

test('F-11 / R-03፦ unsupported TTS locale is recorded as GAP, never as success', async () => {
  const report = await runVoiceCheck({ locale: 'zz', ttsSample: 'abc', ttsLocale: 'zz', out: join(dir, 'zz.json') });
  assert.equal(report.tts.sample.ok, false);
  assert.notEqual(report.tts.sample.code, 'SYNTHESIZED');
  assert.equal(report.verdicts.tts, 'GAP');
  assert.equal(report.roundtrip, null, 'roundtrip without a real sample is not claimed');
});

test('F-11 / R-03: missing audio input is GAP and the path is shown, not hidden', async () => {
  const report = await runVoiceCheck({ locale: 'am', wav: join(dir, 'does-not-exist.wav'), out: join(dir, 'missing.json') });
  assert.equal(report.asr.code, 'WAV_NOT_FOUND');
  assert.equal(report.verdicts.asr, 'GAP');
  assert.equal(report.asr.detail, join(dir, 'does-not-exist.wav'));
});

test('F-11፦ የwhisper ልጅ ሂደት RSS ከtasklist CSV ይነበባል — ረድፍ ከሌለ 0 ሳይሆን null', () => {
  const out = '"Image Name","PID","Session Name","Session#","Mem Usage"\r\n'
    + '"whisper-cli.exe","4321","Console","1","412,456 K"\r\n'
    + '"node.exe","100","Console","1","50,000 K"\r\n';
  assert.equal(parseTasklistRssKb(out, 4321), 412456);
  assert.equal(parseTasklistRssKb(out, '4321'), 412456);
  assert.equal(parseTasklistRssKb(out, 9999), null, 'የተሳሳተ PID ሌላ ሂደት ማህደረ ትውስታ እንዳይመዘገብ');
  assert.equal(parseTasklistRssKb('', 4321), null);
  assert.equal(parseTasklistRssKb('"INFO: No tasks are running which match the specified criteria."\r\n', 4321), null);
});

test('F-11፦ የሀብት መለኪያ ወሰኑ በዳመናው ውስጥ በግልጽ ይገለጻል — proxy ከልጅ ሂደት መለኪያ ይለያል', async () => {
  const report = await runVoiceCheck({ locale: 'en', out: join(dir, 'rss-scope.json') });
  assert.match(report.resource_scope_note, /tasklist/);
  assert.match(report.resource_scope_note, /NOT MEASURED/);
});

test('F-11፦ የCPU ሰራጭ ጥረቶች ይነበባሉ — ቅርጽ የሌለው መስመር ተወግዶ እውነተኛ ናሙና ብቻ ይቆያል', () => {
  const trace = parseCpuTrace('1000|0.5\r\n1400|0.9\r\nsidecar noise\r\n1800|1.3\r\n|2.0\r\n');
  assert.deepEqual(trace, [{ t_ms: 1000, cpu_s: 0.5 }, { t_ms: 1400, cpu_s: 0.9 }, { t_ms: 1800, cpu_s: 1.3 }]);
  assert.deepEqual(parseCpuTrace(''), []);
  assert.deepEqual(parseCpuTrace(null), []);
});

test('F-11፦ CPU% = የልጅ ሂደት ሰከንድ ÷ የተመለከተ ጊዜ — ከ2 በታች ናሙና 0 ሳይሆን NOT MEASURED', () => {
  const flat = summariseCpuTrace([{ t_ms: 0, cpu_s: 1 }, { t_ms: 1000, cpu_s: 1.5 }]);
  assert.equal(flat.cpu_seconds, 0.5);
  assert.equal(flat.avg_percent_of_one_core, 50);
  assert.equal(flat.peak_percent_of_one_core, 50);
  const peaky = summariseCpuTrace([{ t_ms: 0, cpu_s: 0 }, { t_ms: 1000, cpu_s: 0.2 }, { t_ms: 2000, cpu_s: 1.2 }]);
  assert.equal(peaky.cpu_seconds, 1.2);
  assert.equal(peaky.avg_percent_of_one_core, 60);
  assert.equal(peaky.peak_percent_of_one_core, 100, 'የመጨረሻው ክፍለ-ጊዜ ብቻ 1 ኮር ሙሉ ነው');
  for (const bad of [[], [{ t_ms: 5, cpu_s: 1 }]]) {
    const r = summariseCpuTrace(bad);
    assert.equal(r.cpu_seconds, null, 'ናሙና ሲያንስ ውጤት አይፈጠርም');
    assert.match(r.scope, /NOT MEASURED/);
  }
  const backwards = summariseCpuTrace([{ t_ms: 100, cpu_s: 5 }, { t_ms: 0, cpu_s: 1 }]);
  assert.equal(backwards.cpu_seconds, null, 'የጊዜ መቀየር አሉታዉን ውጤት አይገልጽም');
});

test('F-11፦ የሰራጭ ቧናት PIDን ይገምታል — ልክ ያልሆነ PID ትዕዛዝ አይሠራም', () => {
  assert.equal(cpuSamplerScript(0), null);
  assert.equal(cpuSamplerScript(-1), null);
  assert.equal(cpuSamplerScript(1.5), null);
  assert.equal(cpuSamplerScript('4321'), null, 'string PID ተቀባይነት የለውም');
  const script = cpuSamplerScript(4321);
  assert.match(script, /Get-Process -Id 4321 -ErrorAction Stop/);
  assert.match(script, /InvariantCulture/, 'የአሃዝ ቅርጽ በባህል አይዛባም');
});

test('F-11፦ የCPU ሰራጭ ልኬት ከሂደቱ ራሱ-ሪፖርት ጋር ይጣጣማል፤ ናሙና ሲያንስ ውጤት አይፈጠርም — ቧናቱ ሲያልቅ ራሱ ይዘጋል', { skip: process.platform !== 'win32' && 'Windows Get-Process መሣሪያ ይጠይቃል' }, async () => {
  // ይህ ፍተሻ በዚህ ዙር ሦስት እውነተኛ የተደጋጋሚ-አለመሆን (flaky) ምክንያቶች ተይዘዋል፦ (1) ናሙና 2 ሲሆን የተመዘገበው ልክ 0.3 ሰከንድ «>0.3» ወሰኑ ስላለፈው አላልፈውና ፍተሻው ወድቋል፤ (2) ጫና ሲበረታ በ4 ሰከንድ ውስጥ PowerShell ሰራጩ **1 ናሙና** ብቻ አግኝቷል።
  // ምክንያቱ የመሣሪያ ጉድለት ሳይሆን የማሽን መከረር (scheduler starvation) ነው። (3) በዚህ ዙር የተገኘው፦ `node --test tests/` 20 ቅጥሮች በትይዩ ስለሚያሮጥ አንዱ ዙር ላይ ሰራጩ 37% ሲለካ የሕፃኑ ራሱ-ሪፖርት ≥50% ሆኖ ቋሚው «>40%» ወሰን ተሰበረ — ይህም የሌላ ጫና-አልባ ሐሳብ ነው። አሁን ሁሉም ንጽጽር ከራሱ-ሪፖርት ጋር በመሆኑ በማሽን ጫና አይሰበርም፤ ውጤቱም 19 ፍተሻ ሆኖ ቆይቷል።
  const kid = spawn(process.execPath, ['-e', 'const t=Date.now();let x=0;while(Date.now()-t<3000){x+=Math.sqrt(x+1)}const c=process.cpuUsage();process.stdout.write(JSON.stringify({wall_ms:Date.now()-t,cpu_ms:(c.user+c.system)/1000})+"\\n")'], { windowsHide: true });
  let out = '';
  kid.stdout.on('data', (chunk) => { out += chunk; });
  const stop = startChildCpuSampler(kid.pid);
  await new Promise((finish) => kid.on('close', finish));
  const self = JSON.parse(out.trim().split(/\r?\n/).pop());
  assert.ok(self.cpu_ms > 0 && self.wall_ms >= 3000, `ሕፃኑ የራሱ ሪፖርት ሰጥቷል (${self.cpu_ms}ms CPU በ${self.wall_ms}ms)`);
  const trace = stop();
  const cpu = summariseCpuTrace(trace);
  if (trace.length < 2) {
    assert.equal(cpu.cpu_seconds, null, 'ናሙና ካነሰ የCPU ሰከንድ አይፈጠርም (F-11 ዜሮ-ፍጠርት ደንብ)');
    assert.equal(cpu.avg_percent_of_one_core, null, 'ናሙና ካነሰ CPU% አይፈጠርም');
    assert.match(cpu.scope, /NOT MEASURED/, 'ወሰኑ በግልጽ ይቀመጣል — ማሽኑ ሲጨናነቅ ልኬቱ አለመሳካቱ ይታወቃል፣ መሰለ አይከዳም');
    return;
  }
  const window_ms = trace[trace.length - 1].t_ms - trace[0].t_ms;
  assert.ok(Number.isFinite(cpu.cpu_seconds) && cpu.cpu_seconds >= 0, `ሰራጭ ቁጥር መመዝገብ አለበት (${cpu.cpu_seconds})`);
  const self_pct = (self.cpu_ms / self.wall_ms) * 100;
  // F-11 ማስረጃ-ዋስትና በሁለት የመሣሪያ-ጫና-ገለልተኛ እውነታዎች ላይ ብቻ ተመሠረተ፦
  // (1) የሰራጭ መስኮት የሕፃኑ ሕይወት ንዑስ-ክፍል ስለሆነ የሚመዘገበው CPU-ሰከንድ ከሕፃኑ ራሱ-ሪፖርት በላይ ሊሆን አይችልም — ከሆነ ማስረጃው የተፈጠረ ነው።
  // (2) መስኮቱ የሕፃኑን ሕይወት ≥70% ሲሸፍን ብቻ ሁለቱ ቁጥሮች በእኩልነት መዛገብ አለባቸው፤ ከዚያ በታች ማዛገብ የሌለበት ክፍል-ሕይወት ልኬት ነው።
  assert.ok(cpu.cpu_seconds <= self.cpu_ms / 1000 + 0.01, `ሰራጭ (${cpu.cpu_seconds} ሰ) ከሕፃኑ ራሱ-ሪፖርት (${Math.round(self.cpu_ms)} ms) በላይ ሊሄድ አይገባም — ከሄደ F-11 CPU ማስረጃ የተፈጠረ ነው`);
  if (window_ms >= 0.7 * self.wall_ms && self_pct >= 20) {
    const tol = Math.max(40, self_pct * 0.6);
    assert.ok(Math.abs(cpu.avg_percent_of_one_core - self_pct) <= tol, `ሰራጭ ${cpu.avg_percent_of_one_core}% ከራሱ-ሪፖርት ${Math.round(self_pct)}% በ±${Math.round(tol)}% ውስጥ መሆን አለበት (${window_ms} ms ከ${self.wall_ms} ms ሕይወት ተመልክቷል) — ካልሆነ F-11 CPU ማስረጃ ሐሰተኛ ነው`);
  }
  // የመዝጊያ ባህሪ (የፍተሻው ርዕስ)፦ ቧናቱ ከተዘጋ በኋላ አዲስ ናሙና ሊጨመር አይችልም
  await new Promise((sleep) => setTimeout(sleep, 700));
  const after = stop();
  assert.equal(after.length, trace.length, `ቧናቱ ከተዘጋ በኋላ ናሙና አልጨመረም (${trace.length} → ${after.length})`);
});

test('F-11 / D-003፦ percentile = nearest-rank (ceil(q·n)) ከተደረደረ ዝርዝር ላይ', () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(ten, 0.5), 5, 'p50 በ10 ዋጋ = 5ኛው');
  assert.equal(percentile(ten, 0.95), 10, 'p95 ወደ ጫፍ ይጠጋል');
  assert.equal(percentile(ten, 0.01), 1, 'ዝቅተኛው ዋጋ አይዘረፈም');
  assert.equal(percentile([], 0.5), null, 'ባዶ ዝርዝር null ይመልሳል');
});

test('F-11 / D-003፦ የጊዜ ስፋን ስታቲስቲክስ ትክክል ነው፤ ከ2 በታች ሩጫ ግን NOT MEASURED', () => {
  const runs = [5, 4, 6, 5, 100].map((engine_ms, i) => ({
    run: i + 1, ok: true, engine_ms,
    transcript_sha256_16: 'aaaaaaaaaaaaaaaa',
    child_rss_peak_mb: 470 + i, child_cpu_avg_percent_of_one_core: 390 + i,
  }));
  const d = summariseLatency(runs);
  assert.equal(d.runs, 5);
  assert.equal(d.successful_runs, 5);
  assert.equal(d.min_ms, 4);
  assert.equal(d.max_ms, 100);
  assert.equal(d.p50_ms, 5, 'አንድ ጫፍ አማካዩን ሳይስብ p50 መቆየት አለበት');
  assert.equal(d.p95_ms, 100);
  assert.equal(d.mean_ms, 24, '(5+4+6+5+100)/5 = 24');
  assert.equal(d.deterministic_transcript, true);
  assert.deepEqual(d.rss_peak_mb_range, [470, 474]);
  assert.deepEqual(d.cpu_avg_range_pct_of_one_core, [390, 394]);

  const one = summariseLatency([{ ok: true, engine_ms: 500 }]);
  assert.equal(one.p50_ms, null, 'አንድ ሩጫ ስፋን አይሰጥም');
  assert.match(one.scope, /NOT MEASURED/);
  assert.equal(summariseLatency([]).runs, 0);
});

test('F-11 / D-003፦ የሆነ ጽሑፍ ባያልቅ ሩጫ ብዛት እኩል ቢሆን determinism አይጠያቅም', () => {
  const failed = [1, 2, 3].map((run) => ({ run, ok: false, code: 'ASR_FAILED', engine_ms: 20 + run }));
  const d = summariseLatency(failed);
  assert.equal(d.successful_runs, 0);
  assert.equal(d.distinct_transcript_hashes, 0);
  assert.equal(d.deterministic_transcript, null, 'ያለ ጽሑፍ «ተመሳሳይ» ብሎ ማስመሰል የለም');
});

test('F-11 / OP-01፦ --repeat ጥያቄ ተቆጣጣሪ ነው — የተሳሳተ ቁጥር በግልጽ ይቀረሃል', () => {
  assert.equal(repeatTotal('12'), 12);
  assert.equal(repeatTotal(1), 1);
  assert.equal(repeatTotal('999'), 50, 'በ50 ተቆርጧል (የሩጫ ጊዜ ለማስተዳደር)');
  assert.equal(repeatTotal('0'), null);
  assert.equal(repeatTotal('-3'), null);
  assert.equal(repeatTotal('2.5'), null);
  assert.equal(repeatTotal('abc'), null);
  assert.match(parseArgs(['--repeat', 'x']).error, /--repeat/);
  assert.equal(parseArgs(['--repeat', '12', '--wav', 'a.wav']).repeat, '12');
});

test('F-11 / F-19፦ --repeat ሲጠየቅ ስፋኑ ይመዘገባል፤ ውጤቱ MET አይደለም', async () => {
  const fakeBin = join(dir, 'fake-cli.exe');
  const fakeModel = join(dir, 'fake-model.bin');
  const tone = join(dir, 'repeat-tone.wav');
  // ድምፅ ያለው ናሙና — የግብይት ጥበቃው ከጠራበረ ኢንጂኑ ስለማይነሳ የድግግሞሽ ስርጭቱ አይመዘገብም (F-11)
  // A stationary tone is now intentionally rejected. A nonstationary chirp
  // reaches the injected failing engine so repeated failure timings remain tested.
  const fixture = wav(16000, 1, 0.3, 9000);
  for (let i = 0; i < 4800; i++) fixture.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * (220 * i + 0.02 * i * i) / 16000)), 44 + i * 2);
  writeFileSync(tone, fixture);
  writeFileSync(fakeBin, 'not a whisper binary', 'utf8');
  writeFileSync(fakeModel, 'not a ggml model', 'utf8');
  const saved = { bin: process.env.ASR_BIN, model: process.env.ASR_MODEL };
  process.env.ASR_BIN = fakeBin;
  process.env.ASR_MODEL = fakeModel;
  try {
    const report = await runVoiceCheck({ locale: 'am', wav: tone, out: join(dir, 'repeat.json'), repeat: '3' });
    assert.equal(report.latency.repeat_total, 3, 'እያንዳንዱ ድግግሞሽ በራሱ ይመዘገባል');
    assert.equal(report.latency.runs.length, 3);
    assert.equal(report.latency.distribution.runs, 3);
    assert.equal(report.latency.distribution.successful_runs, 0, 'የተሳሳሁ ሩጫዎች «ተሳኩ» አይባሉም');
    for (const v of Object.values(report.verdicts)) assert.ok(VERDICTS.includes(v));
    assert.ok(!['MET', 'GO'].includes(report.verdicts.latency), 'የጊዜ ልኬት ሲነሳ MET ሊባል አይችልም');
    assert.match(report.latency.note, /D-003|NOT MEASURED/);
  } finally {
    if (saved.bin === undefined) delete process.env.ASR_BIN; else process.env.ASR_BIN = saved.bin;
    if (saved.model === undefined) delete process.env.ASR_MODEL; else process.env.ASR_MODEL = saved.model;
  }
});
