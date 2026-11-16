import { offlineModelsEnabled } from './offline-models.mjs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export const LOCALE_TO_CULTURE = { am: 'am-ET', om: 'om-ET', en: 'en-US' };

let cachedVoices = null;

export function listVoices({ refresh = false } = {}) {
  if (cachedVoices && !refresh) return cachedVoices;
  if (process.platform !== 'win32') {
    cachedVoices = { ok: false, code: 'SAPI_WINDOWS_ONLY', voices: [] };
    return cachedVoices;
  }
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Culture.Name + "|" + $_.VoiceInfo.Name }',
  ].join('; ');
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  if (run.status !== 0) {
    cachedVoices = { ok: false, code: 'SAPI_QUERY_FAILED', detail: (run.stderr ?? '').slice(-400), voices: [] };
    return cachedVoices;
  }
  const voices = run.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [culture, ...rest] = line.split('|');
      return { culture, name: rest.join('|') };
    });
  cachedVoices = { ok: true, code: 'VOICES_LISTED', voices };
  return cachedVoices;
}

export function voiceForLocale(locale) {
  const culture = LOCALE_TO_CULTURE[locale];
  const listing = listVoices();
  if (!listing.ok) return { ok: false, code: listing.code, voices: [] };
  const exact = listing.voices.find((v) => v.culture?.toLowerCase() === culture?.toLowerCase());
  return exact
    ? { ok: true, code: 'VOICE_FOUND', voice: exact, culture }
    : { ok: false, code: 'NO_LOCAL_VOICE', culture, available: listing.voices.map((v) => v.culture) };
}

export function ttsStatus() {
  if (offlineModelsEnabled() && process.env.G1_TTS_ENGINE === 'espeak-ng') return { engine: 'eSpeak NG 1.52.0', voices: [], ok: existsSync(fileURLToPath(new URL('../bin/espeak-ng/usr/bin/espeak-ng', import.meta.url))), code: 'G1_EXPERIMENTAL_FORMANT_TTS', network_required: false, license: 'GPL-3.0-or-later', acceptance: 'REQUIRES EVIDENCE', locale_support: Object.fromEntries(['am','om'].map(locale => [locale, { available: existsSync(fileURLToPath(new URL('../bin/espeak-ng/usr/bin/espeak-ng', import.meta.url))), code: 'UPSTREAM_TESTING_NOT_LISTENER_ACCEPTED' }])) };
  if (offlineModelsEnabled()) return { engine: 'MMS-VITS', voices: [], ok: process.env.G1_NONCOMMERCIAL_RESEARCH === '1', code: 'G1_RESEARCH_ONLY', network_required: false, scope: 'NONCOMMERCIAL_G1_RESEARCH_ONLY', license: 'CC-BY-NC-4.0', locale_support: Object.fromEntries(['am','om'].map(locale => [locale, { available: process.env.G1_NONCOMMERCIAL_RESEARCH === '1' && existsSync(fileURLToPath(new URL('../models/facebook--mms-tts-' + (locale === 'am' ? 'amh' : 'orm') + '/model.safetensors', import.meta.url))), code: 'REQUIRES_EVIDENCE' }])) };
  const listing = listVoices();
  return {
    engine: 'windows_sapi',
    ok: listing.ok,
    code: listing.code,
    voices: listing.voices,
    locale_support: Object.fromEntries(Object.keys(LOCALE_TO_CULTURE).map((loc) => {
      const v = voiceForLocale(loc);
      return [loc, { available: v.ok, code: v.code, culture: LOCALE_TO_CULTURE[loc] }];
    })),
    network_required: false,
  };
}

export function synthesize(text, { locale = 'am', outPath, rate = 0 } = {}) {
  const plain = String(text ?? '').trim();
  if (!plain) return { ok: false, code: 'EMPTY_TEXT' };
  if (!outPath) return { ok: false, code: 'OUTPUT_PATH_REQUIRED' };
  const voice = voiceForLocale(locale);
  if (!voice.ok) {
    return {
      ok: false,
      code: voice.code,
      locale,
      culture: voice.culture ?? LOCALE_TO_CULTURE[locale],
      available_cultures: voice.available ?? [],
      detail: 'no installed offline voice for this language',
    };
  }
  mkdirSync(dirname(outPath), { recursive: true });
  const encoded = Buffer.from(plain, 'utf8').toString('base64');
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.SelectVoice(${JSON.stringify(voice.voice.name)})`,
    `$s.Rate = ${Math.trunc(rate)}`,
    `$s.SetOutputToWaveFile(${JSON.stringify(outPath)})`,
    `$s.Speak([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${JSON.stringify(encoded)})))`,
    '$s.Dispose()',
  ].join('; ');
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  if (run.status !== 0 || !existsSync(outPath)) {
    return { ok: false, code: 'TTS_RENDER_FAILED', detail: (run.stderr ?? '').slice(-400) };
  }
  return {
    ok: true,
    code: 'SYNTHESIZED',
    locale,
    voice: voice.voice.name,
    culture: voice.culture,
    path: outPath,
    bytes: statSync(outPath).size,
  };
}
