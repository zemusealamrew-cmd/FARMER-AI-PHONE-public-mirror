// F-04 / F-19 / F-02፦ ወደ አንድ ማሽን-ሚነበብ መዝገብ የሚለወጥ አንድ ምንጭ ማዋጪ።
// ይህ ፋይል ራሱ አዲስ ዋና እውነት አይፈጥርም — ከባለቤቱ የጸደቁ ሰነዶች (v2.8 ባለቤት/ትርጉም፣
// v3.9+v4.4 የታቀደ ማረጋገጫ፣ v4.7 የመቀበያ ማስረጃ) እና ከእውነተኛ የፍተሻ ስሞች ውጤት ይሰብስባል።
// የሚጻፉት፦ requirements/requirements.yaml እና tests/specs/<ID>.yaml (85)።
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCS = join(REPO, 'docs');

const SOURCES = {
  v28: 'FARMER_AI_PHONE_CANONICAL_REQUIREMENT_OWNER_EVIDENCE_REGISTRY_v2_8_AM.md',
  v39: 'FARMER_AI_PHONE_G0_CONTROLLED_CROSSWALK_CORRECTION_v3_9_AM.md',
  v44: 'FARMER_AI_PHONE_DEVELOPER_HANDOFF_FORMAT_CORRECTED_v4_4_AM.md',
  v47: 'FARMER_AI_PHONE_TEST_ADEQUACY_ACCEPTANCE_CONTRACT_v4_7_AM.md',
  v50: 'BUILDER_MASTER_DESIGN_v5_0_AM.md',
};

const ID_RE = /^(\|\s*)((?:R|CI|LC|RU|OP|VE|FD)-\d{2})\s*\|/;
const REQ_FAMILIES = ['R', 'CI', 'LC', 'RU'];
const EVIDENCE_FAMILIES = ['OP', 'VE', 'FD'];
// F-02፦ OP-21–OP-26 በማንኛውም የተጸደቀ ሰነድ ውስጥ ትርጉም የላቸውም
const UNDEFINED_OP = ['OP-21', 'OP-22', 'OP-23', 'OP-24', 'OP-25', 'OP-26'];
function rowsOf(file) {
  const out = new Map();
  const lines = readFileSync(join(DOCS, file), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = line.match(ID_RE);
    if (!m) return;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells[0] !== m[2]) return;
    const id = cells[0];
    if (!out.has(id)) out.set(id, []);
    out.get(id).push({ line: i + 1, cells });
  });
  return out;
}

const doc = Object.fromEntries(Object.entries(SOURCES).map(([k, f]) => [k, rowsOf(f)]));

function one(table, id, label) {
  const hits = doc[table].get(id);
  if (!hits || !hits.length) throw new Error(`${label} ውስጥ ${id} የለም`);
  return hits[0];
}

// F-04 መከታተያ (1) — መለያ ስብስብ ግዴታ እኩል መሆን አለበት፤ ይህ ብቻ ለውጥ ቢሆን ግን ግንባቱን ያቆማል
// F-04 መከታተያ (2) — የቃላት ልዩነት (አብዛኛው አጭር ስም) አይቀየርም፣ ተቆጥሮ ይዘገባል።
// ምክንያቱም v2.8 ዋና ትርጉም ነው፤ ታሪካዊ ሰነዶች ግን አይቀየሩም (ነባር ሰነድ አትሰርዝ)።
const textDrift = [];
const idSetMismatch = [];
for (const [table, col] of [['v39', 1], ['v44', 1], ['v47', 1], ['v50', 1]]) {
  const reqIds = new Map([...doc[table]].filter(([id]) => REQ_FAMILIES.includes(id.split('-')[0])));
  const masterIds = new Map([...doc.v28].filter(([id]) => REQ_FAMILIES.includes(id.split('-')[0])));
  const missing = [...masterIds.keys()].filter((id) => !reqIds.has(id));
  const extra = [...reqIds.keys()].filter((id) => !masterIds.has(id));
  if (missing.length || extra.length) idSetMismatch.push({ table, missing, extra });
  for (const [id, hits] of reqIds) {
    const master = masterIds.get(id)?.[0];
    if (!master) continue;
    const other = hits[0];
    if (other.cells[col] !== master.cells[1]) {
      textDrift.push({ id, table, doc_line: other.line, master_line: master.line, canonical: master.cells[1], tabled: other.cells[col] });
    }
  }
}

