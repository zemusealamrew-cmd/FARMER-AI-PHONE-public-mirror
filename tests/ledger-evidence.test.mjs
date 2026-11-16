// F-19 / F-22 / CI-12፦ መዝገቡ የሚጠቀሳቸው ሃሾችና ቁጥሮች ከእውነተኛ ማስረጃ ፋይሎች ጋር ግዴታ መዛመድ አለባቸው።
// ይህ ፍተሻ ከመጠናከሩ በፊት `77c0502ca322`(30 ፋይል) የተባለው ጥያኔ የታገደ መሆኑን አሳይቷል — አሁን ኮድ ይከላከላል።
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditLedgerEvidence, extractTar, gateAtRev, hashPath } from '../tools/verify-ledger-evidence.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = 'docs/OWNER_PROGRESS_LEDGER_v5_0_AM.md';

test('F-19፦ መዝገቡ ላይ ያሉት የማስረጃ ሃሾችና ቁጥሮች ሁሉ ከፋይሎች ጋር ይዛመዳሉ (0 mismatch)', () => {
  const report = auditLedgerEvidence(REPO);
  assert.equal(report.error, undefined, 'መዝገቡ መኖር አለበት');
  assert.ok(report.checked >= 20, `ቢያንስ 20 ማረጋገጫ ተመዝግቧል (${report.checked}) — ፍተሻው ባዶ እንዳይሆን`);
  assert.deepEqual(
    report.failures,
    [],
    `የተሳሳተ ማስረጃ ጥያኔ፦\n${report.failures.map((f) => `${f.kind} ${f.ref} claimed=${f.claimed} actual=${f.actual}`).join('\n')}`,
  );
  assert.equal(report.mismatch, 0);
});

test('F-19 / F-22፦ offline የይዘት ሃሽ የተመዘገበው ፋይሉ `scan_hash` መስክ ነው፣ የተቃኙ ፋይሎች ብዛትም እኩል', () => {
  const report = auditLedgerEvidence(REPO);
  const evidence = JSON.parse(readFileSync(join(REPO, 'evidence/offline-static-check.json'), 'utf8'));
  const scan = report.results.find((r) => r.kind === 'offline_scan_hash');
  const files = report.results.find((r) => r.kind === 'offline_files_scanned');
  assert.equal(scan.status, 'OK', `scan_hash ledger=${scan.claimed} actual=${scan.actual}`);
  assert.equal(scan.actual, evidence.scan_hash.replace(/^sha256:/, '').slice(0, 12));
  assert.equal(files.status, 'OK', `files ledger=${files.claimed} actual=${files.actual}`);
  assert.equal(files.actual, evidence.files_scanned, 'የተቃኙ ፋይሎች ብዛት ከሪፖርቱ ጋር እኩል');
  assert.equal(evidence.egress_findings.length, 0, 'የውጭ ጥያቄ (egress) ማገኛ 0 መሆን አለበት');
});

