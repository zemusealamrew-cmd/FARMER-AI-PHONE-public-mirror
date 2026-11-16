import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, constants as zlibConstants } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, nowIso, sha256, newId } from '../app/src/util.mjs';
import { payloadHash, signEnvelope } from '../app/src/update.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO, 'data', 'updates', 'pending');

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};

const keyId = flag('key-id');
const issuer = flag('issuer', 'issuer-demo');
const version = flag('version', null);
const counter = Number(flag('counter', 1));
const expiresInDays = Number(flag('expiry-days', 30));
const tamper = flag('tamper', null);
const payloadPath = flag('payload', null);
const outFile = flag('out', null);
const delta = args.includes('--delta');

function signedEntry() {
  return {
    claim_id: 'claim-signed-0001',
    topic_id: 'topic-market-price',
    locale: 'am',
    title: 'የተፈረመ የገበያ ዝማኔ ናሙና',
    answer: 'የG1 ማሳያ፦ የተፈረመ ዝማኔ ሲደርስ አዲሱ መረጃ በእውቀት መዝገብ ውስጥ ይገባል፤ የምንጭና የወቅት ማስረጃ ግን ግዴታ ነው።',
    keywords: ['ዝማኔ', 'ፈቃድ', 'ገበያ', 'ናሙና'],
    source: { kind: 'signed_demo_update', source_id: 'issuer-demo', captured_at: nowIso(), license_scope: 'internal-demo' },
    valid_until: new Date(Date.now() + 7 * 86400000).toISOString(),
    confidence_basis: 'demo_fixture',
    risk_level: 'low',
    geography: 'ET',
  };
}

// ሙሉ ጥቅል (full bundle)፦ አሁን ያለውን እውቀት መዝገብ ሙሉ በሙሉ ይተካል። F-13 የሚያሳየው ይህ በSMS ሊላክ እንደማይችል ነው።
function fullPayload(ver) {
  return {
    kb_version: ver,
    kb_status: 'SIGNED_DEMO_UPDATE',
    mode: 'full_bundle',
    notice_am: 'ይህ በG1 የተፈረመ ማስመሰያ ዝማኔ ነው፤ የተረጋገጠ የጥናት ውጤት አይደለም።',
    notice_om: 'Kun G1 mallattoo haqaa mirkaneessaa miti; yaalii quunnamaa miti.',
    entries: [
      ...JSON.parse(readFileSync(join(REPO, 'data', 'knowledge', 'entries.json'), 'utf8')).entries,
      signedEntry(),
    ],
  };
}

// ትንሽ ዝማኔ (delta)፦ F-13 ምክር — የዋጋ/የአየር ማሳወቂያ በትንሽ ክፍል እንዲላክ ዕቅድ፤
// ሆኖም እዚህ ያለው JSON መልክ እንኳ 14+ SMS ክፍሎችን እንደሚጠይቅ በሂሳብ ተመዝግቧል።
function deltaPayload(ver) {
  return {
    kb_version: ver,
    kb_status: 'SIGNED_DEMO_DELTA',
    mode: 'delta',
    notice_am: 'በG1 የተፈረመ ትንሽ (delta) ዝማኔ፤ የተረጋገጠ ምክር አይደለም።',
    notice_om: 'G1 delta mirkaneessaa; gorsa mirkanaa\'e miti.',
    entries: [signedEntry()],
  };
}

const ver = version ?? `0.2.0-signed.${Date.now()}`;
const payload = payloadPath
  ? JSON.parse(readFileSync(payloadPath, 'utf8'))
  : (delta ? deltaPayload(ver) : fullPayload(ver));
const priv = readFileSync(join(REPO, 'data', 'updates', 'private', `${keyId}.pem`), 'utf8');

const envelope = {
  update_id: newId('upd'),
  issuer_id: issuer,
  key_id: keyId,
  version: ver,
  monotonic_counter: counter,
  payload,
  payload_hash: payloadHash(payload),
  expiry: new Date(Date.now() + expiresInDays * 86400000).toISOString(),
};
envelope.signature = signEnvelope(envelope, priv);

if (tamper === 'payload') envelope.payload.entries[0].answer = 'የተሳሳተ ይዘት፦ የዋጋ ማጭበርበሪያ (silent content change)።';
if (tamper === 'hash') envelope.payload_hash = `sha256:${sha256('tampered')}`;
if (tamper === 'signature') envelope.signature = signEnvelope({ ...envelope, monotonic_counter: counter + 999 }, priv);
if (tamper === 'counter') envelope.monotonic_counter = 0;
if (tamper === 'expiry') envelope.expiry = new Date(Date.now() - 86400000).toISOString();
if (tamper === 'key') envelope.key_id = 'key-not-in-registry';

mkdirSync(OUT_DIR, { recursive: true });
const target = outFile ?? join(OUT_DIR, `${envelope.update_id}.json`);
writeFileSync(target, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');

const bytes = Buffer.byteLength(canonicalJson(envelope), 'utf8');

// F-13 የSMS ስሌት — የተገመተ ቁጥር አይደለም፤ እዚህ ላይ በእውነት የተጠቆመ (deflate level 9) ውጤት ነው።
// አንድ SMS = 140 octet፤ አማርኛ UCS-2 ስለሚጠይቅ 70 ፊደል/70×2=140 byte በአንድ ክፍል።
const envelopeJson = canonicalJson(envelope);
const ucs2Chars = [...envelopeJson].length;
const deflated = deflateSync(Buffer.from(envelopeJson, 'utf8'), { level: 9 });
// ለማስተላለፍ በቂ የሆነ ASCII ቅርጽ (base64) ስለሆነ 4/3 ማራዘሚያ + የክፍል ራስ (header) ግምት
const b64 = Buffer.from(deflated).toString('base64');
const SEG = 70;
const HEADER_BYTES = 48;

console.log(JSON.stringify({
  ok: true,
  path: target,
  update_id: envelope.update_id,
  version: envelope.version,
  monotonic_counter: envelope.monotonic_counter,
  mode: payloadPath ? 'custom' : (delta ? 'delta' : 'full_bundle'),
  tampered: tamper,
  bytes,
  sms_capacity_estimate: {
    note: 'G1 የሂሳብ ማስመሰያ ግምት፤ እውነተኛ የኦፕሬተር A2P አቅምና ዋጋ UNKNOWN ነው (F-13)',
    method: 'node:zlib deflateSync(level 9) + base64; 70 UCS-2 ቁምፊ በክፍል',
    ucs2_chars_per_segment: SEG,
    total_bytes: bytes,
    total_ucs2_chars: ucs2Chars,
    segments_if_plain_ucs2: Math.ceil(ucs2Chars / SEG),
    deflated_bytes: deflated.length,
    base64_chars: b64.length,
    segments_if_deflate_base64: Math.ceil((b64.length + HEADER_BYTES) / SEG),
    conclusion: Math.ceil((b64.length + HEADER_BYTES) / SEG) <= 3
      ? 'በSMS ሊላክ ይችላል (≤3 ክፍሎች)'
      : 'በSMS ሊላክ አይችልም — በmicroSD/በአገልግሎት ማዕከል ዝማኔ ያስፈልጋል',
  },
}, null, 2));
