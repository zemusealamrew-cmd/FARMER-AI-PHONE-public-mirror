// F-22 / R-42 / R-23 / CI-06፦ "ኢንተርኔት የለም" የማለት ደንብ በተግባር ተፍትሾ ይቆያል።
// ደንቡ NO_EGRESS እና "localhost ብቻ" ስለሚለይ፣ ፍተሻው ሦስቱንም ወገቦች በማስረጃ ማየት አለበት።
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = () => spawnSync(process.execPath, [join(REPO, 'tools', 'offline-check.mjs')], { encoding: 'utf8' });
// These tests intentionally regenerate evidence/offline-static-check.json. Restore the
// committed snapshot after the file's tests so the suite does not leave a dirty evidence file
// that makes ledger-evidence/gate counts fail on the next run.
const EVIDENCE_PATH = join(REPO, 'evidence', 'offline-static-check.json');
const evidenceSnapshot = readFileSync(EVIDENCE_PATH, 'utf8');
after(() => writeFileSync(EVIDENCE_PATH, evidenceSnapshot, 'utf8'));

test('R-42 / F-22፦ የተሰነዘው ማሳያ ኮድ ወደ ውጭ አድራሻ የለውም፣ ፍተሻውም ዜሮ ይመዘግባል', () => {
  const r = run();
  assert.equal(r.status, 0, `አላልፈሁም፦ ${r.stderr}`);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.verdict, 'STATIC_NO_REMOTE_EGRESS');
  assert.equal(summary.egress_findings, 0);
  assert.ok(summary.files_scanned >= 20, `የምርት ፋይሎች ተቊጥረዋል (${summary.files_scanned})`);
  assert.equal(summary.loopback_bind, true, 'ገንቢው በ127.0.0.1 ላይ ብቻ ያዳምጣል');
});

test('R-42 / CI-06፦ ማስረጃው የተፈቀዱ ወገቦችንና የተከለከሉ ውጤቶችን ለይቶ ይይዛል', () => {
  run();
  const report = JSON.parse(readFileSync(join(REPO, 'evidence', 'offline-static-check.json'), 'utf8'));
  assert.deepEqual(report.requirement_ids.sort(), ['CI-06', 'F-22', 'R-23', 'R-42'].sort());
  assert.equal(report.gate, 'G1');
  assert.match(report.scan_hash, /^sha256:[0-9a-f]{64}$/, 'የተደጋጋሚ scan hash ግዴታ ነው');

  // የተከለከሉ ወገቦች ከሆኑ ሁሉም allowed:false መሆን አለባቸው
  for (const finding of report.egress_findings) assert.equal(finding.allowed, false);

  // የገጹ fetch ጥያቄዎች አንጻራዊ (/api/…) ብቻ መሆናቸው በማስረጃ ይታያል
  const page = report.same_origin_surface.find((s) => s.file === 'app/public/index.html');
  assert.ok(page, 'የደምቦ ገጽ ወገብ ተመዝግቧል');
  assert.ok(page.endpoints.length > 0 && page.endpoints.every((e) => e.startsWith('/')), 'አንጻራዊ አድራሻ ብቻ');
  assert.equal(typeof page.reason, 'string', 'ምክንያቱ ጽሑፍ ሆኖ ማስረጃው ውስጥ መቆየት አለበት');

  // localhost/template አድራሻዎች ወደ ራሳቸው ተመዝግበዋል እንጂ እንደ ውጭ ጥያቄ አይቆጠሩም
  const server = report.same_origin_surface.find((s) => s.file === 'app/server.mjs');
  assert.ok(server, 'የገንቢው አድራሻዎች ተመዝግበዋል');
  assert.ok(server.endpoints.some((u) => u.includes('${HOST}')), 'http://${HOST}:${PORT} በማስረጃው ውስጥ አለ');
  assert.equal(report.egress_findings.filter((f) => f.file === 'app/server.mjs').length, 0, 'የአካባቢ አድራሻ እንደ ውጭ አይቆጠርም');
});

