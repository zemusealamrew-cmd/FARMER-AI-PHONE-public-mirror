// F-20 / F-19፦ ወደ git የሚገቡ ተደጋጋሚ የሙከራ ናሙናዎች (fixtures) + የሚጠበቅ ውጤት መዝገብ።
// እነዚህ ናሙናዎች የተፈረሙ ሲሆን የG1 ዴሞ ቁልፍ (data/updates/private/) ብቻ ይጠቀማሉ፤
// በምንም እውነተኛ ዝማኔ ላይ የፊርማ ሥልጣን የላቸውም።
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, nowIso, sha256 } from '../app/src/util.mjs';
import { payloadHash, signEnvelope } from '../app/src/update.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'tests', 'fixtures', 'updates');
const KEYS = join(REPO, 'data', 'updates', 'keys.json');
const KB = join(REPO, 'data', 'knowledge', 'entries.json');

// የተረጋገገ clock፦ ናሙናዎቹ ከ30 ቀን በኋላም በተመሳሳይ ውጤት እንዲፈተኑ።
const CLOCK = '2026-11-04T15:00:00.000Z';
const KEY_ID = process.argv[2] ?? 'key-2026-11-04-1';

if (!existsSync(KEYS)) throw new Error('የቁልፍ መዝገብ የለም — በመጀመሪያ ይፍጠሩ፦ node tools/make-keys.mjs generate');
const registry = JSON.parse(readFileSync(KEYS, 'utf8'));
const issuerId = Object.keys(registry.issuers)[0];
const key = registry.issuers[issuerId].keys.find((k) => k.key_id === KEY_ID);
if (!key) throw new Error(`ቁልፍ አልተገኘም፦ ${KEY_ID}`);

const baseEntries = JSON.parse(readFileSync(KB, 'utf8')).entries;

function entry(claimId, title, answer, extra = {}) {
  return {
    claim_id: claimId,
    topic_id: 'market_price',
    locale: 'am',
    title,
    answer,
    answer_short: answer.slice(0, 60),
    keywords: ['ዋጋ', 'ገበያ'],
    requires_expert: false,
    source: {
      kind: 'signed_demo_update',
      id: 'issuer-demo',
      title: 'የG1 የተፈረመ ናሙና ዝማኔ',
      captured_at: CLOCK,
      license_scope: 'internal-demo',
    },
    valid_until: '2026-11-11T15:00:00.000Z',
    confidence_basis: 'demo_fixture',
    conflict_state: 'none',
    risk_level: 'low',
    geography: 'ET',
    ...extra,
  };
}

function privFor(id) {
  const p = join(REPO, 'data', 'updates', 'private', `${id}.pem`);
  if (!existsSync(p)) throw new Error(`የግል ቁልፍ የለም፦ ${p}`);
  return readFileSync(p, 'utf8');
}

function envelope({ version, counter, mode, entries, keyId = KEY_ID, issuer = issuerId, expiry = '2026-12-04T15:00:00.000Z', updateId }) {
  const payload = {
    kb_version: version,
    kb_status: 'SIGNED_FIXTURE',
    mode,
    notice_am: 'ይህ የG1 የሙከራ ናሙና ነው፤ የተረጋገጠ ምክር አይደለም።',
    notice_om: 'Kun yaalii G1 ti; gorsa mirkanaa\'e miti.',
    entries,
  };
  const env = {
    update_id: updateId ?? `upd-fixture-${version}`,
    issuer_id: issuer,
    key_id: keyId,
    version,
    monotonic_counter: counter,
    payload,
    payload_hash: payloadHash(payload),
    expiry,
  };
  env.signature = signEnvelope(env, privFor(keyId));
  return env;
}

const cases = [];

function add(name, expectCode, expectOk, env, note) {
  cases.push({ file: `${name}.json`, expect_ok: expectOk, expect_code: expectCode, note, envelope: env });
}

// 1) ትክክለኛ ትንሽ ዝማኔ — መቀበል አለበት
add(
  'valid-delta',
  'VERIFIED',
  true,
  envelope({ version: '1.0.1-delta', counter: 1, mode: 'delta', entries: [entry('claim-fixture-teff-price', 'የነጭ ሽንፈር ዋጋ ናሙና', 'የማሳያ ዋጋ፦ ኪሎ 14,500 ብር (2026-11-04)። ይህ ቁጥር የተረጋገጠ አይደለም።')] }),
  'ተገቢ ዝማኔ፤ delta ስለሆነ ቀድሞ ያለውን መዝገብ አያጠፋም።',
);