const testsById = collectTestCoverage();
function collectTestCoverage() {
  const map = new Map();
  for (const f of readdirSync(join(REPO, 'tests')).filter((n) => n.endsWith('.test.mjs')).sort()) {
    const src = readFileSync(join(REPO, 'tests', f), 'utf8');
    for (const m of src.matchAll(/^test\('([^']+)'(?:,\s*(?:async\s*)?\(|$)/gm)) {
      const name = m[1];
      for (const id of name.match(/\b(?:R|CI|LC|RU|OP|VE|FD)-\d{2}\b/g) ?? []) {
        if (!map.has(id)) map.set(id, []);
        map.get(id).push({ file: `tests/${f}`, name });
      }
    }
  }
  return map;
}

const evidenceTokens = (s) => (s.match(/\b(?:R|CI|LC|RU|OP|VE|FD|G\d)-\d{2}(?:–\d{2})?\b|G\d/g) ?? []);
const gatesOf = (s) => [...new Set(s.match(/\bG[0-4]\b/g) ?? [])].sort();

// F-19 / Issue #3፦ የፍተሻ-ስም/ID መኖር (coverage) የተግባር መሟላት አይደለም — ይህ የተለየ ዘንግ ነው።
// በG2/G3/G4 የተመዘገበ መስፈርት በG1 ላፕቶፕ ሊረጋገጥ አይችልም (NOT_AUTHORIZED_AT_G1)፤ OP-21–26
// ያልተገለጸ ፍተሻ ያለበት BLOCKED_ON_UNDEFINED_TEST፤ ሌላውም የባለቤት/የገለልተኛ ፊርማ ሳይኖር
// REQUIRES_EVIDENCE ብቻ ነው — VERIFIED በጭራሽ አይሰጥም (acceptance_signoff ሁሉ null ነው)።
// የregex የፍተሻ-ስም ቁጥር ይህን ዘንግ አያሻሽለውም፤ የመሣሪያ ፈቃድ ከፍተሻ-ብዛት ይቀድማል።
function behaviorVerification(e) {
  if (e.gates.some((g) => g === 'G2' || g === 'G3' || g === 'G4')) return 'NOT_AUTHORIZED_AT_G1';
  if (e.blocked_on_undefined_test) return 'BLOCKED_ON_UNDEFINED_TEST';
  return 'REQUIRES_EVIDENCE';
}

function build(id) {
  const master = one('v28', id, 'v2.8');
  const cells = master.cells;
  const family = id.split('-')[0];
  const text = cells[1];
  const ownerRole = cells[2];
  const registryStatus = cells[3];
  const entry = {
    id,
    family,
    kind: REQ_FAMILIES.includes(family) ? 'requirement' : 'evidence_item',
    text,
    owner_role: ownerRole,
    owner_named: null,
    registry_status: registryStatus,
    source: { doc: 'v2.8', line: master.line },
  };

  if (REQ_FAMILIES.includes(family)) {
    const c39 = one('v39', id, 'v3.9').cells;
    const c47 = one('v47', id, 'v4.7').cells;
    entry.planned_evidence = evidenceTokens(c39[3] ?? '').filter((t) => !/^G\d/.test(t));
    entry.gates = gatesOf(`${c39[3] ?? ''} ${c47[2] ?? ''}`);
    entry.doc_owner_role_v39 = c39[2] ?? null;
    entry.acceptance_evidence = c47[3] ?? null;
    entry.doc_status_v47 = c47[4] ?? null;
    entry.undefined_op_refs = UNDEFINED_OP.filter((op) => `${c39[3]} ${c47[2]}`.includes(op));
    entry.blocked_on_undefined_test = entry.undefined_op_refs.length > 0;
    const t = testsById.get(id) ?? [];
    entry.tests = t;
    entry.coverage = t.length ? 'G1_TEST_EXISTS' : (entry.blocked_on_undefined_test ? 'BLOCKED_ON_UNDEFINED_TEST' : 'NOT_COVERED');
    entry.behavior_verification = behaviorVerification(entry);
    entry.acceptance_signoff = null;
  } else {
    entry.gates = family === 'OP' ? ['G1', 'G2'] : family === 'VE' ? ['G2'] : ['G3'];
    const t = testsById.get(id) ?? [];
    entry.tests = t;
    entry.coverage = t.length ? 'G1_TEST_EXISTS' : 'NOT_COVERED';
  }
  entry.evidence_ref = null;
  return entry;
}