test('F-19፦ ሃሽ ቢቀየር መሣሪያው MISMATCH ይይዛል (የተሳሳተ ጥያኔ እንዳያልፍ)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-audit-'));
  const rels = [
    LEDGER,
    'evidence/offline-static-check.json',
    'evidence/g1-run-events.jsonl',
    'evidence/voice-check-om.json',
    'requirements/coverage-summary.json',
  ];
  for (const rel of rels) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(REPO, rel), join(dir, rel));
  }
  const ledger = readFileSync(join(dir, LEDGER), 'utf8');
  const good = /evidence\/voice-check-om\.json[\s`]*([0-9a-f]{12})(?![0-9a-f])/.exec(ledger);
  assert.ok(good, 'የምሳሌ ሃሽ ረድፍ በመዝገቡ ውስጥ ተገኘ');
  writeFileSync(join(dir, LEDGER), ledger.replace(good[1], '0'.repeat(12)), 'utf8');
  const report = auditLedgerEvidence(dir);
  const hit = report.results.find((r) => r.ref === 'evidence/voice-check-om.json');
  assert.equal(hit.status, 'MISMATCH', 'የተቀየረ ፋይልና የተሳሳተ ሃሽ ግዴታ ይይዛል');
  assert.ok(report.mismatch >= 1);
});

test('F-19 / CI-12፦ መዝገቡ ፋይል በቅርብ ስም ቢጠቅስም ሃሹ ይጣራል (§7 ረድፍ የተሳሳተ ሃሽ ደብቆ የነበረ)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-bare-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'requirements'), { recursive: true });
  cpSync(join(REPO, 'requirements/coverage-summary.json'), join(dir, 'requirements/coverage-summary.json'));
  const real = hashPath(dir, 'requirements/coverage-summary.json').slice(0, 12);
  writeFileSync(
    join(dir, LEDGER),
    `| F-19 | ማስረጃ \`coverage-summary.json\` (\`${real}\`) |\n| F-02 | ማስረጃ \`coverage-summary.json\` (aaaaaaaaaaaa) |\n`,
    'utf8',
  );
  const report = auditLedgerEvidence(dir);
  const bare = report.results.filter((r) => r.kind === 'bare_hash_pair');
  assert.equal(bare.length, 2, 'በሁለቱም ቅርብ-ስም ጥያኔዎች ላይ ወጥቷል');
  assert.equal(bare[0].status, 'OK', 'ትክክለኛ ቅርብ-ስም ጥያኔ OK ይሆናል');
  assert.match(bare[0].ref, /coverage-summary\.json/, 'የትኸከለው ፋይል መንገድ ግልጽ ነው');
  assert.equal(bare[1].status, 'MISMATCH', 'የተሳሳተ ቅርብ-ስም ጥያኔ መያዝ አለበት');
  assert.equal(bare[1].actual, real, 'ትክክለኛው ሃሽ ሪፖርቱ ላይ ይታያል');
});

test('F-19 / CI-12፦ የድር ገጽ (.html) ፋይል ሃሽ ጥያኔም ይጣራል — ያለፈው የመሣሪያ ዓይን ጉድለት', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-html-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'app/public'), { recursive: true });
  cpSync(join(REPO, 'app/public/index.html'), join(dir, 'app/public/index.html'));
  const real = hashPath(dir, 'app/public/index.html').slice(0, 12);
  writeFileSync(
    join(dir, LEDGER),
    `| F-08 | ገጹ \`app/public/index.html\` (\`${real}\`) የማይክ ደረጃ ያሳያል |\n| F-08 | ገጹ \`app/public/index.html\` (aaaaaaaaaaaa) |\n`,
    'utf8',
  );
  const report = auditLedgerEvidence(dir);
  const html = report.results.filter((r) => r.ref.endsWith('app/public/index.html'));
  assert.equal(html.length, 2, 'ሁለቱም የ.html ጥያኔዎች ተነበቡ (ደብቀው መቅረት የለባቸውም)');
  assert.equal(html[0].status, 'OK');
  assert.equal(html[1].status, 'MISMATCH', 'የተሳሳተ .html ሃሽ መያዝ አለበት');
});

