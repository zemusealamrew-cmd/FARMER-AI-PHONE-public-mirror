// F-04 / G1-D01፦ requirements/work_packages.yaml ከሦስቱም ምንጮች ጋር እኩል መሆኑን ይፈትሻል።
// ይህ ፋይል አዲስ ዋና መዝገብ እንዳይፈጠር የሚከላከል የአዛምዶ ማረጋገጫ ፍተሻ ነው — አንብቦ ብቻ ያወዳድራል፣ አይጽፍም።
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const WP_FILE = join(REPO, 'requirements', 'work_packages.yaml');

// -- አንባቢዎች ------------------------------------------------------
function parseTable(md, idRe) {
  const rows = new Map();
  for (const raw of md.split('\n')) {
    if (!raw.startsWith('|')) continue;
    const cells = raw.split('|').slice(1, -1).map((c) => c.trim());
    if (!cells.length || !idRe.test(cells[0])) continue;
    rows.set(cells[0], cells);
  }
  return rows;
}

// በቅንፍ ላይ የተጀመረ ትንሽ YAML አንባቢ (packages:/g1_steps: ቆንጆ ክፍሎች ብቻ)
function parseWp(text) {
  const out = { packages: [], steps: [] };
  let section = null;
  let cur = null;
  const list = (v) => (v === '[]' ? [] : v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean));
  for (const raw of text.split('\n')) {
    if (raw.startsWith('packages:')) { section = 'packages'; continue; }
    if (raw.startsWith('g1_steps:')) { section = 'steps'; continue; }
    if (raw.match(/^[a-z_0-9]+:/)) { section = null; continue; }
    const id = raw.match(/^  - id: (\S+)$/);
    if (id) {
      cur = { id: id[1] };
      (section === 'steps' ? out.steps : out.packages).push(cur);
      continue;
    }
    if (!cur) continue;
    const f = raw.match(/^    ([a-z_0-9]+): (.*)$/);
    if (!f) continue;
    const [, key, val] = f;
    if (key === 'requirements' || key === 'g1_steps' || key === 'evidence' || key === 'work_packages') cur[key] = list(val);
    else cur[key] = val.replace(/^"|"$/g, '').replace(/\\"/g, '"');
  }
  return out;
}

const wp = parseWp(readFileSync(WP_FILE, 'utf8'));
const ledger = parseTable(readFileSync(join(REPO, 'docs', 'OWNER_PROGRESS_LEDGER_v5_0_AM.md'), 'utf8'), /^W\d{2}$/);
const g1note = parseTable(readFileSync(join(REPO, 'docs', 'G1_OFFLINE_DEPLOYMENT_AND_DEVICE_FEASIBILITY_NOTE_AM.md'), 'utf8'), /^G1-D\d{2}$/);
const registryIds = new Set(
  readFileSync(join(REPO, 'requirements', 'requirements.yaml'), 'utf8')
    .split('\n').filter((l) => l.match(/^  - id: \S+$/)).map((l) => l.split(': ')[1])
);

const ACTUAL = ['MET', 'PARTIAL', 'GAP', 'UNKNOWN', 'REQUIRES_EVIDENCE', 'NOT_AUTHORIZED'];

test('F-04/G1-D01፦ ሁሉም W01–W21 እና G1-D01–D11 በአዛምዶው ውስጥ ሙሉ በሙሉ ተዘርዝረዋል', () => {
  assert.deepEqual(wp.packages.map((p) => p.id), [...ledger.keys()].sort(), 'የW መለያዎች ከመዝገብ ሰንጠረዥ ጋር ልዩነት አላቸው');
  assert.deepEqual(wp.steps.map((s) => s.id), [...g1note.keys()].sort(), 'የG1-D መለያዎች ከማስታወሻው ሰንጠረዥ ጋር ልዩነት አላቸው');
});

test('F-04፦ አዛምዶው የመዝገብ ሰንጠረዥ ርዕስና በር ቃል በቃል ይከተላል — ሁለተኛ ዋና ትርጉም የለም', () => {
  const drift = [];
  for (const p of wp.packages) {
    const row = ledger.get(p.id);
    if (!row) { drift.push(`${p.id}: በመዝገቡ ላይ የለ`); continue; }
    if (p.gate !== row[2]) drift.push(`${p.id}: በር ${p.gate} ≠ መዝገብ ${row[2]}`);
    if (p.ledger_title !== row[1]) drift.push(`${p.id}: ርዕስ "${p.ledger_title}" ≠ መዝገብ "${row[1]}"`);
    if (p.ledger_status !== row[3]) drift.push(`${p.id}: መነሻ ሁኔታ "${p.ledger_status}" ≠ መዝገብ "${row[3]}"`);
  }
  assert.deepEqual(drift, [], 'ከሰነድ ጋር የቃላት ልዩነት ተገኝቷል');
});