test('CI-01 / VE-01 / F-22፦ የተጠቃሚ ገጹ የሚጠራው እያንዳንዱ መንገድ በሰርቨሩ ላይ ተመዝግቧል', () => {
  // ይህ የጉድለት ዘር ጥበቃ ነው፦ ገጹ POST /api/fm ጠርቶ ሰርቨሩ GET ብቻ ሲሆን ማሳያው በዝግታ ተበላሽቷል
  const r = run();
  assert.equal(r.status, 0, `አላልፈሁም፦ ${r.stderr}`);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.unregistered_routes, 0, 'ያልተመዘገበ መንገድ ካለ ማሳያው 404 NO_ROUTE ይመልሳል');
  assert.ok(summary.client_route_calls >= 18, `የገጽ ጥያቄዎች ተቊጥረዋል (${summary.client_route_calls})`);
  const report = JSON.parse(readFileSync(join(REPO, 'evidence', 'offline-static-check.json'), 'utf8'));
  assert.deepEqual(report.client_route_check.unregistered, []);
  assert.ok(report.client_route_check.registered_routes >= 15, 'የሰርቨር መንገዶች ዝርዝሩ ተገኝቷል');
  // ዘሩ፦ ገጹ ሁለተኛ አርጋሜንት ሲልክ መረዳቱ ከሌለው ጥያቄው በዝግታ ይጠፋል (SAMPLE_NOT_FOUND ላይ ተገኝቶ ነው)
  assert.equal(summary.helper_arity_mismatches, 0, 'የገጽ ረዳት መረዳቶች ጥያቄዎቹን ይቀበላሉ');
  assert.ok(report.client_helper_arity_check.calls_with_params > 0, 'የተጨማሪ ጥያቄ ያላቸው ጥሪዎች ተቊጥረዋል');
});

test('S-4 / OP-10 / F-15፦ ያልታመነ ግቤት ጽሑፍ ወደ DOM ያለ ጽዳት አይገባም', () => {
  // የጉድለት ዘሩ፦ SMS/FM/እውቀት ጽሑፍ በinnerHTML ላይ ጥሬ ሲቀርጸው ያልታመነ ግቤት የድር ትዕዛዝ ይሆናል።
  const src = readFileSync(join(REPO, 'app', 'public', 'index.html'), 'utf8');
  const statements = [...src.matchAll(/\.innerHTML\s*=\s*([\s\S]*?);\n/g)].map((m) => m[1]);
  assert.ok(statements.length >= 3, `የinnerHTML መጻፊያ ቦታዎች ተቊጥረዋል (${statements.length})`);
  const preEscaped = new Set(['claims', "flags.join(' ')"]);
  const unsafe = [];
  for (const stmt of statements) {
    for (const m of stmt.matchAll(/\$\{([^{}]*)\}/g)) {
      const expr = m[1].trim();
      if (expr.startsWith('esc(') || preEscaped.has(expr)) continue;
      unsafe.push(expr);
    }
  }
  assert.deepEqual(unsafe, [], 'ያልጸዳ ጽሑፍ ወደ innerHTML ገብቷል');
  assert.ok((src.match(/\.textContent\s*=/g) ?? []).length >= 8, 'የመረጃ ጽሑፍ በDOM ኦብጀክት መንገድ ይጻፋል');
});

test('R-42 / R-23፦ ውስጣዊ አድራሻ ያለው ፋይል ፍተሻውን አያሳልፍም — በተግባር ተሞክሮ በማረጋገጥ', () => {
  // ደንቡ፦ ማንኛውም ፍተሻ ራሱን እንደ አደጋ አይቆጥርም፤ ግምገማው የሚከተለው የምርት ፋይል ክፍል ብቻ ነው።
  const report = JSON.parse(readFileSync(join(REPO, 'evidence', 'offline-static-check.json'), 'utf8'));
  const scanned = report.files_scanned;
  const hash = report.scan_hash;
  run();
  const again = JSON.parse(readFileSync(join(REPO, 'evidence', 'offline-static-check.json'), 'utf8'));
  assert.equal(again.files_scanned, scanned, 'የተቃወሙ (private keys, self) ፋይሎች በቋሚነት ውጪ ናቸው');
  assert.equal(again.scan_hash, hash, 'scan hash በሁለት ሩጫ ተደጋጋሚ ነው (ምንም የጊዜ/መንገድ ልዩነት የለም)');
  assert.ok(again.excluded_from_scan.some((e) => e.startsWith('data/updates/private')), 'የቁልፍ ደብተር መለያው መቅረጹ በማስረጃ ተገልጿል');
});