// 2) ሙሉ ጥቅል — መቀበል አለበት፣ F-13 የSMS አቅም ለማሳየት
add(
  'valid-full-bundle',
  'VERIFIED',
  true,
  envelope({ version: '1.0.2-full', counter: 2, mode: 'full_bundle', entries: [...baseEntries, entry('claim-fixture-added', 'የተጨመረ ናሙና መረጃ', 'የማሳያ ተጨማሪ መረጃ።')] }),
  'ሙሉ ጥቅል፤ በSMS ሊላክ አይችልም (F-13)።',
);

// 3) ይዘት በጥቁር መቀየር (silent content change) — hash ልዩነት ግዴታ ይከላከላል
{
  const env = envelope({ version: '1.0.3-tamper-payload', counter: 3, mode: 'delta', entries: [entry('claim-fixture-tampered', 'የነጭ ሽንፈር ዋጋ', 'የተሳሳተ ዋጋ፦ ኪሎ 2,000 ብር — ማጭበርበሪያ ናሙና።')] });
  env.payload.entries[0].answer = 'የተሳሳተ ዋጋ፦ ኪሎ 2,000 ብር — ማጭበርበሪያ ናሙና (በተሰረጠ)።';
  add('tamper-payload', 'PAYLOAD_HASH_MISMATCH', false, env, 'ፊርማው ከሚገናኙ መስኮች ብቻ ስለሆነ የpayload ለውጥ በhash ይታወቃል።');
}

// 4) payload_hash ራሱ መቀየር
{
  const env = envelope({ version: '1.0.4-tamper-hash', counter: 4, mode: 'delta', entries: [entry('claim-fixture-hash', 'ናሙና', 'መልስ')] });
  env.payload_hash = `sha256:${sha256('attacker-payload')}`;
  add('tamper-payload-hash', 'PAYLOAD_HASH_MISMATCH', false, env, 'የጠቃሚ ጥያቄ፦ ሃሽ ቢቀየር ፊርማው አያልፍም።');
}

// 5) ፊርማ መቀየር
{
  const env = envelope({ version: '1.0.5-tamper-sig', counter: 5, mode: 'delta', entries: [entry('claim-fixture-sig', 'ናሙና', 'መልስ')] });
  env.signature = Buffer.from('a'.repeat(64)).toString('base64');
  add('tamper-signature', 'SIGNATURE_INVALID', false, env, 'ያልሆነ ፊርማ ግዴታ ውድቀት።');
}

// 6) በተሰረዘ ቁልፍ የተፈረመ — ፊርማው ራሱ ትክክል ነው፤ ስረዛው ብቻ ይከለክለዋል (KEY_REVOKED)
{
  const env = envelope({
    version: '1.0.6-revoked',
    counter: 6,
    mode: 'delta',
    keyId: 'key-revoked-demo',
    entries: [entry('claim-fixture-revoked', 'ናሙና', 'በተሰረዘ ቁልፍ የተፈረመ ናሙና።')],
  });
  add('tamper-revoked-key', 'KEY_REVOKED', false, env, 'ስረዛ በመዝገብ ስባረው ብቻ ይታወቃል፤ የፊርማ ማረጋገጫ ብቻውን አይበቃም (F-15)።');
}

// 7) ያለፈ ጊዜ (expired envelope)
{
  const env = envelope({ version: '1.0.7-expired', counter: 7, mode: 'delta', expiry: '2026-10-01T15:00:00.000Z', entries: [entry('claim-fixture-expired', 'ናሙና', 'መልስ')] });
  add('tamper-expiry', 'ENVELOPE_EXPIRED', false, env, 'የG1 ውሎች፦ ጊዜው ያለፈ ዝማኔ አይተገበርም።');
}

// 8) ወደ ኋላ የሄደ counter (replay/rollback)
{
  const env = envelope({ version: '1.0.8-replay', counter: 0, mode: 'delta', entries: [entry('claim-fixture-replay', 'ናሙና', 'መልስ')] });
  add('tamper-counter-backwards', 'MALFORMED_ENVELOPE', false, env, 'monotonic_counter ≥1 መሆን አለበት፤ replay በተጠቃሚ በላይ ከተመዘገበ counter ይከሰተላል።');
}

// 9) ያልተመዘገበ አወጣጭ (unknown issuer)
{
  const env = envelope({ version: '1.0.9-issuer', counter: 9, mode: 'delta', issuer: 'issuer-attacker', entries: [entry('claim-fixture-issuer', 'ናሙና', 'መልስ')] });
  add('tamper-unknown-issuer', 'UNKNOWN_ISSUER', false, env, 'ሥርዓቱ የሚቀበለው በመዝገብ ውስጥ ባሉ አዘዝ ተቋማት ብቻ ነው።');
}

