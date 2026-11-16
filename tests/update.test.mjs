import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpdateService, payloadHash, signedBytes } from '../app/src/update.mjs';
import { canonicalJson, sha256 } from '../app/src/util.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(REPO, 'tests', 'fixtures', 'updates');
const MANIFEST = JSON.parse(readFileSync(join(FIX, 'MANIFEST.json'), 'utf8'));
const CLOCK = new Date(MANIFEST.pinned_clock);
const BASE_KB = join(REPO, 'data', 'knowledge', 'entries.json');
const BASE_COUNT = JSON.parse(readFileSync(BASE_KB, 'utf8')).entries.length;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'g1-update-'));
  const kbPath = join(dir, 'entries.json');
  copyFileSync(BASE_KB, kbPath);
  const events = [];
  const svc = new UpdateService({
    keysPath: join(REPO, 'data', 'updates', 'keys.json'),
    statePath: join(dir, 'state.json'),
    kbPath,
    backupDir: join(dir, 'backups'),
    log: (e) => events.push(e),
  });
  return { svc, dir, kbPath, events };
}

test('F-15 / F-19 / F-20፦ 12ቱ የተፈረሙ ናሙናዎች በሁሉም የሚጠበቁ ውጤቶች ያልፋሉ', () => {
  assert.equal(MANIFEST.cases.length, 12, 'የናሙና ብዛት ከመዝገቡ ጋር ይጣጣማል');
  for (const c of MANIFEST.cases) {
    const { svc } = sandbox();
    const env = JSON.parse(readFileSync(join(FIX, c.file), 'utf8'));
    const r = svc.verify(env, { at: CLOCK });
    assert.equal(r.ok, c.expect_ok, `${c.file} → ok`);
    assert.equal(r.code, c.expect_code, `${c.file} → code`);
  }
});

test('F-15 / NR-05፦ በተሰረዘ ቁልፍ የተፈረመ ዝማኔ ይከለከላል', () => {
  const { svc } = sandbox();
  const env = JSON.parse(readFileSync(join(FIX, 'tamper-revoked-key.json'), 'utf8'));
  const r = svc.verify(env, { at: CLOCK });
  assert.equal(r.code, 'KEY_REVOKED');
  assert.ok(r.detail.includes('G1'), 'የስረዛ ምክንያቱ ይመዘገባል');
});

test('F-15 / R-14፦ ለውጥ የተደረገበት payload (silent tamper) በሃሽ ይከላከላል', () => {
  const { svc } = sandbox();
  const env = JSON.parse(readFileSync(join(FIX, 'tamper-payload.json'), 'utf8'));
  const r = svc.verify(env, { at: CLOCK });
  assert.equal(r.code, 'PAYLOAD_HASH_MISMATCH');
});

test('F-15 / RU-12፦ ወደ ኋላ የሄደ counter (replay/rollback attack) ይከለከላል', () => {
  const { svc, kbPath } = sandbox();
  const good = JSON.parse(readFileSync(join(FIX, 'valid-delta.json'), 'utf8'));
  assert.equal(svc.apply(good, { at: CLOCK }).code, 'APPLIED');
  const replay = { ...good, update_id: 'upd-different-id', monotonic_counter: 1 };
  replay.payload_hash = payloadHash(replay.payload);
  const r = svc.verify(replay, { at: CLOCK });
  assert.equal(r.code, 'REPLAY_OLDER_COUNTER');
  assert.equal(JSON.parse(readFileSync(kbPath, 'utf8')).entries.length, BASE_COUNT + 1, 'ውጤቱ አልተጠቃም');
});

test('F-15 / R-18፦ ድጋሚ መተግበር (idempotence) — አንድ update_id ሁለት ጊዜ አይተገበርም', () => {
  const { svc } = sandbox();
  const good = JSON.parse(readFileSync(join(FIX, 'valid-delta.json'), 'utf8'));
  assert.equal(svc.apply(good, { at: CLOCK }).code, 'APPLIED');
  const again = svc.verify(good, { at: CLOCK });
  assert.equal(again.code, 'REPLAY_DUPLICATE_ID');
});