const ids = [...doc.v28.keys()].sort((a, b) => {
  const fam = (x) => [...REQ_FAMILIES, ...EVIDENCE_FAMILIES].indexOf(x.split('-')[0]);
  return fam(a) - fam(b) || a.localeCompare(b);
});

const entries = ids.map(build);
const counts = {};
for (const e of entries) counts[e.family] = (counts[e.family] ?? 0) + 1;
const requirementCount = entries.filter((e) => e.kind === 'requirement').length;

// ---- YAML ጽሐፊ (ቀላል፣ ያለ ግጭት ተደጋጋሚ ውጤት) ----
const q = (v) => {
  if (v === null) return 'null';
  const s = String(v);
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};
const line = (n, v) => (v === null || v === undefined ? `    ${n}: null` : `    ${n}: ${v}`);

function emitEntry(e) {
  const L = [];
  L.push(`  - id: ${e.id}`);
  L.push(`    family: ${e.family}`);
  L.push(`    kind: ${e.kind}`);
  L.push(`    text: ${q(e.text)}`);
  L.push(`    owner_role: ${q(e.owner_role)}`);
  L.push(`    owner_named: null`);
  L.push(`    gates: [${e.gates.join(', ')}]`);
  L.push(`    blocked_on_undefined_test: ${e.blocked_on_undefined_test ? 'true' : 'false'}`);
  if (e.undefined_op_refs?.length) L.push(`    undefined_op_refs: [${e.undefined_op_refs.map((op) => `"${op}"`).join(', ')}]`);
  L.push(line('planned_evidence', e.planned_evidence ? `[${e.planned_evidence.join(', ')}]` : null));
  L.push(line('acceptance_evidence', e.acceptance_evidence ? q(e.acceptance_evidence) : null));
  L.push(line('doc_status', e.doc_status_v47 ? q(e.doc_status_v47) : q(e.registry_status)));
  L.push(`    source: {doc: "v2.8", line: ${e.source.line}}`);
  if (e.tests.length) {
    L.push('    tests:');
    for (const t of e.tests) L.push(`      - {file: "${t.file}", name: ${q(t.name)}}`);
  } else {
    L.push('    tests: []');
  }
  L.push(`    coverage: ${e.coverage}`);
  if (e.kind === 'requirement') {
    L.push(`    behavior_verification: ${e.behavior_verification}`);
    L.push('    acceptance_signoff: null');
  }
  L.push('    evidence_ref: null');
  return L.join('\n');
}

