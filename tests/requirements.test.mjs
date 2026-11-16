// F-04 / F-19 / F-25፦ በማከማቻው ያለው አንድ ዋና መዝገብ ከእውነተኛ ሁኔታ ጋር እኩል መሆኑን ያረጋግጣል።
// ጽሑፍ አይጽፍም፤ አንብቦ ብቻ ይነጻጸራል — ስለዚህ በፍተሻ ጊዜ ማከማቻው አይቀየርም።
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const REQ_FILE = join(REPO, 'requirements', 'requirements.yaml');
const SPECS = join(REPO, 'tests', 'specs');
const REQ_FAMILIES = ['R', 'CI', 'LC', 'RU'];

// በtools/build-requirements.mjs የተጻፈው ቅርጸት ቋሚ ስለሆነ ቀላል አንባቢ በቂ ነው
function parseRegistry(text) {
  const entries = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const id = raw.match(/^  - id: (\S+)$/);
    if (id) { cur = { id: id[1], tests: [] }; entries.push(cur); continue; }
    if (!cur) continue;
    const f = raw.match(/^    ([a-z_0-9]+): (.*)$/);
    if (!f) continue;
    const [, key, val] = f;
    if (key === 'family') cur.family = val;
    else if (key === 'coverage') cur.coverage = val;
    else if (key === 'text') cur.text = val.replace(/^"|"$/g, '').replace(/\\"/g, '"');
    else if (key === 'gates') cur.gates = val.match(/G[0-4]/g) ?? [];
    else if (key === 'kind') cur.kind = val;
    else if (key === 'owner_named') cur.ownerNamed = val;
    else if (key === 'blocked_on_undefined_test') cur.blocked = val === 'true';
  }
  return entries;
}

// የተፈረሱ የtests ስሞች በቀጥታ ከመግለጫው ውስጥ ይነበባሉ (በስም ውስጥ የተቆልፈው " ይቀበላል)
const YAML_STR = '"((?:[^"\\\\]|\\\\.)*)"';
const unq = (s) => s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
function registryTests(text) {
  const map = new Map();
  let cur = null;
  const entryRe = new RegExp(`^      - \\{file: ${YAML_STR}, name: ${YAML_STR}\\}$`, 'm');
  for (const raw of text.split('\n')) {
    const id = raw.match(/^  - id: (\S+)$/);
    if (id) { cur = id[1]; map.set(cur, []); continue; }
    const t = raw.match(entryRe);
    if (t && cur) map.get(cur).push({ file: unq(t[1]), name: unq(t[2]) });
  }
  return map;
}

function actualTests() {
  const map = new Map();
  for (const f of readdirSync(join(REPO, 'tests')).filter((n) => n.endsWith('.test.mjs')).sort()) {
    const src = readFileSync(join(REPO, 'tests', f), 'utf8');
    for (const m of src.matchAll(/^test\('([^']+)'/gm)) {
      for (const id of m[1].match(/\b(?:R|CI|LC|RU|OP|VE|FD)-\d{2}\b/g) ?? []) {
        if (!map.has(id)) map.set(id, []);
        map.get(id).push({ file: `tests/${f}`, name: m[1] });
      }
    }
  }
  return map;
}

const yamlText = readFileSync(REQ_FILE, 'utf8');
const registry = parseRegistry(yamlText);
const regTests = registryTests(yamlText);

test('F-04፦ መዝገቡ 85 መስፈርቶችና 123 አጠቃላይ መለያዎች ብቻ አሉት — ሁለተኛ ዋና ምንጭ የለም', () => {
  const requirements = registry.filter((e) => e.kind === 'requirement');
  assert.equal(requirements.length, 85, `የ85 መስፈርቶች ብዛት ተሰብሯል፦ ${requirements.length}`);
  assert.equal(registry.length, 123, `አጠቃላይ መለያ (R42+CI14+LC15+RU14+OP20+VE10+FD8) = 123 መሆን አለበት`);
  for (const fam of [...REQ_FAMILIES, 'OP', 'VE', 'FD']) {
    const expected = { R: 42, CI: 14, LC: 15, RU: 14, OP: 20, VE: 10, FD: 8 }[fam];
    assert.equal(registry.filter((e) => e.family === fam).length, expected, `${fam} ቤተሰብ ብዛት`);
  }
  const ids = registry.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'ድግምስ መለያ የለም');
});

