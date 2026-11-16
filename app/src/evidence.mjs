import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowIso, sha256 } from './util.mjs';

export class EvidenceLog {
  constructor({ path, gate = 'G1', device = 'laptop-demo', build = null }) {
    this.path = path;
    this.gate = gate;
    this.device = device;
    this.build = build;
    this.prevHash = null;
    this.seq = 0;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      this.seq = lines.length;
      if (lines.length) {
        try {
          this.prevHash = JSON.parse(lines.at(-1)).entry_hash ?? null;
        } catch {
          this.prevHash = null;
        }
      }
    }
  }

  record(kind, payload = {}) {
    const entry = {
      seq: null,
      at: nowIso(),
      gate: this.gate,
      device_id: this.device,
      build: this.build,
      kind,
      ...payload,
    };
    // seq በENV ውስጥ ብቻ ይቆጠራል — እያንዳንዱ መዝገብ ሙሉ ፋይሉን እንዳያነብ (O(n²) የሐሳብ ቦታ/ጊዜ ማራኪ — F-07)
    entry.seq = this.seq + 1;
    this.seq += 1;
    entry.prev_hash = this.prevHash;
    entry.entry_hash = `sha256:${sha256(JSON.stringify({ ...entry, entry_hash: undefined }))}`;
    this.prevHash = entry.entry_hash;
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }

  entries() {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { parse_error: true, raw: line.slice(0, 200) };
        }
      });
  }

  verifyChain() {
    const entries = this.entries();
    let prev = null;
    for (const entry of entries) {
      if (entry.parse_error) return { ok: false, code: 'UNPARSEABLE_LINE', seq: entry.seq ?? null };
      const recomputed = `sha256:${sha256(JSON.stringify({ ...entry, entry_hash: undefined }))}`;
      if (recomputed !== entry.entry_hash) return { ok: false, code: 'HASH_MISMATCH', seq: entry.seq };
      if (entry.prev_hash !== prev) return { ok: false, code: 'CHAIN_BREAK', seq: entry.seq };
      prev = entry.entry_hash;
    }
    return { ok: true, code: 'CHAIN_VERIFIED', entries: entries.length, head: prev };
  }

  reset() {
    writeFileSync(this.path, '', 'utf8');
    this.prevHash = null;
    this.seq = 0;
  }
}

export function resourceSnapshot() {
  const m = process.memoryUsage();
  return {
    rss_mb: Math.round((m.rss / 1024 / 1024) * 10) / 10,
    heap_used_mb: Math.round((m.heapUsed / 1024 / 1024) * 10) / 10,
    heap_total_mb: Math.round((m.heapTotal / 1024 / 1024) * 10) / 10,
    external_mb: Math.round((m.external / 1024 / 1024) * 10) / 10,
    uptime_ms: Math.round(process.uptime() * 1000),
  };
}

export async function measure(fn) {
  const before = resourceSnapshot();
  const started = process.hrtime.bigint();
  const result = await fn();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const after = resourceSnapshot();
  return {
    result,
    ms: Math.round(elapsedMs * 10) / 10,
    rss_delta_mb: Math.round((after.rss_mb - before.rss_mb) * 10) / 10,
    heap_used_mb: after.heap_used_mb,
  };
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}