const yaml = [
  '# FARMER-AI-PHONE — አንድ ዋና የማሽን-ሚነበብ መስፈርት/ኃላፊነት/ማስረጃ መዝገብ (F-04)',
  '# በእጅ አትቀይር። ማከማቻው ዋና ቅጂ ነው፤ ማንኛውም ለውጥ በምንጭ ሰነድ ላይ ተደርጎ',
  '#   node tools/build-requirements.mjs   በኩል መመለስ አለበት።',
  '# ምንጮች፦ v2.8 §3 (ትርጉም + ባለቤት)፣ v3.9 §3 እና v4.4 §12 (የታቀደ ማረጋገጫ)፣',
  '#          v4.7 §3 (የመቀበያ ማስረጃ)፣ tests/*.test.mjs (እውነተኛ የፍተሻ ሽፋን)።',
  '# coverage ትርጉም፦ G1_TEST_EXISTS = በፍተሻ ስም የተገናኘ፤ NOT_COVERED = ፍተሻ የለም፤',
  '#          BLOCKED_ON_UNDEFINED_TEST = OP-21–26 ስለጸደቀ የለ (F-02)።',
  '# behavior_verification (Issue #3)፦ coverage የፍተሻ-ስም/ID መኖር ብቻ ነው፤ የተግባር መሟላት አይደለም።',
  '#          NOT_AUTHORIZED_AT_G1 = የG2/G3/G4 መስፈርት (በG1 ላፕቶፕ አይረጋገጥም)፤',
  '#          BLOCKED_ON_UNDEFINED_TEST = OP-21–26 ጥገኛ፤ REQUIRES_EVIDENCE = የባለቤት/ገለልተኛ ፊርማ የለም።',
  '#          VERIFIED የለም፤ acceptance_signoff ሁሉ null ነው። የፍተሻ-ብዛት ይህን ዘንግ አይቀይርም።',
  `generated_by: "tools/build-requirements.mjs"`,
  `schema_version: 1`,
  `requirement_count: ${requirementCount}`,
  `family_counts: {${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ')}}`,
  `duplicate_table_id_set_mismatch: ${idSetMismatch.length}`,
  `duplicate_table_text_drift_rows: ${textDrift.length}`,
  'entries:',
  ...entries.map(emitEntry),
  '',
].join('\n');

mkdirSync(join(REPO, 'requirements'), { recursive: true });
writeFileSync(join(REPO, 'requirements', 'requirements.yaml'), yaml, 'utf8');

// ---- tests/specs/<ID>.yaml (F-19) ----
const SPECS = join(REPO, 'tests', 'specs');
if (existsSync(SPECS)) for (const f of readdirSync(SPECS)) rmSync(join(SPECS, f));
mkdirSync(SPECS, { recursive: true });

// በሰነድ ላይ የተገለጹ ተደራራቢ ሙከራዎች — F-19 "R-08/R-16/R-25 ቁርኝት አርም"
const OVERLAP_ARBITRATION = {
  'R-08': 'የቋንቋ ማስፋጫ (ትግርኛ/ሌሎች) ሙከራ ከCI-03 የዘዬ ሙከላ ጋር አይደራረብም — R-08 የአዲስ ቋንቋ መግቢያ ድንበር ብቻ ይፈትሻል።',
  'R-16': 'የFM መደበኛ አጠቃቀም ሙከራ ከR-31/R-32 የመቀበያ-ኃይል ሙከራ ይለያል — R-16 ድምፅ ማዳመጥ ብቻ፤ የAI ግቤት አይነካም።',
  'R-25': 'የባትሪ/ሙቀት/መሙያ ደህንነት ሙከራ ከR-39 የማከማቻ ጽናት ሙከራ ይለያል — R-25 የኤሌክትሪክ/ሙቀት አደጋ፤ R-39 የውሂብ ጥቅም።',
};

function scopeNote(e) {
  const gate = e.gates.length ? `፤ ዋናው ማረጋገጫ ${e.gates.join('+')} ላይ ይሰጣል` : '';
  return `በG1 የላፕቶፕ ማሳያ ወሰን ውስጥ ተፈትሟል${gate}`;
}