test('F-04፦ መዝገቡ ከሰነዶቹ መለያ ስብስብ ጋር በትክክል ይዛመዳል', () => {
  const fromDocs = new Set();
  const v28 = readFileSync(join(REPO, 'docs', 'FARMER_AI_PHONE_CANONICAL_REQUIREMENT_OWNER_EVIDENCE_REGISTRY_v2_8_AM.md'), 'utf8');
  for (const m of v28.matchAll(/^\|\s*((?:R|CI|LC|RU|OP|VE|FD)-\d{2})\s*\|/gm)) fromDocs.add(m[1]);
  assert.equal(fromDocs.size, 123);
  assert.deepEqual([...registry.map((e) => e.id)].sort(), [...fromDocs].sort(), 'መዝገብና v2.8 መለያ ስብስብ አንድ አይደሉም');
});

test('F-04/F-19፦ የመዝገቡ የፍተሻ ማጣቀሻ ከእውነተኛ የፍተሻ ስሞች ጋር ይዛመዳል (stale መዝገብ ይከለከላል)', () => {
  const actual = actualTests();
  for (const e of registry) {
    const listed = regTests.get(e.id) ?? [];
    const real = actual.get(e.id) ?? [];
    assert.deepEqual(
      listed.map((t) => `${t.file}::${t.name}`).sort(),
      real.map((t) => `${t.file}::${t.name}`).sort(),
      `${e.id} ሽፋን ተሰብሯል — node tools/build-requirements.mjs ደግመህ ሮጠ`
    );
    const expected = real.length ? 'G1_TEST_EXISTS' : (e.blocked ? 'BLOCKED_ON_UNDEFINED_TEST' : 'NOT_COVERED');
    assert.equal(e.coverage, expected, `${e.id} coverage ስህተት`);
  }
});

test('F-19፦ ለ85ቱ መስፈርቶች የተለየ የሙከራ መግለጫ ፋይል አለ', () => {
  const files = readdirSync(SPECS).filter((f) => f.endsWith('.yaml')).sort();
  const need = registry.filter((e) => e.kind === 'requirement').map((e) => e.id).sort();
  assert.deepEqual(files, need.map((id) => `${id}.yaml`), 'የሙከራ መግለጫዎች ዝርዝር ከ85ቱ ጋር አይዛመድም');
  for (const id of need) {
    const spec = readFileSync(join(SPECS, `${id}.yaml`), 'utf8');
    assert.match(spec, new RegExp(`^id: ${id}$`, 'm'), `${id} መግለጫ id የለውም`);
    assert.match(spec, /^status: (G1_TEST_EXISTS|NOT_COVERED|BLOCKED-ON-UNDEFINED-TEST)$/m, `${id} የሁኔታ ቃል የለውም`);
    assert.match(spec, /^doc_acceptance: /m, `${id} የመቀበያ ማስረጃ መስክ የለውም`);
    assert.match(spec, /^blocked_on: /m, `${id} blocked_on መስክ የለውም`);
    if (/^status: G1_TEST_EXISTS$/m.test(spec)) assert.match(spec, /^test_scope_note: /m, `${id} የወሰን ማስታወሻ የለውም (R-24)`);
  }
});

