import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, nowIso, readJson, sha256, newId } from './util.mjs';

const SIGNED_FIELDS = [
  'issuer_id',
  'key_id',
  'version',
  'monotonic_counter',
  'payload_hash',
  'expiry',
];

export function signedBytes(envelope) {
  const core = {};
  for (const field of SIGNED_FIELDS) core[field] = envelope[field];
  return Buffer.from(canonicalJson(core), 'utf8');
}

export function signEnvelope(envelope, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  return cryptoSign(null, signedBytes(envelope), key).toString('base64');
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') return 'PAYLOAD_MISSING';
  if (typeof payload.kb_version !== 'string' || !payload.kb_version) return 'PAYLOAD_VERSION_MISSING';
  if (!Array.isArray(payload.entries) || payload.entries.length === 0) return 'PAYLOAD_ENTRIES_MISSING';
  const mode = payload.mode ?? 'full_bundle';
  if (mode !== 'full_bundle' && mode !== 'delta') return 'PAYLOAD_MODE_UNKNOWN';
  if (new Set(payload.entries.map((e) => e.claim_id)).size !== payload.entries.length) {
    return 'PAYLOAD_DUPLICATE_CLAIM_ID';
  }
  for (const entry of payload.entries) {
    if (typeof entry?.claim_id !== 'string' || !entry.claim_id) return 'PAYLOAD_ENTRY_CLAIM_ID_MISSING';
    if (typeof entry?.topic_id !== 'string' || !entry.topic_id) return 'PAYLOAD_ENTRY_TOPIC_MISSING';
    if (typeof entry?.locale !== 'string' || !entry.locale) return 'PAYLOAD_ENTRY_LOCALE_MISSING';
    if (typeof entry?.title !== 'string' || !entry.title) return 'PAYLOAD_ENTRY_TITLE_MISSING';
    if (typeof entry?.answer !== 'string' || !entry.answer) return 'PAYLOAD_ENTRY_ANSWER_MISSING';
    if (!Array.isArray(entry?.keywords)) return 'PAYLOAD_ENTRY_KEYWORDS_MISSING';
    if (typeof entry?.source?.kind !== 'string') return 'PAYLOAD_ENTRY_SOURCE_MISSING';
    if (typeof entry?.source?.captured_at !== 'string') return 'PAYLOAD_ENTRY_SOURCE_TIME_MISSING';
  }
  return null;
}

// እውቀት መዝገቡ ራሱ claim_id በመለያ ብቻ ስለሚገለጸ፣ delta ሲተገበር ቀድሞ ያለውን ይዞታ ማጥፋት አይቀየርም (F-15/NR-04)።
function mergeEntries(currentEntries, deltaEntries) {
  const index = new Map(currentEntries.map((e, i) => [e.claim_id, i]));
  const next = [...currentEntries];
  let replaced = 0;
  let added = 0;
  for (const entry of deltaEntries) {
    const at = index.get(entry.claim_id);
    if (at === undefined) {
      next.push(entry);
      index.set(entry.claim_id, next.length - 1);
      added += 1;
    } else {
      next[at] = entry;
      replaced += 1;
    }
  }
  return { next, replaced, added };
}

export class UpdateService {
  constructor({ keysPath, statePath, kbPath, backupDir, log = () => {} } = {}) {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const dataDir = join(root, 'data', 'updates');
    this.keysPath = keysPath ?? join(dataDir, 'keys.json');
    this.statePath = statePath ?? join(dataDir, 'state.json');
    this.kbPath = kbPath ?? join(root, 'data', 'knowledge', 'entries.json');
    this.backupDir = backupDir ?? join(dataDir, 'backups');
    this.log = log;
  }

  keys() {
    return readJson(this.keysPath);
  }

  state() {
    if (!existsSync(this.statePath)) {
      return { installed_version: null, monotonic_counter: 0, applied: [], last_backup: null };
    }
    return readJson(this.statePath);
  }