test('F-04፦ W ↔ G1-D አዛምዶ ተገላቢጦሹ ተመሳሳይ ነው', () => {
  const broken = [];
  for (const p of wp.packages) {
    for (const s of p.g1_steps ?? []) {
      const step = wp.steps.find((x) => x.id === s);
      if (!step) broken.push(`${p.id} → ${s} (ደረጃው የለ)`);
      else if (!step.work_packages.includes(p.id)) broken.push(`${p.id} ↔ ${s} (ተመለስተ መልስ የለ)`);
    }
  }
  for (const s of wp.steps) {
    for (const w of s.work_packages ?? []) {
      const p = wp.packages.find((x) => x.id === w);
      if (!p) broken.push(`${s.id} → ${w} (ሥራ ፓኬጁ የለ)`);
      else if (!p.g1_steps.includes(s.id)) broken.push(`${s.id} ↔ ${w} (ወደፊት አዛምዶ የለ)`);
    }
  }
  assert.deepEqual(broken, [], 'የአዛምዶ ተገላቢጦሽ ተበጥሷል');
});

test('F-04/F-19፦ በአዛምዶው የተጠቀሱ መስፈርትና የማረጋገጫ መለያዎች በመዝገቡ ውስጥ ብቻ ናቸው', () => {
  const unknown = [];
  for (const p of wp.packages) {
    for (const id of p.requirements ?? []) if (!registryIds.has(id)) unknown.push(`${p.id}: ${id}`);
    assert.ok(p.requirements?.length, `${p.id}: ምንም መስፈርት አልተያያዘም`);
  }
  assert.deepEqual(unknown, [], 'ያልተመዘገበ መለያ ተገኝቷል — አዲስ መለያ መፍጠር እንደተከለከለ (F-04)');
});

test('F-04፦ የተጠቀሱ የማስረጃ ፋይሎች በማከማቻው ውስጥ በእውነት አሉ', () => {
  const missing = [];
  for (const p of wp.packages) {
    for (const e of p.evidence ?? []) if (!existsSync(join(REPO, e))) missing.push(`${p.id}: ${e}`);
  }
  assert.deepEqual(missing, [], 'የሚጠበቅ ማስረጃ ፋይል የለም');
});

test('F-04/F-24፦ የተመዘገበ ሁኔታ የፍቀደ ቃል ነው፤ MET ያለ ማስረጃና ከG1 ውጭ አይታመድም', () => {
  const bad = [];
  for (const p of wp.packages) {
    if (!ACTUAL.includes(p.actual)) bad.push(`${p.id}: actual="${p.actual}"`);
    if (p.actual === 'MET') {
      if (p.gate !== 'G1') bad.push(`${p.id}: MET ለ${p.gate} አይታመድም`);
      if (!p.evidence?.length) bad.push(`${p.id}: MET ማስረጃ ሳያይዝ`);
    }
    if (p.gate !== 'G1' && p.actual !== 'NOT_AUTHORIZED') bad.push(`${p.id}: ${p.gate} ያለ ፈቃድ ሥራ መታመድ አይገባም`);
    if (p.ledger_status === 'NOT AUTHORIZED' && p.actual !== 'NOT_AUTHORIZED') bad.push(`${p.id}: የተከለከለ ደረጃ ተጣሰ`);
  }
  assert.deepEqual(bad, [], 'የማስረጃ ደረጃ ደንብ ተጥሷል');
});

test('F-04፦ የG1 ማስታወሻው "NOT STARTED" እውነት ካልሆነ በStale ይመዘገባል እንጂ ሰነዱ አልተቀየረም', () => {
  const notStarted = wp.steps.filter((s) => g1note.get(s.id)?.[3] === 'NOT STARTED');
  assert.ok(notStarted.length, 'በማስታወሻው ሰንጠረዥ የተመዘገበ መነሻ ሁኔታ አልተገኘም');
  const unstaled = notStarted.filter((s) => s.stale !== 'true').map((s) => s.id);
  assert.deepEqual(unstaled, [], 'STALE የሆነ ደረጃ በstale ሳይመዘገብ ቀርቷል');
});

// D-007 (ባለቤት ውሳኔ 2026-11-05፣ አማራጭ ሀ)፦ ሁለተኛ ዋና የክትትል መዝገብ ሊመለስ አይችልም።
test('F-04/D-007፦ ሥር ያለው መዝገብ አገናኝ ብቻ ነው — የW/G1-Dና የበር ሁኔታ ሰንጠረዥ የለውም', () => {
  const root = readFileSync(join(REPO, 'OWNER_PROGRESS_LEDGER.md'), 'utf8');
  assert.match(root, /docs\/OWNER_PROGRESS_LEDGER_v5_0_AM\.md/, 'ወደ ዋናው መዝገብ አገናኝ የለም');
  const wpRows = [...parseTable(root, /^W\d{2}$/).keys(), ...parseTable(root, /^G1-D\d{2}$/).keys()];
  assert.deepEqual(wpRows, [], 'ሁለተኛ የሥራ/ደረጃ ሰንጠረዥ ተመልሷል — F-04 አንድ ዋና መዝገብ ደንብ ይጥሳል');
  const gateRows = [...parseTable(root, /^G[0-4]$/).keys()];
  assert.deepEqual(gateRows, [], 'የበሮች ሁኔታ ሰንጠረዥ በሁለተኛ ቦታ ተመዝግቧል (ተደራራቢ እውነት)');
});