// 10) ያልተገለጸ mode — አዲስ ዓይነት በዝግጅት ሳይጸድቅ አይቀበልም
{
  const env = envelope({ version: '1.0.10-mode', counter: 10, mode: 'delta', entries: [entry('claim-fixture-mode', 'ናሙና', 'መልስ')] });
  env.payload.mode = 'sideload';
  env.payload_hash = payloadHash(env.payload);
  env.signature = signEnvelope(env, privFor(KEY_ID));
  add('unknown-mode', 'PAYLOAD_MODE_UNKNOWN', false, env, 'አዲስ የዝማኔ ዓይነት በG0 ያለ ፈቃድ አይፈቀድም።');
}

// 11) ደህንነት ማስተካከያ ያልሆነ (high risk) ይዘት — የማረጋገጫ ደረጃ ማሳያ
{
  const env = envelope({
    version: '1.0.11-risk',
    counter: 11,
    mode: 'delta',
    entries: [{ ...entry('claim-fixture-pesticide', 'የኬሚካል መጠን ማሳያ', 'ከ25 እጥፍ በላይ ኬሚካል ይቀላቅሉ — አደገኛ ናሙና።', { risk_level: 'high' }) }],
  });
  add('risk-high-content', 'VERIFIED', true, env, 'የፊርማ ማረጋገጫ ያልፋል፣ ነገር ግን የይዘት ደህንነት በሌላ ንብረት (safety gate) ይከለከላል፤ F-17 ለዚህ ነው።');
}

// 12) ተከታይ (v2) የተሻሻለ መረጃ — በተመሳሳይ claim_id ላይ ስለሆነ delta ቦታውን ብቻ ይተካል።
//     ይህ ናሙና ለሙከራ በተራ የተፈረመ ስለሆነ "በእጅ hash በመቀየር መሙከራ" አያስፈልግም (F-20)።
{
  const target = baseEntries.find((e) => e.claim_id === 'KB-AM-005');
  if (!target) throw new Error('KB-AM-005 በመዝገቡ ውስጥ አልተገኘም — ናሙናውን እንደገና ያዘጋጁ');
  const env = envelope({
    version: '1.0.12-delta-replace',
    counter: 12,
    mode: 'delta',
    updateId: 'upd-fixture-replace',
    entries: [
      entry('KB-AM-005', 'የገበያ ዋጋ (የተሻሻለ ናሙና)', 'የተሻሻለ የG1 ማሳያ ዋጋ፦ ዛሬውን ዋጋ ከገበያ ያረጋግጡ። ይህ ናሙና የKB-AM-005ን ቦታ ብቻ ይተካል።', {
        risk_level: target.risk_level,
        requires_expert: target.requires_expert,
      }),
    ],
  });
  add('valid-delta-replace', 'VERIFIED', true, env, 'delta በሌለ አዲስ መዝገብ አይፈጥርም፤ ያለውን claim_id በቦታው ይተካል (F-15/R-19)።');
}

mkdirSync(OUT, { recursive: true });for (const c of cases) {
  writeFileSync(join(OUT, c.file), `${JSON.stringify(c.envelope, null, 2)}\n`, 'utf8');
}

const manifest = {
  fixture_set: 'g1-signed-update-fixtures',
  fixture_version: '1.0.0',
  generated_at: nowIso(),
  pinned_clock: CLOCK,
  note: 'እነዚህ የG1 የሙከራ ናሙናዎች ናቸው። ቁልፎቻቸው ምንም የምርት ሥልጣን የላቸውም። ሙከራው CLOCKን በመጠቀም ጊዜውን ይቆጣጣል።',
  requirement_ids: ['R-14', 'R-18', 'R-19', 'RU-12', 'F-15', 'F-19', 'F-20', 'NR-05'],
  key_id: KEY_ID,
  issuer_id: issuerId,
  algorithm: 'ed25519',
  canonical_hash_algorithm: 'sha256 over canonical JSON of payload',
  cases: cases.map((c) => ({
    file: c.file,
    expect_ok: c.expect_ok,
    expect_code: c.expect_code,
    sha256_file: sha256(readFileSync(join(OUT, c.file))),
    note: c.note,
  })),
};
writeFileSync(join(OUT, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: true,
  out_dir: OUT,
  cases: cases.length,
  pinned_clock: CLOCK,
  canonical_preview: canonicalJson({ a: 1, b: [2, 3] }),
}, null, 2));