test('F-19 / CI-12፦ CLI ቅጹ JSON ሪፖርት ይነብና ስህተት ሲያገኝ ወደ ትልቅ exit code ይሄዳል', () => {
  const good = spawnSync(process.execPath, [join(REPO, 'tools', 'verify-ledger-evidence.mjs')], { encoding: 'utf8' });
  assert.equal(good.status, 0, `ማስረጃ ጥያኔዎቹ ዛሬ ትክክል ናቸው (${JSON.stringify(good.stdout.slice(0, 300))})`);
  const parsed = JSON.parse(good.stdout);
  assert.equal(parsed.ledger, 'docs/OWNER_PROGRESS_LEDGER_v5_0_AM.md', 'የሚመረመረው መዝገብ በሪፖርቱ ላይ ግልጽ ነው');
  assert.match(parsed.method, /sha256/, 'የhash ዘዴው በሪፖርቱ ውስጥ ግልጽ ነው');
  assert.match(parsed.limitation, /node --test/, 'ያልተሸፈነው ክፍል (የፍተሻ ብዛት) በሪፖርቱ ተገልጿል');

  const dir = mkdtempSync(join(tmpdir(), 'ledger-audit-cli-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs/OWNER_PROGRESS_LEDGER_v5_0_AM.md'), 'evidence/g1-run-summary.json deadbeefcafe…\n', 'utf8');
  const bad = spawnSync(process.execPath, [join(REPO, 'tools', 'verify-ledger-evidence.mjs'), dir], { encoding: 'utf8' });
  assert.equal(bad.status, 1, 'የጎደለ/የተሳሳተ ማስረጃ ያለበት መዝገብ exit 1 ይመልሳል');
  const badReport = JSON.parse(bad.stdout);
  assert.equal(badReport.missing, 2, 'የጎደለ ማስረጃና የጎደለ የባለቤት መመሪያ ሁለቱም MISSING_FILE ይቆጠራሉ');
  assert.ok(
    badReport.results.some((r) => r.kind === 'guide_claim' && r.status === 'MISSING_FILE'),
    'የባለቤቱ መመሪያ መጥፋቱ ተለይቶ ይመዘገባል',
  );
  assert.ok(badReport.failures.length >= 1);
});

test('F-19፦ የመሣሪያው hash ዘዴ ለwav binary ፍሬም-ተኮር፣ ለሰነድ LF-ተኮር (CRLF ስህተት አይፈጥርም)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-hash-'));
  writeFileSync(join(dir, 'note.md'), 'አንድ ረድፍ\nሁለተኛ ረድፍ\n', 'utf8');
  const lf = hashPath(dir, 'note.md');
  writeFileSync(join(dir, 'note.md'), 'አንድ ረድፍ\r\nሁለተኛ ረድፍ\r\n', 'utf8');
  assert.equal(hashPath(dir, 'note.md'), lf, 'CRLF checkout ሃሽ አያዛባም');
  const wav = join(dir, 'clip.wav');
  writeFileSync(wav, Buffer.from([82, 73, 70, 70, 0, 0, 0, 1, 87, 65, 86, 69]));
  assert.match(hashPath(dir, 'clip.wav'), /^[0-9a-f]{64}$/, 'binary ፋይል ሃሽ በፍጹም ስርዓት ይሰላል');
});

// 8ኛ ዘር (ይህ ዙር በእውነተኛ ልኬት የተገኘ ጉድለት)፦ መዝገቡ §10 ላይ «N ማረጋገጫ / M ስህተት» ብሎ የበሩን የራሱ
// ውጤት ይገልጻል። ከላይ ያሉት 6 ዓይነቶች ይህን ብዛት ስላልመዘኑ «67» ሲል እውነተኛው 71 ለሦስት ዙር ተደብቆ ቆይቷል።
test('F-19 / CI-12፦ መዝገቡ ስለበሩ የራሱ ውጤት ብዛት የሚጽፈው ጥያኔ ከእውነተኛው ጋር ይዛመዳል', () => {
  const report = auditLedgerEvidence(REPO);
  const self = report.results.find((r) => r.kind === 'gate_self_count');
  assert.ok(self, 'የበር-የራሱ-ብዛት ፍተሻ መኖር አለበት');
  assert.equal(self.status, 'OK', `§10 ጥያኔ=${self.claimed} እውነተኛ=${self.actual}`);
  assert.equal(self.claimed, `${report.checked}/${report.failures.length}`, 'ጥያኔው የሪፖርቱን checked/failures ይደግማል');
});

