// F-22 / R-42 / R-23 / CI-06፦ የተረጋጋሚ "ከውጭ ዝግኝት የለም" ፍተሻ (static egress scan)።
// ደንቡ፦ በማረጋገጫ ቃል መካከል ልዩነት አለ — NO_EGRESS ከ localhost ብቻ ግንኙነት ጋር አንድ አይደለም።
// ስለዚህ ፍተሻው ሦስት ውጤቶችን ይለያል፦ (1) ሩቅ/ውጭ አድራሻ (2) ወደ localhost ብቻ ያለው ወገብ (3) የማይታወቅ ስለዚህ ግምገማ የሚጠይቅ።
// ገደብ፦ static ፍተሻ ነው፤ በእውነተኛ ስልክ ላይ ያለ ጥሪ/FM/ሴል ዳታ ባህሪ አይወክልም (REQUIRES EVIDENCE በG2)።
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, nowIso } from '../app/src/util.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EGRESS = [
  { pattern: /\bfetch\s*\(/, why: 'HTTP client call' },
  { pattern: /\bhttps?\.(request|get)\s*\(/, why: 'Node HTTP client call' },
  { pattern: /\bnew\s+WebSocket\s*\(/, why: 'outbound WebSocket' },
  { pattern: /\bEventSource\s*\(/, why: 'server-sent events from remote' },
  { pattern: /\bXMLHttpRequest\b/, why: 'browser HTTP client' },
  { pattern: /\bdns\.(lookup|resolve)/, why: 'DNS resolution' },
  { pattern: /\bnet\.connect\s*\(/, why: 'raw outbound socket' },
];

// አድራሻ ቅርጽ ያላቸው ጽሑፎች፦ ሙሉ URL ወይም ከ'/' የሚጀምር አንጻራዊ መንገድ
const ABSOLUTE_URL = /https?:\/\/[^\s"'`)\\]+/g;
const RELATIVE_ENDPOINT = /['"`](\/[A-Za-z0-9_./-]*)['"`]/g;
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i;
// ተለዋዋጭ ቅድመ-ቁጥር ያላቸው URLዎች (http://${HOST}:${PORT}) በቀጥታ አይተረጎሙም፤ ምንጩን እንከተላለን
const TEMPLATE_URL = /^https?:\/\/\$\{/;
const SAME_ORIGIN = /\$\{\s*(location|window\.location|req\.headers\.host|req\.host)/;
const HOST_BIND = /process\.env\.HOST\s*\?\?\s*'([^']+)'/;
const TEMPLATE_FIRST_VAR = /\$\{\s*([A-Za-z_][\w.]*)/;

function classifyUrl(url, hostDefault) {
  if (LOOPBACK.test(url)) return 'loopback';
  if (!TEMPLATE_URL.test(url)) return 'remote';
  // የገጹ ባለቤት ከአሁኑ ተመሳሳይ-መነጭ ላይ የሚወሰድ ከሆነ ወደ ውጭ አይወጣም
  if (SAME_ORIGIN.test(url)) return 'same_origin';
  const variable = (url.match(TEMPLATE_FIRST_VAR) ?? [])[1] ?? '';
  if (hostDefault && /host$/i.test(variable)) {
    return LOOPBACK.test(`http://${hostDefault}`) ? 'loopback' : 'remote';
  }
  return 'unresolved';
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.tmp' || p === join(REPO, 'app', 'models') || p === join(REPO, 'app', 'bin')) continue;
      walk(p, acc);
    } else if (/\.(mjs|js|py|html|css|json)$/.test(name)) acc.push(p);
  }
  return acc;
}

// የምርት ቁልፎች ይህን ፍተሻ አያልፉም፤ በgit ውስጥም አይገቡም (.gitignore)
const PRIV_DIR = join(REPO, 'data', 'updates', 'private');
// F-22 / NR-05 / R-14፦ በእውነተኛ ሩጫ የሚፈጠሩ የruntime ፍላይዎች (የተተገበረ ዝማኔ ቅጂ፣ ሁኔታ፣ backup)
// የምርት ምንጭ አይደሉም። ከፍተሻው ባይወጡ ኖሮ በማሽን ላይ ያለው ሁኔታ scan_hash ይቀይራልና ማስረጃው
// የማይደገም ይሆን ነበር — በG1 ዴሞ ሩጫ በእውነት የተገኘ ጉድለት ነው።
const RUNTIME_DIRS = [
  join(REPO, 'data', 'updates', 'applied'),
  join(REPO, 'data', 'updates', 'backups'),
];
const RUNTIME_FILES = [join(REPO, 'data', 'updates', 'state.json')];
const isRuntimeArtifact = (p) => RUNTIME_DIRS.some((d) => p.startsWith(d)) || RUNTIME_FILES.includes(p);
// ፍተሻው የራሱ የአድራሻ ናሙና ዝርዝር አለው — የራሱን ጽሑፍ እንደ ውጭ ጥያቄ አይቆጥርም
const SELF = fileURLToPath(import.meta.url);
const toRel = (p) => p.slice(REPO.length + 1).split('\\').join('/');
const targets = [
  ...walk(join(REPO, 'app')),
  ...walk(join(REPO, 'data')),
  ...walk(join(REPO, 'tools')),
].filter((p) => !p.startsWith(PRIV_DIR) && !isRuntimeArtifact(p) && p !== SELF && !['prepare-offline-models.py', 'prepare-espeak-ng.py'].some(name => p === join(REPO, 'tools', name)));

const remote = [];
const localSurface = [];
const unresolved = [];

for (const file of targets) {
  const text = readFileSync(file, 'utf8');
  const relPath = file.slice(REPO.length + 1).split('\\').join('/');
  const hostDefault = (text.match(HOST_BIND) ?? [])[1];
  const call = EGRESS.find(({ pattern }) => pattern.test(text));

  const buckets = {};
  for (const u of new Set([...text.matchAll(ABSOLUTE_URL)].map((m) => m[0]))) {
    (buckets[classifyUrl(u, hostDefault)] ??= []).push(u);
  }
  const remoteUrls = buckets.remote ?? [];
  const localUrls = [...(buckets.loopback ?? []), ...(buckets.same_origin ?? [])];

  for (const u of remoteUrls) remote.push({ file: relPath, match: u, why: 'absolute remote URL in shipped source', allowed: false });
  for (const u of buckets.unresolved ?? []) {
    unresolved.push({ file: relPath, match: u, why: 'template URL whose host cannot be resolved from this file — manual review required', allowed: false });
  }

  if (remoteUrls.length === 0 && buckets.unresolved === undefined && call && file.endsWith('.html')) {
    // የደምቦ ገጽ fetch/XHR ተጠቅሟል — አድራሻዎቹ ሁሉ አንጻራዊ (/api/…) ከሆኑ ወደ localhost ብቻ ነው
    const endpoints = [...text.matchAll(RELATIVE_ENDPOINT)].map((m) => m[1]);
    if (endpoints.length && endpoints.every((e) => e.startsWith('/'))) {
      localSurface.push({
        file: relPath,
        client_call: String(call.pattern),
        endpoints: [...new Set(endpoints)],
        allowed: true,
        reason: 'አንጻራዊ (/api/…) አድራሻ ብቻ — ገንቢው በ127.0.0.1 ላይ ስለሚያዳምጥ ወደ ውጭ አይወጣም',
      });
    } else {
      unresolved.push({ file: relPath, match: String(call.pattern), why: 'client call with non-relative or no literal endpoint — manual review required', allowed: false });
    }
  } else if (call && !file.endsWith('.html')) {
    // የመሣሪያ ልተ (tool) ወደ 127.0.0.1 ብቻ ከጠየቀ ይህ ውጭ አይደለም፤ ሌላ ከሆነ ግምገማ ይጠይቃል
    if (remoteUrls.length === 0 && buckets.unresolved === undefined && localUrls.length > 0) {
      localSurface.push({
        file: relPath,
        client_call: String(call.pattern),
        endpoints: localUrls,
        allowed: true,
        reason: 'የአካባቢ ጥያቄ ብቻ (127.0.0.1) — የሙከራ መሣሪያ ከራሱ ገንቢ ጋር ብቻ ይነጋገራል',
      });
    } else {
      unresolved.push({ file: relPath, match: String(call.pattern), why: 'outbound client call in non-browser source', allowed: false });
    }
  }
  if (localUrls.length) {
    localSurface.push({
      file: relPath,
      endpoints: localUrls,
      allowed: true,
      reason: 'አቅራቢያዊ አድራሻ ወይም ወደ ራሱ ብቻ የሚመለስ (same-origin) — ተለዋዋጭ ቅድመ-ቁጥሩ በዚህ ፋይል ውስጥ ተመዝኗል',
    });
  }
}

// CI-01 / VE-01፦ የደንበኛ ገጽ የሚጠራው መንገድ በሰርቨሩ ላይ ያልተመዘገበ ከሆነ ማሳያው በዝግታ ይበላሻል (404 NO_ROUTE)
const serverRouteText = readFileSync(join(REPO, 'app', 'server.mjs'), 'utf8');
const registeredRoutes = new Set(
  [...serverRouteText.matchAll(/'(GET|POST) (\/api\/[^']+)'/g)].map((m) => `${m[1]} ${m[2]}`),
);
const clientRoutes = [];
const helperArity = new Map();
const helperCalls = [];
for (const p of walk(join(REPO, 'app', 'public'))) {
  if (!p.endsWith('.html')) continue;
  const pageText = readFileSync(p, 'utf8');
  for (const m of pageText.matchAll(/\b(get|post)\('(\/api\/[^']+)'/g)) {
    const route = `${m[1].toUpperCase()} ${m[2]}`;
    clientRoutes.push({ file: toRel(p), route, registered: registeredRoutes.has(route) });
  }
  // CI-01 / F-22፦ ገጹ ሁለተኛ አርጋሜንት ሲልክ መረዳቱ ራሱ ሁለተኛ መስክ ከሌለው ጥያቄው በዝግታ ይጠፋል
  for (const d of pageText.matchAll(/(?:const|let|function)\s+(get|post)\s*[=(]\s*([^)]*?)\)\s*=>/g)) {
    const params = d[2].split(',').map((x) => x.trim()).filter(Boolean);
    helperArity.set(`${toRel(p)}:${d[1]}`, params.length);
  }
  for (const c of pageText.matchAll(/(?<![\w.])\b(get|post)\('(\/api\/[^']+)',\s/g)) {
    helperCalls.push({ file: toRel(p), helper: c[1], route: `${c[1].toUpperCase()} ${c[2]}`, declared_params: helperArity.get(`${toRel(p)}:${c[1]}`) ?? 0 });
  }
}
const unregisteredRoutes = clientRoutes.filter((r) => !r.registered);
const arityMismatches = helperCalls.filter((c) => c.declared_params < 2);

const inbound = [join(REPO, 'app', 'server.mjs')]
  .filter((p) => existsSync(p))
  .map((p) => {
    const host = (readFileSync(p, 'utf8').match(HOST_BIND) ?? [])[1] ?? 'NOT_FOUND';
    return {
      file: toRel(p),
      bind_host_default: host,
      loopback_bind: host === '127.0.0.1' || host === 'localhost',
      note: 'localhost HTTP server only; no outbound request in the demo path',
    };
  });

const findings = [...remote, ...unresolved];
const verdict = findings.length === 0 ? 'STATIC_NO_REMOTE_EGRESS' : 'REVIEW_REQUIRED';

const report = {
  checked_at: nowIso(),
  requirement_ids: ['R-42', 'R-23', 'CI-06', 'F-22'],
  gate: 'G1',
  files_scanned: targets.length,
  // ተራ ብቻ (የWindows backslash አይገባም) — በማንኛውም ማሻሻያ ተደጋጋሚ hash እንዲሰጥ
  scan_hash: `sha256:${sha256(targets.map((f) => `${toRel(f)}:${sha256(readFileSync(f, 'utf8'))}`).sort().join('\n'))}`,
  excluded_from_scan: [
    'app/models/* + app/bin/* (pinned local model/runtime artifacts, checked by model manifests and isolated inference; not source code)',
    'tools/prepare-offline-models.py (explicit online preparation only; never imported by offline runtime)',
    'tools/prepare-espeak-ng.py (explicit online preparation only; never imported by offline runtime)',
    'data/updates/private/* (የፊርማ ቁልፎች)',
    'data/updates/applied/* + data/updates/backups/* + data/updates/state.json (የruntime ፍላይዎች — የምርት ምንጭ አይደሉም)',
    toRel(SELF),
  ],
  method: 'regex sweep for client-call APIs and URL literals; template URLs resolved from the same file, relative-path calls classified as loopback-only',
  egress_findings: findings,
  same_origin_surface: localSurface,
  inbound_listeners: inbound,
  // የውጭ ዝግኝት ፍተሻውን ውሳኔ አይቀይርም — የማሳያውን ተጠቃሚ መንገድ ብቻ የሚመለከት ተጨማሪ ማረጋገጫ ነው
  client_route_check: {
    calls: clientRoutes.length,
    registered_routes: registeredRoutes.size,
    unregistered: unregisteredRoutes,
  },
  // ሁለተኛ አርጋሜንት የላከች ጥያቄዎች መረዳታቸው ሁለተኛ መስክ ካልቀበለ ይቆጠራሉ
  client_helper_arity_check: {
    calls_with_params: helperCalls.length,
    mismatches: arityMismatches,
  },
  verdict,
  limitation: 'ይህ የstatic ፍተሻ ነው፤ በእውነተኛ ስልክ ላይ ያለ የጥሪ/FM/ሴል ዳታ ባህሪ አይወክልም። የእውነተኛ ማስረጃው በG2 መሣሪያ ላይ ይሰጣል።',
};

mkdirSync(join(REPO, 'evidence'), { recursive: true });
writeFileSync(join(REPO, 'evidence', 'offline-static-check.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  verdict: report.verdict,
  files_scanned: report.files_scanned,
  egress_findings: findings.length,
  same_origin_calls: localSurface.length,
  client_route_calls: clientRoutes.length,
  unregistered_routes: unregisteredRoutes.length,
  helper_arity_mismatches: arityMismatches.length,
  loopback_bind: inbound.every((i) => i.loopback_bind),
}, null, 2));
process.exitCode = findings.length ? 1 : 0;