test('F-02፦ OP-21–26 ያልተገለጹ መሆናቸውና የጎደሉ ፍተሻዎች በግልጽ ተመዝግበዋል', () => {
  const summary = JSON.parse(readFileSync(join(REPO, 'requirements', 'coverage-summary.json'), 'utf8'));
  assert.equal(summary.requirement_count, 85);
  assert.equal(summary.duplicate_table_id_set_mismatch, 0, 'የ85ቱ መለያ ስብስብ በሰነዶች ውስጥ ተሰብሯል');
  assert.equal(
    summary.requirements_covered + summary.requirements_not_covered + summary.requirements_blocked,
    85,
    'ሦስቱ የሽፋን ክፍሎች ድምር 85 መሆን አለበት'
  );
  assert.ok(summary.requirements_blocked > 0, 'OP-21–26 ምክንያት የተዘጉ ረድፎች መመዘገብ አለባቸው');
  const undefinedInDocs = ['OP-21', 'OP-22', 'OP-23', 'OP-24', 'OP-25', 'OP-26']
    .filter((op) => !readFileSync(join(REPO, 'docs', 'FARMER_AI_PHONE_CANONICAL_REQUIREMENT_OWNER_EVIDENCE_REGISTRY_v2_8_AM.md'), 'utf8')
      .includes(`| ${op} |`));
  assert.equal(undefinedInDocs.length, 6, 'OP-21–26 በv2.8 መለያ ሰንጠረዥ ውስጥ መቅረት አለባቸው');
});

test('F-06/F-04፦ የተደጋገሙ ሰንጠረዦች የቃላት ልዩነት ተመዝግቦ ተገልጿል (ነባር ሰነድ አይቀየርም)', () => {
  const drift = JSON.parse(readFileSync(join(REPO, 'requirements', 'duplicate-table-drift.json'), 'utf8'));
  assert.equal(drift.id_set_mismatch.length, 0);
  assert.equal(drift.text_drift.length, 12, 'የቃላት ልዩነት ብዛት ተለውጧል — ምንጭ ሰነድ ለውጥ መመዝገብ አለበት');
  assert.deepEqual([...new Set(drift.text_drift.map((d) => d.table))], ['v44'], 'ልዩነቱ የሚጠበቀው v4.4 §12 ውስጥ ብቻ ነው');
  assert.deepEqual([...new Set(drift.text_drift.map((d) => d.id.split('-')[0]))], ['LC'], 'ልዩነቱ LC ቤተሰብ አጭር ስሞች ብቻ ናቸው');
});

test('F-25፦ ምንም መስፈርት በስም የተሾመ ባለቤት እንደሌለው በግልጽ ይናገራል', () => {
  const named = registry.filter((e) => e.ownerNamed !== null && e.ownerNamed !== 'null');
  assert.deepEqual(named.map((e) => e.id), [], 'የተሾመ ባለቤት ካለ መዝገቡ መከታተል አለበት — አሁን ግን ሹመት የለም (F-25)');
  assert.ok(existsSync(join(REPO, 'decisions', 'OWNER_DECISION_G0_G1.md')), 'የባለቤት ውሳኔ መዝገብ ፋይል ገና የለም (F-03) — GAP ተመዝግቧል');
});

