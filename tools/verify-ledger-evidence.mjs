// F-19 / F-22 / CI-12፦ መዝገቡ (§7/§10) የሚገልጻቸው የማስረጃ ሃሾችና ቁጥሮች በትክክል ከተከማቹ ፋይሎች ጋር
// እንደሚዛመዱ ያረጋግጣል። ቀደም ሲል «የይዘት ሃሽ ተመሳሳይ ነው» የሚል ጥያኔ የተሳሳተ (የታገደ) መሆኑ በእጅ
// ማንበብ ብቻ አልታየም — ስለዚህ ልኬቱ ኮድ ሆኖ ተቀምጧል።
// ዘዴ፦ ሰነድ/ኮድ/JSON ሃሽ በLF መሠረት (make-manifest ልክ)፣ binary (wav) ሃሽ በፋይሉ ጥሬ ክፍሎች።
// ማስታወሻ (churn)፦ የoffline `scan_hash` የሚለካው በተቃኙት ምርት/tools ፋይሎች ይዘም ላይ ስለሆነ፣ አንድ
// የምርት ፋይል በየተቀየረ መዝገቡ ያው ቁጥር ማሻሻል አለበት — የማኒፌስት ደንብ እንደሆነ።
// ሁለት ተጨማሪ ደንቦች (2026-11-06)፦ (1) መዝገቡ «የበር ውጤት ብዛት» (N ማረጋገጫ / M ስህተት) ሲገልጽ ቁጥሩ
// ከበሩ እውነተኛ ውጤት ጋር ይዛመዳል፤ (2) የታሪክ ሃሽ ጥያኔ በራሱ የጠቀሰው commit በgit ተመዝኖ ይጣራል።
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFileLf } from './make-manifest.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = 'docs/OWNER_PROGRESS_LEDGER_v5_0_AM.md';
const GUIDE = 'docs/G1_OWNER_INSTALL_AND_TEST_GUIDE_AM.md';
const TEXT_EXT = /\.(?:md|mjs|js|json|jsonl|yaml|yml|txt|html)$/;