test('F-19 / CI-12፦ የበር ብዛት ጥያኔ ቢቀር (ቁጥሩ ወደ ኋላ ከቀረ) MISMATCH ይይዛል', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-self-'));
  for (const rel of [LEDGER, 'evidence/offline-static-check.json', 'evidence/g1-run-events.jsonl', 'requirements/coverage-summary.json']) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(REPO, rel), join(dir, rel));
  }
  const ledger = readFileSync(join(dir, LEDGER), 'utf8');
  const claim = /(verify-ledger-evidence\.mjs[^\n]*?\()(\d+)( ማረጋገጫ\s*\/\s*\d+ ስህተት)/.exec(ledger);
  assert.ok(claim, 'የምሳሌ «የበር ውጤት ብዛት» ጥያኔ በመዝገቡ ውስጥ ተገኘ');
  const before = auditLedgerEvidence(dir);
  const row = before.results.find((r) => r.kind === 'gate_self_count');
  const stale = Number(row.claimed.split('/')[0]) - 1;
  writeFileSync(join(dir, LEDGER), ledger.replace(claim[0], `${claim[1]}${stale}${claim[3]}`), 'utf8');
  const after = auditLedgerEvidence(dir);
  const hit = after.results.find((r) => r.kind === 'gate_self_count');
  assert.equal(hit.claimed, `${stale}/${row.claimed.split('/')[1]}`, 'የተቀየረው የተጻፈው ቁጥር ብቻ ነው');
  assert.equal(hit.status, 'MISMATCH', `የቀነሰ ቁጥር (${stale}) ግዴታ ይይዛል — ቀደም ሲል አልተይዝም ነበር`);
  assert.equal(hit.actual, row.actual, 'እውነተኛው የበር ውጤት በጽሑፍ ለውጥ አልተነካም');
  assert.equal(Number(hit.actual.split('/')[0]), after.checked, 'የተጻፈው ቁጥር መከተል ያለበት የሪፖርቱን `checked` ነው');
});

test('F-19 / CI-12፦ መዝገቡ የበሩን ብዛት በጭራሽ ካልገለጸ CLAIM_NOT_FOUND ተመዝግቦ ይቆያል', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-self-missing-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, LEDGER), '| F-19 | መሣሪያ `tools/verify-ledger-evidence.mjs` ይሮጣል |\n', 'utf8');
  const report = auditLedgerEvidence(dir);
  const self = report.results.find((r) => r.kind === 'gate_self_count');
  assert.equal(self.status, 'CLAIM_NOT_FOUND', 'የለም የሚለውን በዝምታ አይተውልም');
  assert.ok(report.failures.some((r) => r.kind === 'gate_self_count'), 'ይህም ወደ exit 1 ይወስዳል');
});