for (const e of entries.filter((x) => x.kind === 'requirement')) {
  const covered = e.tests.length > 0;
  const spec = [
    `# የ${e.id} የሙከራ መግለጫ — በtools/build-requirements.mjs ተነስቷል (F-19)`,
    `id: ${e.id}`,
    `requirement: ${q(e.text)}`,
    `owner_role: ${q(e.owner_role)}`,
    `owner_named: null`,
    `gates: [${e.gates.join(', ')}]`,
    covered
      ? 'status: G1_TEST_EXISTS'
      : e.blocked_on_undefined_test
        ? 'status: BLOCKED-ON-UNDEFINED-TEST'
        : 'status: NOT_COVERED',
    // F-19 / R-24፦ ፍተሻ መኖሩ መስፈርቱ መሟላቱ አይደለም — በG1 ላፕቶፕ ወሰን ውስጥ ብቻ የተፈተሸ ነው
    covered ? `test_scope_note: ${q(scopeNote(e))}` : null,
    // F-19 / Issue #3፦ የተግባር-ማረጋገጫ ዘንግ ከፍተሻ-መኖር (status) ተለይቷል፤ ፊርማ የለም
    `behavior_verification: ${e.behavior_verification}`,
    'acceptance_signoff: null',
    covered ? `executed_tests:` : 'executed_tests: []',
    ...(covered ? e.tests.map((t) => `  - {file: "${t.file}", name: ${q(t.name)}}`) : []),
    `doc_acceptance: ${q(e.acceptance_evidence ?? '')}`,
    `doc_status: ${q(e.doc_status_v47 ?? '')}`,
    e.blocked_on_undefined_test
      ? `blocked_on: [${e.undefined_op_refs.map((op) => `"${op} — ትርጉም/ባለቤት የለውም (F-02)"`).join(', ')}]`
      : 'blocked_on: []',
    `uncovered_because: ${q(covered ? '' : (e.acceptance_evidence ?? ''))}`,
    OVERLAP_ARBITRATION[e.id] ? `overlap_arbitration: ${q(OVERLAP_ARBITRATION[e.id])}` : null,
    '',
  ].filter((x) => x !== null).join('\n');
  writeFileSync(join(SPECS, `${e.id}.yaml`), spec, 'utf8');
}