test('የማረጋገጫ ቋንቋ ጥራት፦ በተመሠረቱ አማርኛ አርቲፋክቶች ላይ ያልተጠበቀ የውጭ-አልቋቢ ፊደል (ቻይና/ግሪክ/ሲሪላዊ/ዓረብ/ዕብራይስጥ/ቻሮኪ/ሞንጎሊያን) የለም', () => {
  // ዓላማ፦ ማስረጃ ፋይሎች እንዲሁም ኮድ ውስጥ የተደባለቀ የእርሻ-ስልክ ወጪ ቋንቋ ጽሑ፣ ወይም ለግዕዝ ፊደል
  // ተመሳሳይ ገጽታ ያለው ግራ መጋባት ፊደል መገኘት። ምልክቶች (ቀስት፣ ≠፣ ⚠) እና እንቁላል-ምልክቶች ይፈቀዳሉ።
  const EXT = ['.md', '.mjs', '.js', '.json', '.yaml', '.yml', '.html', '.css', '.txt'];
  // Captured terminal/research artifacts retain BOM/box-drawing/U+FFFD as evidence; they are not authored docs/code.
  // Excluding these exact paths keeps the evidence byte-for-byte intact while the policy still applies to authored files.
  const CAPTURED_EVIDENCE_ARTIFACTS = new Set([
    'docs/support/android-asr-tts/desktop-asr-decode.txt',
    'research/oromo-number-normalizer/AUDIT_RESULTS.json',
    'research/oromo-number-normalizer/TEST_RESULTS.txt',
    'research/model-bakeoff-20261114/run/prompts/qwen35-4b-AM1F.txt',
  ]);
  const SKIP_DIR = new Set(['.git', 'node_modules', 'bin', 'models', '.tmp', 'evidence', 'fixtures', 'private']);
  const files = [];
  (function walk(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR.has(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (EXT.includes(extname(ent.name))) files.push(p);
    }
  })(REPO);

  // የሚፈቀዱ ክልሎች፦ ASCII፣ ላቲን-ተጓዳኝ/ማዋሃድ (00A0–036F)፣ ግዕዝ (1200–139F + 2D80–2DFF)፣
  // አለም-አቀፍ ምልክቶች/ቀስቶች/ሒሳብ/ዲንግባት (2000–24FF፣ 2600–27BF፣ 2900–2BFF)፣ እንቁላል-ምልክቶች።
  // ከእነዚህ ውጭ ያለ ኮድ ነጥብ — ቻይና፣ ግሪክ፣ ሲሪላዊ፣ ዕብራይስጥ፣ ዓረብ፣ ሐንግል፣ ሞንጎሊያን፣ ቻሮኪ… — ጥያቄ ይከፍታል።
  // ሳጥን-መስመር (2500–257F)ና ጂኦሜትሪክ (25A0–25FF) ቅንጣቶች በማስረጃ ፋይሎች አይፈቀዱም።
  const ALLOW = [
    [0x0000, 0x007f], // ASCII (ልዩ ኮንትሮል ከታች)
    [0x00a0, 0x036f], // ላቲን-1 (¥ · « §) + ማዋሃድ ምልክቶች
    [0x1200, 0x139f], // ግዕዝ
    [0x2000, 0x24ff], // — ‘’ • … ² € ™ → ↔ ≈ ≠ ␣
    [0x2600, 0x27bf], // ⚠ ⛔ ✓ እና ዲንግባቶች
    [0x2900, 0x2bff], // ተጨማሪ ቀስቶች/ሒሳብ
    [0x2d80, 0x2dff], // የግዕዝ ቅጥያ + ተዘራጭ ቅጥያ
    [0x1f000, 0x1fbff], // 🎤 🔊
    [0xfe00, 0xfe0f], // ቅንጥብ-ምርጫ
  ];
  // በዓላማ የተገቡ አንድ-አንድ ልዩ ነጥቦች — ምክንያታቸው ከፋይሉ ማስታወሻ ጋር ተረጋግጧል፦
  const EXCEPTION = {
    0x03ba: 'κ — የገምጋሚ ሪፖርት ውስጥ የCohen’s κ (የገምጋሚዎች መስማማት) የሒሳብ ምልክት',
    0xff1a: 'ምሉል-ስፍ ፦ — በsafety.mjs ውስጥ የሚገኝ ስህተት ለማጣራት በregex ውስጥ ብቻ',
  };
  const allowed = (c) => EXCEPTION[c] !== undefined || ALLOW.some(([lo, hi]) => c >= lo && c <= hi);
  const bad = [];
  for (const abs of files) {
    const rel = relative(REPO, abs).replaceAll('\\', '/');
    if (CAPTURED_EVIDENCE_ARTIFACTS.has(rel)) continue;
    const text = readFileSync(abs, 'utf8');
    if (text.includes('\0')) continue; // ባይናሪ ፋይል ጽሑፍ አይደለም
    [...text].forEach((ch, i) => {
      const c = ch.codePointAt(0);
      if (c <= 0x1f && (c === 0x09 || c === 0x0a || c === 0x0d)) return;
      if (allowed(c)) return;
      const line = text.slice(0, i).split('\n').length;
      bad.push(`${rel}:${line} U+${c.toString(16).toUpperCase()}`);
    });
  }
  assert.deepEqual(bad, [], 'ያልተጠበቀ የውጭ አልቋቢ ፊደል ተገኝቷል — አማርኛ ማስረጃም ኮድም ከቻይና/ሌላ ቋንቋ ጽሑፍ ነጻ መሆን አለበት');
});