// 9ኛ ዘር፦ የchurn ታሪክ ሲዘርዝር መዝገቡ «በcommit X ላይ ሃሹ Y ነበር» ይላል። መሣሪያው ይህን ከሕያው ጥያኔ
// ስላልለየው፣ የተሳሳተውንም (67/0) ከሚያስተካክለው ጋር ሁለት MISMATCH አድርጎ ቆጥሮት ነበር — a59bf4e73948።
test('F-19፦ የታሪክ ሃሽ ጥያኔ በራሱ በጠቀሰው commit በgit ተመዝኖ ይጣራል፣ ሕያው ጥያኔ ግን ደብቆ አያልፍም', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-hist-'));
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  assert.equal(git.status, 0, 'ይህ ፍተሻ git ይጠይቃል (ኮዱ የሚገኘው በgit ቅርንጫፍ ላይ ነው)');
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'tools/thing.mjs'), 'export const v = 1;\n', 'utf8');
  const oldHash = hashPath(dir, 'tools/thing.mjs').slice(0, 12);
  const init = spawnSync('git', ['-C', dir, 'init', '-q', '.'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  spawnSync('git', ['-C', dir, 'add', '.'], { encoding: 'utf8' });
  const commit = spawnSync(
    'git',
    ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed'],
    { encoding: 'utf8' },
  );
  assert.equal(commit.status, 0, commit.stderr);
  const rev = spawnSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

  // ፋይሉ ከተቀየረ በኋላ (ሕያው ዋጋው ለውጧል)፦
  writeFileSync(join(dir, 'tools/thing.mjs'), 'export const v = 2;\n', 'utf8');
  const liveNow = hashPath(dir, 'tools/thing.mjs').slice(0, 12);
  assert.notEqual(liveNow, oldHash, 'ሕያው ሃሽ ከታሪኩ መለየት አለበት');
  writeFileSync(
    join(dir, LEDGER),
    `| F-19 | ታሪክ፦ \`tools/thing.mjs\` \`${oldHash}\` በcommit \`${rev}\` ላይ |\n| F-19 | ሕያው፦ \`tools/thing.mjs\` \`${oldHash}\` |\n`,
    'utf8',
  );
  const report = auditLedgerEvidence(dir);
  const rows = report.results.filter((r) => r.kind === 'hash_pair');
  assert.equal(rows.length, 2, 'ሁለቱም ጥያኔዎች ተነበቡ');
  assert.equal(rows[0].status, 'OK_HISTORICAL', 'በተጠቀሰው commit ላይ በgit ተመዝኖ ትክክል ከሆነ ታሪክ ነው');
  assert.equal(rows[0].at_commit, rev, 'የትኸከለው commit በሪፖርቱ ላይ ግልጽ ነው');
  assert.equal(rows[1].status, 'MISMATCH', 'rev ያልተጠቀሰበት ተመሳሳይ ሃሽ እንደሕያው ጥያኔ ግዴታ ይይዛል');
  assert.equal(report.mismatch, 1, 'ታሪክ-ተመዝኝ ጥያኔ ወደ ስህተት ብዛት አይቆጠርም');
  assert.deepEqual(report.failures.filter((r) => r.kind === 'hash_pair').map((r) => r.status), ['MISMATCH'], 'ከhash ጥያኔዎች አንዱ ብቻ ይሰበራል');
  assert.equal(report.historical, 1, 'መንዝሩ የታሪክ-ተመዝኝ ጥያኔ ብዛት ይለያል');
});

// rev መጥቀስ ብቻ ማስረጃ አይደለም፦ ያለፈው ሙከራ በተመሳሳይ ረድፍ ላይ የነበረው የፋይል ሃሽ `8de6ed71532b` እንደcommit
// ተቆጥሮ «64 ማረጋገጫ/0» የሚለውን የታሪክ ቁጥር ሳይጨርስ አልፎት ነበር። አሁን በዚያው commit መሣሪያ ራሱ ይሮጣል።
test('F-19፦ የታሪክ «የበር ውጤት ቁጥር» በዚያው commit መሣሪያ ሩጫ ተመዝኖ ይጣራል፣ ሐሰተኛ rev ግን አያልፍም', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-rev-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  writeFileSync(
    join(dir, 'tools/verify-ledger-evidence.mjs'),
    "console.log(JSON.stringify({ checked: 3, failures: [{ status: 'MISMATCH' }] }));\n",
    'utf8',
  );
  spawnSync('git', ['-C', dir, 'init', '-q', '.'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'add', '.'], { encoding: 'utf8' });
  const commit = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed'], { encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);
  const rev = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(gateAtRev(dir, rev), '3/1', 'በዚያው commit ላይ የነበረው መሣሪያ ውጤቱ እንደገና ተነብቷል');
  assert.equal(gateAtRev(dir, '8de6ed71532b'), null, 'commit ያልሆነ rev (የፋይል ሃሽ) ለታሪክ-ማስረጃ አገልግሎት አይሰጥም');
  assert.equal(gateAtRev(dir, rev), '3/1', 'ማስታወሻ፦ ውጤቱ በcache ተደጋግሞ ተመሳሳይ ነው');
});