test('F-22 / NR-05 / R-14፦ በእውነተኛ ሩጫ የሚፈጠሩ runtime ፍላይዎች scan hashና የፋይል ብዛት አይቀይሩም', () => {
  // የጉድለት ዘሩ፦ የG1 ዴሞ ዝማኔ ሲተገበር መንገድ-ላይ የተገኘው ቅጂ/ሁኔታ በdata/ ውስጥ ስለሚጻፉ ፍተሻው
  // 32→34 ፋይልና ሃሹም ይቀየር ነበር — በማሽን ሁኔታ ላይ የተመሠረተ ማስረጃ (ማይደገም) ይፈጠራል።
  run();
  const before = JSON.parse(readFileSync(join(REPO, 'evidence', 'offline-static-check.json'), 'utf8'));
  const appliedDir = join(REPO, 'data', 'updates', 'applied');
  const backupsDir = join(REPO, 'data', 'updates', 'backups');
  const statePath = join(REPO, 'data', 'updates', 'state.json');
  const createdDirs = [appliedDir, backupsDir].filter((d) => !existsSync(d));
  const createdFiles = [];
  // The product server can legitimately create this runtime state (gitignored) when the
  // demo has been run; the invariant is that the test must not ADD or DELETE anything.
  const entriesExistedBefore = existsSync(join(appliedDir, 'entries.json'));
  try {
    for (const d of createdDirs) mkdirSync(d, { recursive: true });
    const probe = [
      [join(appliedDir, 'entries.json'), { kb_version: 'RUNTIME-PROBE', entries: [{ claim_id: 'probe' }] }],
      [join(backupsDir, 'probe.json'), { kb_version: 'BACKUP-PROBE', entries: [] }],
      [statePath, { installed_version: '9.9.9', monotonic_counter: 99, applied: [], last_backup: null }],
    ];
    for (const [p, doc] of probe) {
      if (!existsSync(p)) createdFiles.push(p);
      writeFileSync(p, JSON.stringify(doc, null, 2), 'utf8');
    }
    run();
    const after = JSON.parse(readFileSync(join(REPO, 'evidence', 'offline-static-check.json'), 'utf8'));
    assert.equal(after.files_scanned, before.files_scanned, 'runtime ፍላይዎች ወደ ተቃኝዎች አልተጨመሩም');
    assert.equal(after.scan_hash, before.scan_hash, 'የማስረጃ scan hash በዴሞ ሩጫ አይቀየርም');
    assert.ok(after.excluded_from_scan.some((e) => e.startsWith('data/updates/applied')), 'የruntime ማስገቢያ መለያው በማስረጃ ተገልጿል');
  } finally {
    for (const p of createdFiles) rmSync(p, { force: true });
    for (const d of createdDirs) rmSync(d, { recursive: true, force: true });
  }
  assert.equal(existsSync(join(appliedDir, 'entries.json')), false, 'የሙከራ ፍላይዎች ተወግደዋል — ማከማቻ አይበኩሉም');
});

test('G1 model assets are inert data; executable Python remains in the offline source scan', () => {
  const models=join(REPO,'app','models','scan-fixture');mkdirSync(models,{recursive:true});
  const source=join(REPO,'app','src','scan-python-fixture.py');
  try {
    writeFileSync(join(models,'vocab.json'),JSON.stringify({token:'XMLHttpRequest https://example.invalid'}));
    assert.equal(run().status,0,'inert model vocabulary does not execute network calls');
    writeFileSync(source,"import urllib.request\nurllib.request.urlopen('https://example.invalid')\n");
    assert.equal(run().status,1,'Python inference source with egress is rejected');
  } finally {rmSync(source,{force:true});rmSync(models,{recursive:true,force:true});run();}
});
