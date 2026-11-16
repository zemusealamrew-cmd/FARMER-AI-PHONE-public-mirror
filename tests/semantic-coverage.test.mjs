// F-19 / Issue #3፦ የፍተሻ-ስም/ID መኖር (coverage) የተግባር መሟላት አይደለም። ይህ ፍተሻ የተለየውን
// የbehavior_verification ዘንግ ይጠብቃል፦ በG1 ላፕቶፕ ምንም መስፈርት VERIFIED አይደለም፣ የG2/G3/G4
// መስፈርቶች የላፕቶፕ ፕሮክሲ ፍተሻ ቢኖራቸውም NOT_AUTHORIZED_AT_G1 ናቸው። የregex የፍተሻ-ስም ቁጥር
// ብቻውን የመቀበያ ማስረጃ ሆኖ አያልፍም — በውስጥ የተዛባ የID ጥያኔ (mismatched test-ID claim) ይያዛል።
// ማስታወሻ፦ የፍተሻ ርዕሶች F-ID ብቻ ይጠቀሳሉ (R-ID በርዕስ ውስጥ የለም) — የሽፋን ስብስብ እንዳይቀየር።
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SPECS = join(REPO, 'tests', 'specs');
const BEHAVIOR_VALUES = new Set(['NOT_AUTHORIZED_AT_G1', 'REQUIRES_EVIDENCE', 'BLOCKED_ON_UNDEFINED_TEST']);
const specIds = readdirSync(SPECS).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, '')).sort();
const specText = (id) => readFileSync(join(SPECS, `${id}.yaml`), 'utf8');
const field = (text, name) => (text.match(new RegExp(`^${name}: (.*)$`, 'm')) ?? [])[1]?.trim();
const summary = JSON.parse(readFileSync(join(REPO, 'requirements', 'coverage-summary.json'), 'utf8'));
const matrix = JSON.parse(readFileSync(join(REPO, 'requirements', 'semantic-coverage-exceptions.json'), 'utf8'));

test('F-19 / Issue #3፦ እያንዳንዱ መግለጫ የተግባር-ማረጋገጫ ዘንግ አለው፣ በG1 ምንም VERIFIED አይደለም', () => {
  assert.equal(specIds.length, 85, 'የ85ቱ መስፈርቶች መግለጫ ተገኝቷል');
  for (const id of specIds) {
    const text = specText(id);
    const behavior = field(text, 'behavior_verification');
    assert.ok(BEHAVIOR_VALUES.has(behavior), `${id} behavior_verification ትክክለኛ ዋጋ የለውም፦ ${behavior}`);
    assert.notEqual(behavior, 'VERIFIED', `${id} በG1 ላፕቶፕ VERIFIED ሊሆን አይችልም`);
    assert.match(text, /^acceptance_signoff: null$/m, `${id} የባለቤት/የገለልተኛ ፊርማ የለም`);
  }
});

test('F-19 / Issue #3፦ የG2 መሣሪያ/ቴሌኮም መስፈርቶች በፕሮክሲ ፍተሻ ቢኖራቸውም NOT_AUTHORIZED_AT_G1 ናቸው', () => {
  // R-01/R-02/R-03 በርዕስ ውስጥ ሳይሆኑ በውስጥ ይጠራሉ — የሽፋን ስብስብ እንዳይቀየር።
  for (const id of ['R-01', 'R-02', 'R-03']) {
    const text = specText(id);
    assert.match(field(text, 'gates'), /G2/, `${id} የG2 መሣሪያ/ቴሌኮም መስፈርት ነው`);
    assert.equal(field(text, 'status'), 'G1_TEST_EXISTS', `${id} የላፕቶፕ ፕሮክሲ ፍተሻ አለው (coverage አልተቀየረም)`);
    assert.equal(field(text, 'behavior_verification'), 'NOT_AUTHORIZED_AT_G1', `${id} የመሣሪያ ተግባር በG1 አልተፈቀደም`);
    assert.match(text, /^acceptance_signoff: null$/m, `${id} ፊርማ የለም`);
  }
});