test('F-19 / VE-01፦ የgit archive tar ማንበብ በNode ብቻ ታሟል፣ ወደ ውጭ የሚወጣ መንገድ ግን ይከለከላል', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-tar-'));
  const archive = spawnSync('git', ['-C', REPO, 'archive', '--format=tar', 'HEAD'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  assert.equal(archive.status, 0, archive.stderr?.toString().slice(0, 200));
  const files = extractTar(archive.stdout, dir);
  assert.ok(files > 100, `የተወጡ ፋይሎች ብዛት (${files}) — ቅርንጫፉ ሙሉ ይዘጋል`);
  assert.equal(
    hashPath(dir, 'app/src/asr.mjs'),
    hashPath(REPO, 'app/src/asr.mjs'),
    'የተወጣው ቅጂ ከሥራ-ዛፌ ጋር ይዛመዳል (tar ማንበብ አልዛባም)',
  );
  const header = Buffer.alloc(512);
  header.write('../../evil.txt', 0, 'utf8');
  header.write('00000000100\0', 124, 'utf8');
  header[156] = 0x30;
  const evil = Buffer.concat([header, Buffer.alloc(512, 0x78)]);
  assert.throws(() => extractTar(evil, mkdtempSync(join(tmpdir(), 'ledger-tar-evil-'))), /\.\./, 'የመንገድ-መውጣት ሙከራ ይከለከላል');
});

// 10ኛ ዘር (ይህ ዙር የተገኘ)፦ የባለቤቱ መመሪያ (docs/G1_OWNER_INSTALL_AND_TEST_GUIDE_AM.md) የሚጽፋቸው ቁጥሮች
// (የፍተሻ፣ የናሙና፣ የእውቀት መዝገብ ክፍሎች፣ የዚህ በር ውጤት) በየትኛውም መሣሪያ አልተመዘኑም ነበሩ። መመሪያው የቆየ ቁጥር
// ቢይዝ ባለቤቱ የራሱን ትክክለኛ ሩጫ እንደ ስህተት ያያል።
const GUIDE = 'docs/G1_OWNER_INSTALL_AND_TEST_GUIDE_AM.md';

function guideFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-guide-'));
  const copy = (rel) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(REPO, rel), join(dir, rel), { recursive: true });
  };
  copy(LEDGER);
  copy(GUIDE);
  copy('data/knowledge/entries.json');
  copy('data/updates/samples');
  copy('tests/fixtures/updates');
  copy('requirements/coverage-summary.json');
  copy('evidence/offline-static-check.json');
  copy('evidence/g1-run-events.jsonl');
  mkdirSync(join(dir, 'tests'), { recursive: true });
  for (const f of readdirSync(join(REPO, 'tests')).filter((f) => f.endsWith('.test.mjs'))) {
    cpSync(join(REPO, 'tests', f), join(dir, 'tests', f));
  }
  return dir;
}

test('F-19 / CI-12፦ የባለቤት መመሪያው የፍተሻ/የናሙና/የእውቀት/የበር ቁጥሮች ከእውነተኛው ጋር ይዛመዳሉ', () => {
  const report = auditLedgerEvidence(REPO);
  const guide = report.results.filter((r) => String(r.kind).startsWith('guide_'));
  const kinds = guide.map((r) => r.kind);
  assert.ok(kinds.includes('guide_test_count'), 'የፍተሻ ብዛት ጥያኔ ተነብቦ መጣራት አለበት');
  assert.ok(kinds.includes('guide_sample_count'), 'የናሙና ብዛት ጥያኔ ተነብቦ መጣራት አለበት');
  assert.ok(kinds.includes('guide_kb_count'), 'የእውቀት መዝገብ ብዛት ጥያኔ ተነብቦ መጣራት አለበት');
  assert.ok(kinds.includes('guide_gate_count'), 'የበር ብዛት ጥያኔ ተነብቦ መጣራት አለበት');
  for (const r of guide) assert.equal(r.status, 'OK', `${r.kind} ጥያኔ=${r.claimed} እውነተኛ=${r.actual}`);
  assert.ok(guide.length >= 5, `ብዙ ጥያኔዎች ተጣርተዋል (${guide.length})`);
});

