import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(REPO, 'data', 'updates');
const KEYS = join(DIR, 'keys.json');
const PRIV_DIR = join(DIR, 'private');

const EMPTY = {
  registry_version: '1.0',
  note: 'G1 ዴሞ የፊርማ ቁልፍ መዝገብ። እነዚህ ቁልፎች በምንም ምርት ወይም በእውነተኛ ስልክ ላይ ሥልጣን የላቸውም። (F-15 የቁልፍ አስተዳደር ማስረጃ)',
  issuers: {},
};

function load() {
  if (!existsSync(KEYS)) return structuredClone(EMPTY);
  return JSON.parse(readFileSync(KEYS, 'utf8'));
}

function save(registry) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(KEYS, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

const args = process.argv.slice(2);
const cmd = args[0] ?? 'generate';
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};

if (cmd === 'list') {
  const registry = load();
  const rows = Object.entries(registry.issuers).flatMap(([issuer, meta]) =>
    meta.keys.map((k) => ({ issuer, key_id: k.key_id, status: k.status, not_after: k.not_after ?? 'no-expiry' })));
  console.log(JSON.stringify({ keys: rows, registry_path: KEYS }, null, 2));
} else if (cmd === 'generate' || cmd === 'rotate') {
  const issuer = flag('issuer', 'issuer-demo');
  const keyId = flag('key-id', `key-${new Date().toISOString().slice(0, 10)}-1`);
  const validDays = Number(flag('valid-days', 365));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const registry = load();
  registry.issuers[issuer] ??= { name: issuer, keys: [] };
  if (cmd === 'rotate') {
    for (const k of registry.issuers[issuer].keys) {
      if (k.status === 'active') k.status = 'rotated';
    }
  }
  if (registry.issuers[issuer].keys.some((k) => k.key_id === keyId)) {
    console.error(`KEY_ID_ALREADY_PRESENT:${keyId}`);
    process.exit(2);
  }
  const now = new Date();
  registry.issuers[issuer].keys.push({
    key_id: keyId,
    algorithm: 'ed25519',
    public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    status: 'active',
    issued_at: now.toISOString(),
    not_before: now.toISOString(),
    not_after: new Date(now.getTime() + validDays * 86400000).toISOString(),
    revoked_at: null,
    revoked_reason: null,
  });
  save(registry);
  mkdirSync(PRIV_DIR, { recursive: true });
  const privPath = join(PRIV_DIR, `${keyId}.pem`);
  writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    issuer,
    key_id: keyId,
    registry: KEYS,
    private_key: privPath,
    private_key_gitignored: true,
    warning: 'የግል ቁልፉ ወደ git አይገባም፤ በG2 ላይ HSM/ኦፍላይን ሥርዓተ ቁልፍ ይተካዋል (NR-05)።',
  }, null, 2));
} else if (cmd === 'revoke') {
  const issuer = flag('issuer', 'issuer-demo');
  const keyId = flag('key-id');
  const reason = flag('reason', 'compromise');
  if (!keyId) {
    console.error('USE: node tools/make-keys.mjs revoke --key-id ID [--reason TEXT]');
    process.exit(2);
  }
  const registry = load();
  const key = registry.issuers[issuer]?.keys.find((k) => k.key_id === keyId);
  if (!key) {
    console.error(`UNKNOWN_KEY:${keyId}`);
    process.exit(2);
  }
  key.status = 'revoked';
  key.revoked_at = new Date().toISOString();
  key.revoked_reason = reason;
  save(registry);
  console.log(JSON.stringify({ ok: true, revoked: keyId, reason, note: 'በስልኩ ውስጥ ስረዛው የሚደርሰው በተፈቀደ መስመር ብቻ፤ ኦፍላይን ስረዛ ጊዜ የማዳረስ ድንበር አለ (F-15)።' }, null, 2));
} else {
  console.error('USE: node tools/make-keys.mjs [generate|rotate|revoke|list] [--issuer ID] [--key-id ID] [--valid-days N] [--reason TEXT]');
  process.exit(2);
}
