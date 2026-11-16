import { readFileSync } from 'node:fs';
import { nowIso, newId, tokens } from './util.mjs';
import { detectUntrustedInstruction } from './safety.mjs';

export class FmAdapter {
  constructor(path, kb) {
    this.path = path;
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    this.stations = raw.stations;
    this.broadcasts = raw.broadcasts;
    this.kb = kb;
    this.claims = [];
    this.maxAgeHours = 24;
  }

  station(id) {
    return this.stations.find((s) => s.id === id);
  }

  ageHours(capturedAt, at = nowIso()) {
    return (new Date(at).getTime() - new Date(capturedAt).getTime()) / 3600000;
  }

  // G1 ማሳያ ብቻ፦ በላፕቶፕ ላይ የFM→PCM እውነተኛ መንገድ ስላልተረጋገገ እያንዳንዱ ወጪ "simulated" ነው።
  // እውነተኛ የመሣሪያ መዳረሻ UNKNOWN ነው (F-12 / VE-02 / HC-02)፤ በG2 ይረጋገጣል።
  ingest({ station_id, text, captured_at, signal_quality = 0.5, topic_id = null }) {
    const st = this.station(station_id);
    if (!st) return { ok: false, code: 'UNKNOWN_STATION' };
    const injection = detectUntrustedInstruction(text);
    const age = this.ageHours(captured_at || nowIso());
    const claim = {
      claim_id: newId('FM-CLAIM'),
      topic_id: topic_id || this.inferTopic(text),
      text: String(text).slice(0, 800),
      source_kind: 'fm_simulated',
      station_id,
      station_name: st.name,
      frequency_mhz: st.frequency_mhz,
      captured_at: captured_at || nowIso(),
      age_hours: Math.round(age * 10) / 10,
      stale: age > this.maxAgeHours,
      signal_quality,
      confidence: signal_quality >= 0.7 ? 'medium' : 'low',
      verification: 'unverified_broadcast',
      untrusted_instruction: injection.untrusted,
      execution_allowed: false,
      hardware_path_verified: false,
    };
    this.claims.push(claim);
    return { ok: true, claim, conflicts: this.conflicts(claim), warning: injection.untrusted ? 'BROADCAST_CONTAINS_INSTRUCTION_TEXT_NOT_EXECUTED' : null };
  }

  inferTopic(text) {
    const t = new Set(tokens(text));
    let best = null;
    for (const e of this.kb.entries) {
      let s = 0;
      for (const kw of e.keywords) if (t.has(kw.toLowerCase())) s += 1;
      if (s > 0 && (!best || s > best.s)) best = { topic: e.topic_id, s };
    }
    return best?.topic ?? 'unclassified';
  }

  conflicts(claim) {
    const kbEntries = this.kb.byTopic(claim.topic_id);
    if (!kbEntries.length) return [];
    return kbEntries
      .filter((e) => e.source.kind !== 'fm_simulated')
      .map((e) => ({
        claim_id: e.claim_id,
        kb_answer: e.answer,
        note: 'FM claim and knowledge-base entry both exist; sources differ and neither is automatically authoritative.',
      }));
  }

  ask(queryTopic) {
    const matches = this.claims.filter((c) => c.topic_id === queryTopic || c.text.includes(queryTopic));
    if (!matches.length) return { ok: false, code: 'NO_MATCHING_BROADCAST' };
    const latest = matches.sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at))[0];
    return {
      ok: true,
      claim: latest,
      presentAsToday: !latest.stale,
      note: latest.stale ? 'BROADCAST_STALE_NOT_TODAY' : 'BROADCAST_FRESH_BUT_STILL_UNVERIFIED',
      conflicts: this.conflicts(latest),
    };
  }
}