test('F-19 / CI-12፦ የመመሪያው የፍተሻና የናሙና ቁጥር ቢቀየር MISMATCH ይይዛል', () => {
  const dir = guideFixture();
  const original = readFileSync(join(dir, GUIDE), 'utf8');

  const testClaim = /\*\*(\d+)\/(\d+) (?:ያልፋሉ|ተመዝግበዋል)\*\*/.exec(original);
  assert.ok(testClaim, 'የፍተሻ ቁጥር ረድፍ በመመሪያው ውስጥ ተገኝቷል');
  const staleClaim = `${Number(testClaim[1]) - 1}/${testClaim[2]}`;
  const staleTests = original.replace(testClaim[0], `**${staleClaim} ያልፋሉ**`);
  assert.notEqual(staleTests, original, 'የፍተሻ ቁጥር ረድፍ በመመሪያው ውስጥ ተገኝቷል');
  writeFileSync(join(dir, GUIDE), staleTests, 'utf8');
  const rows = auditLedgerEvidence(dir).results.filter((r) => r.kind === 'guide_test_count');
  assert.ok(rows.some((r) => r.status === 'MISMATCH' && r.claimed === staleClaim), 'የተቀነሰ የፍተሻ ቁጥር መያዝ አለበት');
  assert.ok(rows.some((r) => r.status === 'OK'), 'ሌላው ትክክለኛ ጥያኔ እንዳለ ይቆያል');

  const staleSamples = original.replace('12 የፍተሻ', '11 የፍተሻ');
  assert.notEqual(staleSamples, original, 'የናሙና ቁጥር ረድፍ በመመሪያው ውስጥ ተገኝቷል');
  writeFileSync(join(dir, GUIDE), staleSamples, 'utf8');
  const s = auditLedgerEvidence(dir).results.find((r) => r.kind === 'guide_sample_count');
  assert.equal(s.status, 'MISMATCH', `የተሳሳተ የናሙና ቁጥር (${s.claimed} vs ${s.actual}) መያዝ አለበት`);
});

test('F-19 / CI-12፦ የመመሪያው የበር ቁጥር ትክክል ሲሆን OK፣ ቢቀየር ግን MISMATCH (ራሱን አያጽድቅም)', () => {
  const dir = guideFixture();
  const original = readFileSync(join(dir, GUIDE), 'utf8');
  const first = auditLedgerEvidence(dir).results.find((r) => r.kind === 'guide_gate_count');
  assert.ok(first, 'የመመሪያው የበር ቁጥር ተነብቧል');
  const fixed = original.replace(/\*\*\d+\/\d+\*\* ይዛመዳሉ/, `**${first.actual}** ይዛመዳሉ`);
  writeFileSync(join(dir, GUIDE), fixed, 'utf8');
  const correct = auditLedgerEvidence(dir).results.find((r) => r.kind === 'guide_gate_count');
  assert.equal(correct.status, 'OK', `የተስተካከለው ቁጥር (${correct.claimed}) መመዘን አለበት`);

  const [checked, ok] = correct.claimed.split('/').map(Number);
  const stale = original.replace(/\*\*\d+\/\d+\*\* ይዛመዳሉ/, `**${checked}/${ok - 2}** ይዛመዳሉ`);
  writeFileSync(join(dir, GUIDE), stale, 'utf8');
  const hit = auditLedgerEvidence(dir).results.find((r) => r.kind === 'guide_gate_count');
  assert.equal(hit.claimed, `${checked}/${ok - 2}`, 'የተቀየረው ቁጥር ተነብቧል');
  assert.equal(hit.status, 'MISMATCH', `የቆየ የበር ቁጥር (${hit.claimed} vs ${hit.actual}) መያዝ አለበት`);
});

test('F-19፦ የባለቤት መመሪያው ጠፍቶ ካለ ወደ exit 1 የሚወስድ MISSING_FILE ይመዘገባል', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-no-guide-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, LEDGER), '| F-19 | መሣሪያ ይሮጣል |\n', 'utf8');
  const report = auditLedgerEvidence(dir);
  const hit = report.results.find((r) => r.kind === 'guide_claim');
  assert.ok(hit, 'የጎደለ መመሪያ ግልጽ ሪከርድ ይኖረዋል');
  assert.equal(hit.status, 'MISSING_FILE');
  assert.ok(report.failures.some((r) => r.kind === 'guide_claim'));
});