test('F-09 / R-19፦ delta ዝማኔ ቀድሞ የነበረውን እውቀት አያጥፋም (no data loss)', () => {
  const { svc, kbPath } = sandbox();
  const env = JSON.parse(readFileSync(join(FIX, 'valid-delta.json'), 'utf8'));
  const applied = svc.apply(env, { at: CLOCK });
  assert.equal(applied.code, 'APPLIED');
  const kb = JSON.parse(readFileSync(kbPath, 'utf8'));
  assert.equal(kb.entries.length, BASE_COUNT + 1, 'አዲሱ መረጃ ተጨምሮ ተገኝቷል');
  assert.ok(kb.entries.some((e) => e.claim_id === 'KB-AM-001'), 'የቀድሞ መረጃው ተይዟል');
  assert.equal(applied.record.merge.added, 1);
  assert.equal(applied.record.mode, 'delta');
});

test('F-15 / R-19፦ delta በተመሳሳይ claim_id ሲደርስ ቦታውን ይተካል (update in place)', () => {
  const { svc, kbPath } = sandbox();
  const env = JSON.parse(readFileSync(join(FIX, 'valid-delta-replace.json'), 'utf8'));
  const applied = svc.apply(env, { at: CLOCK });
  assert.equal(applied.code, 'APPLIED');
  const kb = JSON.parse(readFileSync(kbPath, 'utf8'));
  assert.equal(kb.entries.length, BASE_COUNT, 'አዲስ መዝገብ አልተጨመረም');
  assert.equal(applied.record.merge.replaced, 1);
  assert.equal(applied.record.merge.added, 0);
  assert.match(kb.entries.find((e) => e.claim_id === 'KB-AM-005').answer, /የተሻሻለ/);
  assert.ok(kb.entries.some((e) => e.claim_id === 'KB-AM-001'), 'ሌሎች መረጃዎች አልተነኩም');
});

test('F-15 / R-19፦ ማረጋገጫውን ያልተከተለ payload ለውጥ ፊርማ ይከለክለዋል (unsigned edit rejected)', () => {
  const { svc } = sandbox();
  const env = JSON.parse(readFileSync(join(FIX, 'valid-delta.json'), 'utf8'));
  env.payload.entries[0].claim_id = 'KB-AM-005';
  env.payload_hash = payloadHash(env.payload);
  const r = svc.apply(env, { at: CLOCK });
  assert.equal(r.code, 'SIGNATURE_INVALID', 'ያለእውነተኛ ፊርማ ያለውን መዝገብ መተካት አይቻልም');
});

test('F-15 / R-18፦ ሙሉ ጥቅል መዝገቡን ሙሉ በሙሉ ይተካል', () => {
  const { svc, kbPath } = sandbox();
  const env = JSON.parse(readFileSync(join(FIX, 'valid-full-bundle.json'), 'utf8'));
  const applied = svc.apply(env, { at: CLOCK });
  assert.equal(applied.code, 'APPLIED');
  const kb = JSON.parse(readFileSync(kbPath, 'utf8'));
  assert.equal(kb.entries.length, BASE_COUNT + 1);
  assert.equal(applied.record.mode, 'full_bundle');
  assert.equal(applied.record.merge, null);
});

test('F-07 / NR-05፦ ስኬታማ ዝማኔ የጊዜውን ቅጂና staged ፋይል አያስቀርም (no unbounded copies)', () => {
  const { svc, dir, kbPath } = sandbox();
  assert.equal(svc.apply(JSON.parse(readFileSync(join(FIX, 'valid-delta.json'), 'utf8')), { at: CLOCK }).code, 'APPLIED');
  assert.equal(svc.apply(JSON.parse(readFileSync(join(FIX, 'valid-full-bundle.json'), 'utf8')), { at: CLOCK }).code, 'APPLIED');
  const stray = readdirSync(dir).filter((f) => /entries\.json\.(old|staged)-/.test(f));
  assert.deepEqual(stray, [], 'የተሽገሩ ቅጂዎች መቆየት የለባቸውም — ዕድገት የሌለው ማጠቃቀም (F-07)');
  const backups = readdirSync(join(dir, 'backups'));
  assert.equal(backups.length, 2, 'የዘወትር መቆራረጡ ግን ለመመለሻ ይቆያል');
  assert.ok(existsSync(kbPath), 'የመጨረሻው መዝገብ ቦታው ላይ ነው');
});