  _saveState(state) {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, this.statePath);
  }

  verify(envelope, { at = new Date() } = {}) {
    const fail = (code, detail = null) => ({ ok: false, code, detail });
    if (!envelope || typeof envelope !== 'object') return fail('MALFORMED_ENVELOPE');
    for (const field of [...SIGNED_FIELDS, 'payload', 'signature']) {
      if (envelope[field] === undefined || envelope[field] === null) {
        return fail('MALFORMED_ENVELOPE', field);
      }
    }
    if (typeof envelope.version !== 'string' || !envelope.version) return fail('MALFORMED_ENVELOPE', 'version');
    if (!Number.isInteger(envelope.monotonic_counter) || envelope.monotonic_counter < 1) {
      return fail('MALFORMED_ENVELOPE', 'monotonic_counter');
    }

    const registry = this.keys();
    if (!registry.issuers?.[envelope.issuer_id]) return fail('UNKNOWN_ISSUER', envelope.issuer_id);
    const issuer = registry.issuers[envelope.issuer_id];
    const key = issuer.keys?.find((k) => k.key_id === envelope.key_id);
    if (!key) return fail('UNKNOWN_KEY', envelope.key_id);
    if (key.status === 'revoked') return fail('KEY_REVOKED', key.revoked_reason ?? null);

    const now = at.getTime();
    if (key.not_before && new Date(key.not_before).getTime() > now) return fail('KEY_NOT_YET_VALID');
    if (key.not_after && new Date(key.not_after).getTime() <= now) return fail('KEY_EXPIRED');

    if (!envelope.expiry || new Date(envelope.expiry).getTime() <= now) return fail('ENVELOPE_EXPIRED', envelope.expiry);

    const computed = `sha256:${sha256(canonicalJson(envelope.payload))}`;
    if (envelope.payload_hash !== computed) return fail('PAYLOAD_HASH_MISMATCH', { expected: computed });

    let signatureOk = false;
    try {
      const publicKey = createPublicKey(key.public_key_pem);
      signatureOk = cryptoVerify(
        null,
        signedBytes(envelope),
        publicKey,
        Buffer.from(String(envelope.signature), 'base64'),
      );
    } catch {
      return fail('SIGNATURE_INVALID', 'malformed_key_or_signature');
    }
    if (!signatureOk) return fail('SIGNATURE_INVALID');

    const payloadError = validatePayload(envelope.payload);
    if (payloadError) return fail(payloadError);

    const state = this.state();
    const sameUpdate = state.applied.find((a) => a.update_id === envelope.update_id);
    if (sameUpdate && sameUpdate.payload_hash === envelope.payload_hash) {
      return fail('REPLAY_DUPLICATE_ID', envelope.update_id);
    }
    if (envelope.monotonic_counter <= (state.monotonic_counter ?? 0)) {
      return fail('REPLAY_OLDER_COUNTER', {
        presented: envelope.monotonic_counter,
        installed: state.monotonic_counter ?? 0,
      });
    }
    if (state.installed_version && compareVersions(envelope.version, state.installed_version) <= 0) {
      return fail('VERSION_NOT_INCREASING', { presented: envelope.version, installed: state.installed_version });
    }

    return { ok: true, code: 'VERIFIED', issuer, key, payload_hash: computed };
  }

  apply(envelope, { at = new Date() } = {}) {
    const check = this.verify(envelope, { at });
    if (!check.ok) {
      this.log({ event: 'update_rejected', code: check.code, update_id: envelope?.update_id ?? null, detail: check.detail ?? null, at: nowIso() });
      return { applied: false, ...check };
    }

    const state = this.state();
    mkdirSync(this.backupDir, { recursive: true });
    const backupPath = `${this.backupDir}/entries-${state.installed_version ?? 'initial'}-${Date.now()}.json`;
    copyFileSync(this.kbPath, backupPath);

    const stagedPath = `${this.kbPath}.staged-${newId('upd')}`;
    try {
      const notice = envelope.payload.kb_notice ?? {};
      const mode = envelope.payload.mode ?? 'full_bundle';
      let merge = null;
      let entries;
      if (mode === 'delta') {
        const current = readJson(this.kbPath).entries ?? [];
        const merged = mergeEntries(current, envelope.payload.entries);
        entries = merged.next;
        merge = { replaced: merged.replaced, added: merged.added, kept: current.length };
      } else {
        entries = envelope.payload.entries;
      }
      const nextKb = {
        kb_version: envelope.payload.kb_version,
        kb_status: envelope.payload.kb_status ?? 'SIGNED_UPDATE',
        notice_am: envelope.payload.notice_am ?? notice.am ?? 'በተፈረመ ዝማኔ የተሻሻለ። ይዘቱ ገና ማረጋገጫ ይጠይቃል።',
        notice_om: envelope.payload.notice_om ?? notice.om ?? 'Kun dargaggoo mirkanaa\'een haaromfame; contentni ammoo mirkaneessa gaafata.',
        update_id: envelope.update_id,
        applied_at: nowIso(),
        entries,
      };
      writeFileSync(stagedPath, JSON.stringify(nextKb, null, 2), 'utf8');
      const written = readJson(stagedPath);
      if (canonicalJson(written) !== canonicalJson(nextKb)) throw new Error('STAGED_READBACK_MISMATCH');
      const priorPath = `${this.kbPath}.old-${Date.now()}`;
      renameSync(this.kbPath, priorPath);
      renameSync(stagedPath, this.kbPath);
      // ሽግግሩ ሲጠናቀቅ የቀድሞው ቅጂ ያልፋል፤ ዘወትር መቆራረጥ በbackups/ ስለሚገኝ ቅጂዎች አይከማቹም (F-07)
      rmSync(priorPath, { force: true });
      check.merged = merge;
      check.entry_count = entries.length;
    } catch (error) {
      if (existsSync(backupPath)) copyFileSync(backupPath, this.kbPath);
      rmSync(stagedPath, { force: true });
      this.log({ event: 'update_apply_failed', code: 'STAGE_OR_COMMIT_FAILED', error: String(error.message), at: nowIso() });
      return { applied: false, code: 'STAGE_OR_COMMIT_FAILED', detail: String(error.message), rolled_back: true };
    }

    const record = {
      update_id: envelope.update_id ?? newId('upd'),
      issuer_id: envelope.issuer_id,
      key_id: envelope.key_id,
      version: envelope.version,
      mode: envelope.payload.mode ?? 'full_bundle',
      merge: check.merged ?? null,
      entry_count: check.entry_count,
      monotonic_counter: envelope.monotonic_counter,
      payload_hash: check.payload_hash,
      applied_at: nowIso(),
      backup_path: backupPath,
    };
    const nextState = {
      installed_version: envelope.version,
      monotonic_counter: envelope.monotonic_counter,
      applied: [...state.applied, record],
      last_backup: backupPath,
    };
    this._saveState(nextState);
    this.log({ event: 'update_applied', ...record });
    return { applied: true, code: 'APPLIED', record, state: nextState };
  }

  rollback(updateId, { reason = 'owner_request' } = {}) {
    const state = this.state();
    const record = state.applied.find((a) => a.update_id === updateId) ?? state.applied.at(-1);
    if (!record || !existsSync(record.backup_path)) {
      return { rolled_back: false, code: 'NO_BACKUP_AVAILABLE' };
    }
    copyFileSync(record.backup_path, this.kbPath);
    const restored = readJson(record.backup_path);
    const remaining = state.applied.filter((a) => a.update_id !== record.update_id);
    this._saveState({
      installed_version: remaining.at(-1)?.version ?? null,
      monotonic_counter: state.monotonic_counter,
      applied: remaining,
      last_backup: record.backup_path,
    });
    const event = { event: 'update_rolled_back', update_id: record.update_id, restored_version: restored.kb_version, reason, at: nowIso() };
    this.log(event);
    return { rolled_back: true, code: 'ROLLED_BACK', restored_version: restored.kb_version, event };
  }
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((p) => (Number.isFinite(Number(p)) ? Number(p) : p));
  const pb = String(b).split(/[.-]/).map((p) => (Number.isFinite(Number(p)) ? Number(p) : p));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x > y ? 1 : -1;
    } else {
      const sx = String(x);
      const sy = String(y);
      if (sx !== sy) return sx > sy ? 1 : -1;
    }
  }
  return 0;
}

export function payloadHash(payload) {
  return `sha256:${sha256(canonicalJson(payload))}`;
}

export function readEnvelope(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
