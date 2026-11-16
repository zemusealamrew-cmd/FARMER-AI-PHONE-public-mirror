// F-06 / R-38 / CI-12፦ የደህንነት ማስታወሻዎች (docs/) ዝርዝርና hash ተጠብቀው መቆየት አለባቸው።
// የF-06 ሥር፦ CRLF/LF ልዩነት ሁሉንም ፋይሎች "ተቀይረዋል" ያደርጋል — ስለዚህ hash በLF መሠረት ይሰላል።
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docsFiles, hashFileLf, lfNormalize } from '../tools/make-manifest.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verify = () => spawnSync(process.execPath, [join(REPO, 'tools', 'verify-manifest.mjs')], { encoding: 'utf8' });

test('F-06፦ LF-normalized hash የረድፍ መበስበስ ለውጥን አይቆጥርም (CRLF ወደ LF ቢቀየር አንድ ነው)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farmermanifest-'));
  const lf = join(dir, 'note-lf.md');
  const crlf = join(dir, 'note-crlf.md');
  writeFileSync(lf, '# ማስታወሻ\r\nተከላከይ መርሆ\r\n', 'utf8');
  writeFileSync(crlf, '# ማስታወሻ\nተከላከይ መርሆ\n', 'utf8');
  assert.equal(lfNormalize(readFileSync(lf, 'utf8')), readFileSync(crlf, 'utf8'), 'normalization CRLFን ወደ LF ይቀይራል');
  assert.equal(hashFileLf(lf), hashFileLf(crlf), 'የCRLF checkout የተሳሳተ ማስታወሻ አልሰጠም');
});

test('F-06 / R-38፦ ማኒፌስቱ ለውጥን ይይዛል፣ የተቀየረ ሰነድ MISMATCH ይሆናል', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farmermanifest2-'));
  const doc = join(dir, 'policy.md');
  writeFileSync(doc, 'መሠረታዊ መርሆ፦ አንድ ስልክ።\n', 'utf8');
  const before = hashFileLf(doc);
  writeFileSync(doc, 'መሠረታዊ መርሆ፦ ሁለት ስልኮች።\n', 'utf8');
  assert.notEqual(hashFileLf(doc), before, 'የይዘት ለውጥ ግዴታ ይታወቃል');
});

test('F-06 / CI-12፦ ማኒፌስቱ ዛሬ ተሞክሮ ያልፋል — ሁሉም docs/*.md ተካተዋል፣ ምንም አልተቀየረም', () => {
  const r = verify();
  const report = JSON.parse(r.stdout);
  assert.equal(r.status, 0, `mismatch=${report.mismatch} missing=${report.missing} unlisted=${report.unlisted_docs.length}`);
  assert.equal(report.mismatch, 0);
  assert.equal(report.missing, 0);
  assert.deepEqual(report.unlisted_docs, [], 'አዲስ ሰነድ በማኒፌስት ውስጥ ሳይገባ አይቀርም');
  assert.equal(report.total, docsFiles().length, 'የተካተቱት ብዛት ከሰነዶች ብዛት ጋር ይዛመዳል');
  assert.ok(report.total >= 17, `የሰነድ ዝርዝር ሙሉ ነው (${report.total})`);
});

test('F-06፦ ማኒፌስቱ ራሱን አይደግፍም (ኡድን-ወጪ ማስረጃ) እና በተረጋገጠ ዘዴ ይገለጻል', () => {
  const manifest = readFileSync(join(REPO, 'docs', 'FILE_MANIFEST_SHA256.txt'), 'utf8');
  assert.ok(!manifest.includes('FILE_MANIFEST_SHA256.txt  '), 'ማኒፌስቱ የራሱ hash አያስገባም');
  assert.match(manifest, /CRLF/, 'የhash ዘዴው በፋይሉ ራሱ ላይ ተገልጿል');
  assert.match(manifest, /^[0-9a-f]{64} {2}\S+\.md$/m, 'ዝርዝሩ hash␣␣ፋይል ቅርጽ አለው');
});