test('F-15 / R-18፦ KnowledgeBase ሲንጠቀለል አዲሱ ይዘት ይታያል (reload contract)', async () => {
  const { KnowledgeBase } = await import('../app/src/knowledge.mjs');
  const { svc, kbPath } = sandbox();
  const before = KnowledgeBase.load(kbPath);
  assert.notEqual(before.status, 'SIGNED_FIXTURE');
  svc.apply(JSON.parse(readFileSync(join(FIX, 'valid-delta.json'), 'utf8')), { at: CLOCK });
  const after = new KnowledgeBase(kbPath);
  assert.equal(after.status, 'SIGNED_FIXTURE');
  assert.equal(after.version, '1.0.1-delta');
  assert.notEqual(after.hash, before.hash, 'የይዘት ለውጡ በሃሹ ላይ ግልጽ መታየት አለበት');
  assert.ok(after.entries.some((e) => e.claim_id === 'claim-fixture-teff-price'));
  assert.equal(after.entries.length, BASE_COUNT + 1);
  assert.ok(after.notice.am.includes('ናሙና'), 'የማሳያ ማስታወሻው ከዝማኔ በኋላም ተይዟል');
});

test('F-15 / F-22፦ መተግበሪያው ከተሳሳተ መልክ መመለስ አለበት (atomic rollback)', () => {
  const { svc, kbPath } = sandbox();
  const env = JSON.parse(readFileSync(join(FIX, 'valid-delta.json'), 'utf8'));
  const applied = svc.apply(env, { at: CLOCK });
  assert.equal(applied.code, 'APPLIED');
  const rolled = svc.rollback(env.update_id, { reason: 'test' });
  assert.equal(rolled.code, 'ROLLED_BACK');
  assert.equal(JSON.parse(readFileSync(kbPath, 'utf8')).entries.length, BASE_COUNT, 'ወደ ኋላ መልሶ ተመልሷል');
  const state = svc.state();
  assert.equal(state.installed_version, null);
  assert.ok(state.monotonic_counter >= env.monotonic_counter, 'counter መቀነስ የለበትም (anti-rollback)');
});

test('F-15 / R-14፦ ከጊዜ በኋላ የተላከ ዝማኔ አይተገበርም (expiry enforced)', () => {
  const { svc } = sandbox();
  const env = JSON.parse(readFileSync(join(FIX, 'valid-delta.json'), 'utf8'));
  const late = svc.verify(env, { at: new Date('2027-01-01T00:00:00.000Z') });
  assert.equal(late.code, 'ENVELOPE_EXPIRED');
});

test('F-15 / R-18፦ ማረጋገጫው ያልፈጸመ መልክ አይጽፍም (verify does not mutate)', () => {
  const { svc, kbPath, dir } = sandbox();
  const before = readFileSync(kbPath, 'utf8');
  const env = JSON.parse(readFileSync(join(FIX, 'valid-delta.json'), 'utf8'));
  svc.verify(env, { at: CLOCK });
  assert.equal(readFileSync(kbPath, 'utf8'), before, 'verify ራሱ ፋይል አይቀይርም');
  assert.equal(existsSync(join(dir, 'backups')), false, 'backup የሚፈጠረው በapply ብቻ ነው');
});

test('F-15 / CI-08፦ ፊርማ የሚገናኘው ተጨማሪ መስኮችን አይደለም (signed field set)', () => {
  const env = JSON.parse(readFileSync(join(FIX, 'valid-delta.json'), 'utf8'));
  const bytes = signedBytes(env);
  const parsed = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(parsed).sort(), ['expiry', 'issuer_id', 'key_id', 'monotonic_counter', 'payload_hash', 'version']);
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}', 'የመጠቃለል JSON ቅደም ተከተል አይጣደፍም');
});

test('F-15 / F-13፦ የናሙና ማኒፌስት ራሱ ሃሽ ተጠብቆ ይቆያል (fixture integrity)', () => {
  for (const c of MANIFEST.cases) {
    const buf = readFileSync(join(FIX, c.file));
    assert.equal(sha256(buf), c.sha256_file, `${c.file} ሃሽ ተጠብቋል`);
  }
});
