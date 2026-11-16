import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFileLf, docsFiles } from './make-manifest.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(REPO, 'docs');
const manifestPath = join(docsDir, 'FILE_MANIFEST_SHA256.txt');

const lines = readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
const results = [];
for (const line of lines) {
  const [hash, file] = line.trim().split(/\s+/);
  const path = join(docsDir, file);
  if (!existsSync(path)) {
    results.push({ file, status: 'MISSING_FILE' });
    continue;
  }
  const actual = hashFileLf(path);
  results.push({ file, status: actual === hash ? 'OK' : 'MISMATCH', expected: hash, actual });
}

const listed = new Set(results.map((r) => r.file));
const unlisted = docsFiles().filter((f) => !listed.has(f));

const report = {
  checked_at: new Date().toISOString(),
  method: 'sha256 over CRLF-normalised (LF) text',
  total: results.length,
  ok: results.filter((r) => r.status === 'OK').length,
  mismatch: results.filter((r) => r.status === 'MISMATCH').length,
  missing: results.filter((r) => r.status === 'MISSING_FILE').length,
  unlisted_docs: unlisted,
  results,
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.mismatch + report.missing + unlisted.length > 0 ? 1 : 0;