const summary = {
  requirement_count: requirementCount,
  family_counts: counts,
  total_entries: entries.length,
  duplicate_table_id_set_mismatch: idSetMismatch.length,
  duplicate_table_text_drift_rows: textDrift.length,
  covered_by_executed_test: entries.filter((e) => e.coverage === 'G1_TEST_EXISTS').length,
  requirements_covered: entries.filter((e) => e.kind === 'requirement' && e.coverage === 'G1_TEST_EXISTS').length,
  requirements_not_covered: entries.filter((e) => e.kind === 'requirement' && e.coverage === 'NOT_COVERED').length,
  requirements_blocked: entries.filter((e) => e.kind === 'requirement' && e.coverage === 'BLOCKED_ON_UNDEFINED_TEST').length,
  specs_written: entries.filter((e) => e.kind === 'requirement').length,
  // F-19 / Issue #3፦ የተግባር-ማረጋገጫ ዘንግ ከፍተሻ-መኖር (covered_by_executed_test) ተለይቷል።
  // በG1 ላፕቶፕ ምንም መስፈርት VERIFIED አይደለም፤ የባለቤት/የገለልተኛ ፊርማ (acceptance_signoff) የለም።
  requirements_behavior_verified: entries.filter((e) => e.kind === 'requirement' && e.behavior_verification === 'VERIFIED').length,
  requirements_behavior_not_authorized: entries.filter((e) => e.kind === 'requirement' && e.behavior_verification === 'NOT_AUTHORIZED_AT_G1').length,
  requirements_behavior_requires_evidence: entries.filter((e) => e.kind === 'requirement' && e.behavior_verification === 'REQUIRES_EVIDENCE').length,
  requirements_behavior_blocked: entries.filter((e) => e.kind === 'requirement' && e.behavior_verification === 'BLOCKED_ON_UNDEFINED_TEST').length,
  coverage_semantics_note: 'coverage (G1_TEST_EXISTS) = የፍተሻ-ስም/ID መኖር ብቻ፤ የተግባር መሟላት አይደለም። behavior_verification = የተግባር ማረጋገጫ ዘንግ፦ በG1 ላፕቶፕ ምንም መስፈርት VERIFIED አይደለም (acceptance_signoff ሁሉ null)፤ የG2/G3/G4 መስፈርቶች NOT_AUTHORIZED_AT_G1 ናቸው። የregex የፍተሻ-ስም ቁጥር የመቀበያ ማስረጃ አይሆንም (Issue #3)።',
};
writeFileSync(join(REPO, 'requirements', 'coverage-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

// F-19 / Issue #3፦ የ85ቱ መስፈርቶች የsemantic ሽፋን ካርታ — የፍተሻ-መኖርን ከተግባር-ማረጋገጫ ይለያል።
// R-01/R-02/R-03 (የG2 መሣሪያ/ቴሌኮም) የG1 ላፕቶፕ ፕሮክሲ ፍተሻ ቢኖራቸውም NOT_AUTHORIZED_AT_G1 ናቸው።
const semanticRows = entries
  .filter((e) => e.kind === 'requirement')
  .map((e) => ({
    id: e.id,
    requirement: e.text,
    gates: e.gates,
    coverage_test_existence: e.coverage,
    behavior_verification: e.behavior_verification,
    acceptance_signoff: null,
    doc_acceptance: e.acceptance_evidence ?? '',
    doc_status: e.doc_status_v47 ?? '',
    linked_test_files: [...new Set(e.tests.map((t) => t.file))],
    linked_tests_verify_scope: 'የG1 ላፕቶፕ ፕሮክሲ/የፍተሻ-ስም መኖር ብቻ — የመሣሪያ/የመስክ ተግባር ማረጋገጫ አይደለም',
    proposed_owner_role: e.owner_role,
  }));
writeFileSync(join(REPO, 'requirements', 'semantic-coverage-exceptions.json'), `${JSON.stringify({
  note: 'Issue #3 / F-19፦ የ85ቱ መስፈርቶች የsemantic ሽፋን ካርታ። coverage_test_existence (የፍተሻ-ስም መኖር) ከ behavior_verification (የተግባር ማረጋገጫ) ተለይቷል። በG1 ምንም መስፈርት VERIFIED አይደለም፤ acceptance_signoff ሁሉ null ነው። የG2/G3/G4 መስፈርቶች (ለምሳሌ R-01/R-02/R-03) NOT_AUTHORIZED_AT_G1 ናቸው — የተገናኙት ፍተሻዎች የላፕቶፕ ፕሮክሲ ብቻ ናቸው። የregex የፍተሻ-ስም ቁጥር የመቀበያ ማስረጃ አይሆንም።',
  requirement_count: semanticRows.length,
  behavior_verified: semanticRows.filter((e) => e.behavior_verification === 'VERIFIED').length,
  behavior_not_authorized: semanticRows.filter((e) => e.behavior_verification === 'NOT_AUTHORIZED_AT_G1').length,
  behavior_requires_evidence: semanticRows.filter((e) => e.behavior_verification === 'REQUIRES_EVIDENCE').length,
  behavior_blocked: semanticRows.filter((e) => e.behavior_verification === 'BLOCKED_ON_UNDEFINED_TEST').length,
  exceptions: semanticRows,
}, null, 2)}\n`, 'utf8');
writeFileSync(join(REPO, 'requirements', 'duplicate-table-drift.json'), `${JSON.stringify({
  note: 'v2.8 §3 ዋና ትርጉም ነው። ታሪካዊ ሰነዶች (v4.4 §12) አይሠረፉም — ስለዚህ የቃላት ልዩነት ይቆጠራል እንጂ አይታረምም። የመለያ ስብስብ ግን ግዴታ እኩል መሆን አለበት (F-04)።',
  id_set_mismatch: idSetMismatch,
  text_drift: textDrift,
}, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
if (idSetMismatch.length) {
  console.error(`የ85ቱ መለያ ስብስብ በተደጋጋሚ ሰንጠረዦች ውስጥ አይዛመድም፦ ${JSON.stringify(idSetMismatch, null, 2)}`);
  process.exitCode = 1;
}