// path + 12-አሃዝ ሃሽ በአጠገብ ሲገኙ ብቻ ይዛመዳሉ። 16-አሃዝ የasset ሃሽ አይተነካም፦
// `(?<![0-9a-f])` የ16ኛው ቁልፍ ጭራ እንደ12 አይቆጠርም።
const HASH_PAIR = /((?:app|data|docs|evidence|requirements|tests|tools)\/[A-Za-z0-9._/-]+\.(?:json|jsonl|mjs|wav|md|txt|html))[\s`[(`]*\[?`?((?<![0-9a-f])[0-9a-f]{12})(?![0-9a-f])/g;
// መዝገቡ ፋይል በሙሉ መንገድ ሳይሆን በቅርብ ስም ብቻ ሲጠቅስ፦ F-19 ረድፍ ላይ `coverage-summary.json`
// የተባለው ሃሽ የታገደ ሆኖ መሣሪያው አላየውም — ስም+ሃሽ አሁን ከሪፖው ዝርዝር ጋር ተዛምዶ ይጣራል።
const BARE_HASH_PAIR = /(?:[^A-Za-z0-9._/-]|^)([A-Za-z0-9._-]+\.(?:json|jsonl|mjs|wav|md|txt))[\s`[(`]*\[?`?((?<![0-9a-f])[0-9a-f]{12})(?![0-9a-f])/g;
const INDEX_SKIP = new Set(['.git', '.tmp', 'node_modules', 'bin', 'models', 'private', 'updates']);

// OK_HISTORICAL = «በተጠቀሰው commit ላይ እውነት ነበር» በgit ተመዝኖ የተገኘ — ስህተት አይደለም።
export function isFailure(result) {
  return result.status !== 'OK' && result.status !== 'OK_HISTORICAL';
}

// git rev:path → የblob ሃሽ (ሥራ-ዛፌ/working tree ማንበብ አያስፈልግም)። rev ወይም path ካልተገኘ null።
function gitBlobHash(root, rel, rev) {
  const run = spawnSync('git', ['-C', root, 'show', `${rev}:${rel}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) return null;
  return TEXT_EXT.test(rel)
    ? createHash('sha256').update(run.stdout.toString('utf8').replace(/\r\n/g, '\n')).digest('hex')
    : createHash('sha256').update(run.stdout).digest('hex');
}

// በጥያኔው (hash + ቁጥር) በኋላ በተመሳሳይ ረድፍ ላይ ያሉ commit rev ተምሳሰልቶች (7–40 አሃዝ)።
function revsAfter(text, matchIndex, matchLength) {
  const lineEnd = text.indexOf('\n', matchIndex);
  const tail = text.slice(matchIndex + matchLength, lineEnd < 0 ? text.length : lineEnd);
  return [...tail.matchAll(/(?<![0-9a-f])([0-9a-f]{7,40})(?![0-9a-f])/g)].map((m) => m[1]);
}

export function hashPath(root, rel) {
  const path = join(root, rel);
  return TEXT_EXT.test(rel)
    ? hashFileLf(path)
    : createHash('sha256').update(readFileSync(path)).digest('hex');
}

// --- የታሪክ «የበር ውጤት ብዛት» ጥያኔ እንደገና ማረጋገጫ ---
// rev መጥቀስ ብቻ በቂ አይደለም፦ በአንድ ሙከራ ላይ በተመሳሳይ ረድፍ የነበረው የፋይል ሃሽ `8de6ed71532b` እንደrev
// ተቆጥሮ የታሪክ ቁጥር ሳይረጋገጥ አልፎ ነበር። ስለዚህ በዚያው commit ላይ ያለው መሣሪያ በራሱ ይሮጣል፦
// `git archive <rev>` → tar በNode ብቻ ተነብሎ ወደ ግምት-ዛፌ → `node <dir>/tools/verify-ledger-evidence.mjs <dir>`።
// ውጤቱ ከጥያኔው ጋር ከተዛመደ OK_HISTORICAL፤ ካልተዛመደ ወይም rev ካልተገኘ MISMATCH ሆኖ ይቆያል።
function tarString(block, offset, length) {
  const end = block.indexOf(0, offset);
  const stop = end < 0 || end > offset + length ? offset + length : end;
  return block.subarray(offset, stop).toString('utf8');
}

export function extractTar(buf, dir) {
  let pos = 0;
  let longName = null;
  let files = 0;
  while (pos + 512 <= buf.length) {
    const header = buf.subarray(pos, pos + 512);
    if (header[0] === 0) break;
    const size = Number.parseInt(tarString(header, 124, 12).trim(), 8) || 0;
    const type = String.fromCharCode(header[156] || 0x30);
    let name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const payload = buf.subarray(pos + 512, pos + 512 + size);
    pos += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = payload.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }
    if (type !== '0' && type !== '5' && type !== '\0') continue;
    if (type === '5') {
      mkdirSync(join(dir, name), { recursive: true });
      continue;
    }
    if (name.includes('..') || /^([A-Za-z]:|[\\/])/.test(name)) {
      throw new Error(`archive ውስጥ ያለው መንገድ ወደ ውጭ ይወጣል፦ ${name}`);
    }
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, payload);
    files += 1;
  }
  return files;
}

const revGateCache = new Map();

export function gateAtRev(root, rev) {
  const key = `${root}::${rev}`;
  if (revGateCache.has(key)) return revGateCache.get(key);
  let outcome = null;
  const archive = spawnSync('git', ['-C', root, 'archive', '--format=tar', rev], { encoding: 'buffer', maxBuffer: 1 << 26 });
  if (archive.status === 0) {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-gate-'));
    let report = null;
    try {
      extractTar(archive.stdout, dir);
      const tool = join(dir, 'tools', 'verify-ledger-evidence.mjs');
      if (existsSync(tool)) {
        const run = spawnSync(process.execPath, [tool, dir], { encoding: 'utf8', maxBuffer: 1 << 26 });
        if (run.status === 0 || run.status === 1) report = JSON.parse(run.stdout);
      }
    } catch {
      report = null;
    } finally {
      // ማጽጃው ስህተት ቢሰነዝርም (Windows EBUSY) የተገኘው ውጤት አጥፋ አይደለም፤ ይህ ቀደም ሲል null አድርጎት ነበር።
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ግምት-ዛፌ መቅረት ይችላል */
      }
    }
    if (report) outcome = `${report.checked}/${report.failures.length}`;
  }
  revGateCache.set(key, outcome);
  return outcome;
}

// ቅርብ ስም ያለው ጥያኔ ከትክክለኛው ፋይል ጋር እንዲዛመድ የሪፖውን ዝርዝር ያነጣል። ያልተጠቀሰ ስም
// MISSING_FILE ይሆናል — መዝገብ ያለማስረጃ ሃሽ ማቅረብ እንደጉድለት ይቆጠራል።
export function indexByBasename(root) {
  const index = new Map();
  const add = (rel, name) => {
    if (!index.has(name)) index.set(name, []);
    index.get(name).push(rel);
  };
  const walk = (dir, relDir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!INDEX_SKIP.has(entry.name)) walk(join(dir, entry.name), `${relDir}${entry.name}/`);
      } else if (/\.(json|jsonl|mjs|wav|md|txt)$/.test(entry.name)) {
        add(`${relDir}${entry.name}`, entry.name);
      }
    }
  };
  walk(root, '');
  return index;
}

export function auditLedgerEvidence(root = REPO) {
  const ledgerPath = join(root, LEDGER);
  if (!existsSync(ledgerPath)) return { ledger: LEDGER, error: 'LEDGER_MISSING', results: [] };
  const ledger = readFileSync(ledgerPath, 'utf8');

  const results = [];
  // path + ሃሽ ጥያኔዎች። ከሥጣ MISMATCH የሚወጣው ሁለት ዓይነት ናቸው፦ (1) ሕያው ጥያኔ የተሳሳተ፣ (2) የታሪክ
  // ማስታወሻ («በ`<commit>` ላይ ዋጋው X ነበር») — መዝገቡ የchurn ታሪክ ሲዘርዝር ሁለተኛው ይከሰታልና በጊዜው በትክክል
  // ቢሆንም ፋይሉ ሲቀየር ሁሉ ስህተት ሆኖ ይደመደመረ ነበር (a59bf4e73948፣ ይህ ዙር)። አሁን ሁለተኛው በgit
  // ይለየዋል፦ በሃሹ በኋላ በተመሳሳይ ረድፍ ላይ የተጠቀሰ commit ይህን ይዘም ከያዘ OK_HISTORICAL፤ rev ካልተገኘ
  // ወይም ካልተዛመደ MISMATCH ሆኖ ይቆያል — ደብቆ አያልፍም።
  for (const match of ledger.matchAll(HASH_PAIR)) {
    const [, rel, claimed] = match;
    const path = join(root, rel);
    if (!existsSync(path)) {
      results.push({ kind: 'hash_pair', ref: rel, claimed, status: 'MISSING_FILE' });
      continue;
    }
    let actual;
    try {
      actual = hashPath(root, rel);
    } catch (error) {
      results.push({ kind: 'hash_pair', ref: rel, claimed, status: 'UNREADABLE', note: error.message });
      continue;
    }
    if (actual.startsWith(claimed)) {
      results.push({ kind: 'hash_pair', ref: rel, claimed, actual: actual.slice(0, 12), status: 'OK' });
      continue;
    }
    const rev = revsAfter(ledger, match.index, match[0].length).find(
      (r) => gitBlobHash(root, rel, r)?.startsWith(claimed),
    );
    results.push({
      kind: 'hash_pair',
      ref: rel,
      claimed,
      actual: actual.slice(0, 12),
      status: rev ? 'OK_HISTORICAL' : 'MISMATCH',
      ...(rev ? { at_commit: rev } : {}),
    });
  }

  // ቅርብ ስም ጥያኔዎች (F-19 ረድፍ)፦ ተመሳሳይ ፋይል በሁለም መንገድ ሲጠቀስ ሁለቱም ጥያኔዎች ግዴታ ይጣራሉ
  // (§7 ረድፉ የታገደ፣ §10 ትክክል የነበረው ችግር እንዲህ ነው የደበቀው)።
  const index = indexByBasename(root);
  for (const match of ledger.matchAll(BARE_HASH_PAIR)) {
    const [, name, claimed] = match;
    const candidates = index.get(name) ?? [];
    if (candidates.length === 0) {
      results.push({ kind: 'bare_hash_pair', ref: name, claimed, status: 'MISSING_FILE' });
      continue;
    }
    const checked = candidates.map((rel) => {
      try {
        return { rel, hash: hashPath(root, rel).slice(0, 12) };
      } catch {
        return { rel, hash: 'UNREADABLE' };
      }
    });
    const hit = checked.find((c) => c.hash === claimed);
    if (hit) {
      results.push({
        kind: 'bare_hash_pair',
        ref: `${name} → ${hit.rel}`,
        claimed,
        actual: hit.hash,
        status: 'OK',
      });
      continue;
    }
    const rev = revsAfter(ledger, match.index, match[0].length).find((r) =>
      checked.some((c) => gitBlobHash(root, c.rel, r)?.startsWith(claimed)),
    );
    results.push({
      kind: 'bare_hash_pair',
      ref: `${name} (${candidates.join(', ')})`,
      claimed,
      actual: checked.map((c) => c.hash).join('/'),
      status: rev ? 'OK_HISTORICAL' : 'MISMATCH',
      ...(rev ? { at_commit: rev } : {}),
    });
  }

  // offline-static-check፦ የተመዘገበው «የይዘት ሃሽ» የፋይሉ ሃሽ ሳይሆን የራሱው `scan_hash` መስክ ነው፤
  // የተቃኙ ፋይሎች ብዛትም ከሪፖርቱ ጋር ግዴታ እኩል መሆን አለበት። መዝገቡ ፋይሉን በሁለት ቦታ (§7 F-22ና §10) ስለሚጠቅስ
  // **እያንዳንዱ** ረድፍ ይጣራል — አንዱ ትክክል ሌላኛው የታገደ ሊሆን አይችልም።
  const offlineLines = ledger
    .split(/\r?\n/)
    .map((l, i) => ({ l, no: i + 1 }))
    .filter(({ l }) => l.includes('evidence/offline-static-check.json') && /[0-9a-f]{12}/.test(l) && /ፋይል/.test(l));
  if (offlineLines.length > 0) {
    const report = JSON.parse(readFileSync(join(root, 'evidence/offline-static-check.json'), 'utf8'));
    const scan = String(report.scan_hash).replace(/^sha256:/, '').slice(0, 12);
    for (const { l, no } of offlineLines) {
      const offlineClaim = /([0-9a-f]{12})(?![0-9a-f])[\s\S]*?(\d+) ፋይል/.exec(l);
      const ref = `evidence/offline-static-check.json §L${no}`;
      results.push({
        kind: 'offline_scan_hash',
        ref,
        claimed: offlineClaim[1],
        actual: scan,
        status: offlineClaim[1] === scan ? 'OK' : 'MISMATCH',
      });
      results.push({
        kind: 'offline_files_scanned',
        ref,
        claimed: Number(offlineClaim[2]),
        actual: report.files_scanned,
        status: Number(offlineClaim[2]) === report.files_scanned ? 'OK' : 'MISMATCH',
      });
      const egressClaim = /egress_findings[^\d]*(\d+)/.exec(l);
      if (egressClaim) {
        results.push({
          kind: 'offline_egress',
          ref,
          claimed: Number(egressClaim[1]),
          actual: report.egress_findings.length,
          status: Number(egressClaim[1]) === report.egress_findings.length ? 'OK' : 'MISMATCH',
        });
      }
    }
  } else {
    results.push({ kind: 'offline_scan_hash', ref: 'evidence/offline-static-check.json', status: 'CLAIM_NOT_FOUND' });
  }

  const eventsClaim = /evidence\/g1-run-events\.jsonl\s+`?[0-9a-f]{12}…?\s*\((\d+) ክስተት/.exec(ledger);
  if (eventsClaim) {
    const n = readFileSync(join(root, 'evidence/g1-run-events.jsonl'), 'utf8').trim().split(/\r?\n/).length;
    results.push({
      kind: 'event_count',
      ref: 'evidence/g1-run-events.jsonl',
      claimed: Number(eventsClaim[1]),
      actual: n,
      status: Number(eventsClaim[1]) === n ? 'OK' : 'MISMATCH',
    });
  } else {
    results.push({ kind: 'event_count', ref: 'evidence/g1-run-events.jsonl', status: 'CLAIM_NOT_FOUND' });
  }

  const covClaim = /requirements\/coverage-summary\.json\s+`?[0-9a-f]{12}…?\s*\((\d+) መስፈርት፣ (\d+) መለያ፣ (\d+) በፍተሻ/.exec(ledger);
  if (covClaim) {
    const cov = JSON.parse(readFileSync(join(root, 'requirements/coverage-summary.json'), 'utf8'));
    const actual = [cov.requirement_count, cov.total_entries, cov.covered_by_executed_test];
    const claimed = covClaim.slice(1, 4).map(Number);
    results.push({
      kind: 'coverage_numbers',
      ref: 'requirements/coverage-summary.json',
      claimed: claimed.join('/'),
      actual: actual.join('/'),
      status: claimed.join('/') === actual.join('/') ? 'OK' : 'MISMATCH',
    });
  } else {
    results.push({ kind: 'coverage_numbers', ref: 'requirements/coverage-summary.json', status: 'CLAIM_NOT_FOUND' });
  }

  // 8ኛ ዘር (2026-11-06)፦ የባለቤት መመሪያው (docs/G1_OWNER_INSTALL_AND_TEST_GUIDE_AM.md) የሚጽፋቸው ቁጥሮች
  // በማንም መሣሪያ አልተመዘኑም ነበር። ፍተሻ ቢጨመር መመሪያው «197/197» ሆኖ ቢቀር ባለቤቱ የራሱን 198 ሩጫ
  // እንደ ስህተት ያያል፤ የበር ቁጥሩም ራሱን ስለሚዘጋ በመመሪያው ላይ ወደ ኋላ ሊቀር ይችላል። ስለዚህ መመሪያው
  // የሚጠቅሳቸው ብዛቶች (የፍተሻ፣ የናሙና፣ የእውቀት መዝገብ ክፍሎችና የዚህ በር ውጤት) ከእውነተኛው ጋር ይጣጣማሉ።
  let guideText = null;
  if (!existsSync(join(root, GUIDE))) {
    results.push({ kind: 'guide_claim', ref: GUIDE, status: 'MISSING_FILE' });
  } else {
    guideText = readFileSync(join(root, GUIDE), 'utf8');
    const testFiles = readdirSync(join(root, 'tests')).filter((f) => f.endsWith('.test.mjs'));
    const staticTests = testFiles.reduce(
      (n, f) => n + (readFileSync(join(root, 'tests', f), 'utf8').match(/^[ \t]*test\(/gm) ?? []).length,
      0,
    );
    const testClaims = [
      ...guideText.matchAll(/ፍተሻዎች፦\s*\*\*(\d+)\/(\d+) (?:ያልፋሉ|ተመዝግበዋል)/g),
      ...guideText.matchAll(/ፍተሻዎች (\d+)\/(\d+) \|/g),
    ];
    if (testClaims.length === 0) {
      results.push({ kind: 'guide_test_count', ref: GUIDE, status: 'CLAIM_NOT_FOUND' });
    }
    for (const m of testClaims) {
      results.push({
        kind: 'guide_test_count',
        ref: `${GUIDE} «${m[0].replace(/\*\*/g, '').trim()}»`,
        claimed: `${m[1]}/${m[2]}`,
        actual: `${staticTests}/${staticTests}`,
        status: Number(m[1]) === staticTests && Number(m[2]) === staticTests ? 'OK' : 'MISMATCH',
      });
    }
    // የናሙና ብዛት የሚቆጠረው በምርቱ ውስጥ እንደሚታየው ነው (`app/server.mjs::listUpdateSamples` — `update_id` ያላቸው
    // የJSON ቅጠሎች ብቻ፣ MANIFEST.json አይቆጠርም)።
    const countSamples = (rel) => {
      const dir = join(root, rel);
      if (!existsSync(dir)) return 0;
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json') && f !== 'MANIFEST.json')
        .filter((f) => {
          try {
            return Boolean(JSON.parse(readFileSync(join(dir, f), 'utf8')).update_id);
          } catch {
            return false;
          }
        }).length;
    };
    const sampleClaim = /(\d+) ናሙናዎች፦ (\d+) የማሳያ \+ (\d+) የፍተሻ/.exec(guideText);
    if (!sampleClaim) {
      results.push({ kind: 'guide_sample_count', ref: GUIDE, status: 'CLAIM_NOT_FOUND' });
    } else {
      const demo = countSamples('data/updates/samples');
      const fixtures = countSamples('tests/fixtures/updates');
      const [total, demoClaim, fixtureClaim] = sampleClaim.slice(1, 4).map(Number);
      results.push({
        kind: 'guide_sample_count',
        ref: `${GUIDE} «${sampleClaim[0]}»`,
        claimed: `${total} = ${demoClaim} + ${fixtureClaim}`,
        actual: `${demo + fixtures} = ${demo} + ${fixtures}`,
        status: total === demo + fixtures && demoClaim === demo && fixtureClaim === fixtures ? 'OK' : 'MISMATCH',
      });
    }
    const kbClaim = /መዝገቡ \*\*(\d+) የናሙና ክፍሎች\*\*/.exec(guideText);
    if (!kbClaim) {
      results.push({ kind: 'guide_kb_count', ref: GUIDE, status: 'CLAIM_NOT_FOUND' });
    } else {
      const entries = JSON.parse(readFileSync(join(root, 'data/knowledge/entries.json'), 'utf8'));
      const n = Array.isArray(entries) ? entries.length : (entries.entries?.length ?? 0);
      results.push({
        kind: 'guide_kb_count',
        ref: `${GUIDE} «${kbClaim[0]}»`,
        claimed: Number(kbClaim[1]),
        actual: n,
        status: Number(kbClaim[1]) === n ? 'OK' : 'MISMATCH',
      });
    }
  }

  // 7ኛ ዘር (በ2026-11-06 ዙር በእውነተኛ ልኬት የተገኘ)፦ መዝገቡ «N ማረጋገጫ / M ስህተት» ብሎ የበሩን የራሱ ውጤት
  // ሲገልጽ ቁጥሩ ወደ ኋላ ሊቀር ይችላል። ከላይ ያሉት 6 ዓይነቶች የበሩን ብዛት ስለማይመዝኑ «67» ሲል እውነተኛው 71 ሆኖ
  // ለሦስት ዙር አልተይዝም ነበር። እያንዳንዱ ጥያኔ ይጣራል (first-match ብቻ ካነበብን §11 «64» ደብቆ ይቆይ ነበር —
  // ከቅርብ-ስም/.html ጉድለት ጋር ተመሳሳይ ዓይነት)። ዛሬው ቁጥር ካልሆነ ጥያኔው የታሪክ መሆኑን በcommit rev መናገር
  // አለበት፤ ያለ rev MISMATCH። የታሪክ ቁጥር በዚያው commit ያለው መሣሪያ እንደገና ሊረጋገጥ ይችላል፦
  // `git archive <rev> | tar -x -C <dir>` ከዚያ `node <dir>/tools/verify-ledger-evidence.mjs <dir>`
  // (በ2026-11-06 ዙር ለ`63a8a78` እንዲህ ተርጎ 64/0 exit 0 ተመዝግቧል)።
  const selfClaims = [];
  ledger.split(/\r?\n/).forEach((l, i) => {
    for (const m of l.matchAll(/verify-ledger-evidence\.mjs[^\n]*?\((\d+) ማረጋገጫ\s*\/\s*(\d+) ስህተት/g)) {
      selfClaims.push({
        kind: 'gate_self_count',
        format: 'ledger',
        ref: `መዝገብ §L${i + 1} «የበር ውጤት ብዛት» ጥያኔ`,
        claimed: `${m[1]}/${m[2]}`,
        revs: revsAfter(l, m.index, m[0].length).slice(0, 3),
      });
    }
  });
  if (selfClaims.length === 0) {
    results.push({ kind: 'gate_self_count', ref: 'መዝገብ «የበር ውጤት ብዛት» ጥያኔ', status: 'CLAIM_NOT_FOUND' });
  }
  // የመመሪያው የበር-ብዛት ጥያኔ (`79/79`) የተለየ ቅርጽ አለው — checked/ok፣ የመዝገቡ checked/failures አይደለም።
  // ሁለቱም ራሳቸውን ስለሚዘጉ (እያንዳንዱ ጥያኔ ወደ `checked` ይጨመራል) በአንድ fixed-point ስሌት ይመዘናሉ።
  const guideGateClaim = guideText ? /\*\*(\d+)\/(\d+)\*\* ይዛመዳሉ/.exec(guideText) : null;
  if (guideText && !guideGateClaim) {
    results.push({ kind: 'guide_gate_count', ref: GUIDE, status: 'CLAIM_NOT_FOUND' });
  }
  if (guideGateClaim) {
    selfClaims.push({
      kind: 'guide_gate_count',
      format: 'guide',
      ref: `${GUIDE} «የበር ውጤት ብዛት»`,
      claimed: `${guideGateClaim[1]}/${guideGateClaim[2]}`,
      revs: [],
    });
  }
  if (selfClaims.length > 0) {
    // የራሱ-ብዛት ስለሆነ ዛሬው ትክክለኛ ውጤት እነዚህን ረድፎች ይዘጋል — ስለዚህ ሁለት ጊዜ በማስላት ተመዝኗል።
    // ዛሬው ቁጥር ያልሆነ ጥያኔ የሚአልፈው በራሱ በጠቀሰው commit ላይ ባለው መሣሪያ ሩጫ ብቻ (gateAtRev)።
    const base = results.length;
    const baseFail = results.filter(isFailure).length;
    const checked = base + selfClaims.length;
    const expected = (c, failures) => (c.format === 'guide' ? `${checked}/${checked - failures}` : `${checked}/${failures}`);
    // እያንዳንዱ ጥያኔ «ቁጥሬ ትክክል ቢሆን የሚወጣው ውጤት» ጋር ይነጻጸራል — ስህተቱ ራሱ ወደ ቁጥሩ አይጨመርም።
    // ካልሆነ የተሳሳተ ጥያኔ ራሱን አጽድቆ ሊያልፍ ይችላል (`checked/(checked-1)` በራሱ ስህተት ቢሆንም ይስማማል)።
    let failures = baseFail;
    for (let pass = 0; pass < 4; pass += 1) {
      let next = baseFail;
      for (const c of selfClaims) {
        const others = failures - (c.status === 'MISMATCH' ? 1 : 0);
        const today = expected(c, others);
        c.hit = c.claimed === today ? null : (c.revs.find((rev) => gateAtRev(root, rev) === c.claimed) ?? null);
        c.status = c.claimed === today ? 'OK' : c.hit ? 'OK_HISTORICAL' : 'MISMATCH';
        c.actual = today;
        if (c.status === 'MISMATCH') next += 1;
      }
      if (next === failures) break;
      failures = next;
    }
    for (const c of selfClaims) {
      results.push({
        kind: c.kind,
        ref: c.ref,
        claimed: c.claimed,
        actual: c.actual,
        status: c.status,
        ...(c.hit ? { at_commit: c.hit } : {}),
      });
    }
  }

  const bad = results.filter(isFailure);
  return {
    ledger: LEDGER,
    method: 'sha256 (LF-normalised for text, raw bytes for wav) of every path+hash and bare-filename+hash claim the ledger prints, plus offline scan_hash / event / coverage claims and every count claim the ledger prints about this gate result itself, plus the owner guide’s claimed test count (vs `test(` in tests/*.test.mjs), update-sample count (vs `update_id` envelopes the product lists), knowledge-entry count and gate count; a claim that differs from today is only forgiven when the commit named later on the same line really holds it — content via `git show rev:path`, a past gate count via re-running that commit’s own gate from `git archive rev`',
    checked: results.length,
    ok: results.length - bad.length,
    historical: results.filter((r) => r.status === 'OK_HISTORICAL').length,
    mismatch: results.filter((r) => r.status === 'MISMATCH').length,
    missing: results.filter((r) => r.status === 'MISSING_FILE').length,
    unclaimed: results.filter((r) => r.status === 'CLAIM_NOT_FOUND').length,
    results,
    failures: bad,
    limitation: 'የማለፍ/መውደቅ ውጤት በዚህ መሣሪያ አይመዘንም — `node --test tests/` በቀጥታ መሮጥ አለበት። የፍተሻ ብዛት ጥያኔ ግን በ`tests/*.test.mjs` ውስጥ ካለው `test(` ብዛት ጋር ይመዛዘናል።',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const report = auditLedgerEvidence(process.argv[2] ? resolve(process.argv[2]) : REPO);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.error || report.failures.length > 0 ? 1 : 0;
}