test('F-02 / F-19 / Issue #3፦ ማጠቃለያው የፍተሻ-መኖርን ከተግባር-ማረጋገጫ ይለያል (behavior VERIFIED=0)', () => {
  assert.equal(summary.requirements_behavior_verified, 0, 'በG1 ምንም መስፈርት VERIFIED አይደለም');
  assert.ok(summary.requirements_behavior_not_authorized > 0, 'የG2/G3/G4 መስፈርቶች NOT_AUTHORIZED ተብለው ተመዝግበዋል');
  assert.equal(
    summary.requirements_behavior_verified + summary.requirements_behavior_not_authorized +
      summary.requirements_behavior_requires_evidence + summary.requirements_behavior_blocked,
    85,
    'የተግባር-ማረጋገጫ ክፍሎች ድምር 85 ነው',
  );
  // የፍተሻ-መኖር ዘንግ አልተቀየረም (ነባር ማስረጃ ተጠብቋል)
  assert.equal(summary.requirements_covered + summary.requirements_not_covered + summary.requirements_blocked, 85);
  assert.equal(summary.covered_by_executed_test, 52);
  assert.ok(summary.coverage_semantics_note && summary.coverage_semantics_note.length > 0, 'የሽፋን ትርጉም ማስታወሻ አለ');
});

test('F-19 / Issue #3፦ የsemantic ካርታ ማትሪክስ 85ቱን ይዘረዝራል፣ የተገናኙ ፍተሻዎች የላፕቶፕ ፕሮክሲ ብቻ ናቸው', () => {
  assert.equal(matrix.requirement_count, 85);
  assert.equal(matrix.exceptions.length, 85);
  assert.equal(matrix.behavior_verified, 0);
  for (const row of matrix.exceptions) {
    assert.equal(row.acceptance_signoff, null, `${row.id} ፊርማ የለም`);
    assert.match(row.linked_tests_verify_scope, /ፕሮክሲ/, `${row.id} የተገናኙ ፍተሻዎች የላፕቶፕ ፕሮክሲ ብቻ መሆናቸውን ይናገራል`);
    assert.ok(BEHAVIOR_VALUES.has(row.behavior_verification), `${row.id} የተግባር ዋጋ ትክክል ነው`);
  }
  for (const id of ['R-01', 'R-02', 'R-03']) {
    const row = matrix.exceptions.find((r) => r.id === id);
    assert.ok(row, `${id} በማትሪክሱ ውስጥ አለ`);
    assert.equal(row.behavior_verification, 'NOT_AUTHORIZED_AT_G1');
    assert.ok(row.gates.includes('G2'), `${id} G2 ነው`);
    assert.ok(row.linked_test_files.length > 0, `${id} የተገናኙ የላፕቶፕ ፍተሻዎች አሉት (ግን መሟላት አይደለም)`);
  }
});

test('F-19 / Issue #3፦ የመሣሪያ ፈቃድ ከፍተሻ-ብዛት ይቀድማል — የተዛባ የID ጥያኔ VERIFIED አያደርግም', () => {
  // በውስጥ የተገናኘ የፍተሻ-ስም ብቻ ያለው የG2/G3/G4 መስፈርት በጭራሽ VERIFIED አይሆንም።
  const device = matrix.exceptions.filter((r) => r.gates.some((g) => ['G2', 'G3', 'G4'].includes(g)));
  assert.ok(device.length > 0, 'የመሣሪያ/መስክ/ማምረቻ መስፈርቶች አሉ');
  for (const row of device) {
    assert.equal(row.behavior_verification, 'NOT_AUTHORIZED_AT_G1', `${row.id} የመሣሪያ ፈቃድ ከፍተሻ-ብዛት ይቀድማል`);
  }
  // ፍተሻ ያለው (G1_TEST_EXISTS) ማንኛውም መስፈርት VERIFIED አይደለም፤ ፊርማ የለም
  const withTests = matrix.exceptions.filter((r) => r.coverage_test_existence === 'G1_TEST_EXISTS');
  assert.ok(withTests.length > 0);
  for (const row of withTests) {
    assert.notEqual(row.behavior_verification, 'VERIFIED', `${row.id} ፍተሻ መኖሩ መሟላት አይደለም`);
    assert.equal(row.acceptance_signoff, null);
  }
  // የተለየው የመሣሪያ ፕሮክሲ ሁኔታ፦ ፍተሻ ያለው የG2 መስፈርት (እነ R-01) NOT_AUTHORIZED ነው
  const deviceWithProxyTests = device.filter((r) => r.coverage_test_existence === 'G1_TEST_EXISTS');
  assert.ok(deviceWithProxyTests.length >= 3, 'ቢያንስ ሦስት የላፕቶፕ ፕሮክሲ ፍተሻ ያላቸው የG2 መስፈርቶች አሉ');
  for (const row of deviceWithProxyTests) {
    assert.equal(row.behavior_verification, 'NOT_AUTHORIZED_AT_G1', `${row.id} ፕሮክሲ ፍተሻ ቢኖረውም የመሣሪያ ተግባር አልተፈቀደም`);
  }
});