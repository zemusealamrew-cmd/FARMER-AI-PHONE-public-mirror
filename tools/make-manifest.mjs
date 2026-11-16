import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(REPO, 'docs');

export function lfNormalize(text) {
  return text.replace(/\r\n/g, '\n');
}

export function hashFileLf(path) {
  return createHash('sha256').update(lfNormalize(readFileSync(path, 'utf8'))).digest('hex');
}

export function docsFiles() {
  return readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort();
}

export function buildManifest() {
  const lines = docsFiles().map((f) => `${hashFileLf(join(docsDir, f))}  ${f}`);
  const header = [
    '# docs/ የፋይል ማኒፌስት — SHA-256 (ከCRLF ወጪ በLF መሠረት)',
    '# ማስታወሻ (F-06)፦ ዋጋዎቹ የሚሰሉት የፋይሉን ይዘም CRLF ወደ LF በመቀየር ነው። በWindows checkout',
    '# (core.autocrlf=true) ቀጥታ sha256sum ከወሰዱ ሁሉም ፋይሎች ሊለያዩ ይችላሉ — ይህ የይዘት ለውጥ',
    '# ሳይሆን የረድፍ-መበስበስ ውጤት ነው። ለማረጋገጥ፦ node tools/verify-manifest.mjs',
    `# generated_at: ${new Date().toISOString()}`,
    `# files: ${docsFiles().length}`,
  ].join('\n');
  return `${header}\n\n${lines.join('\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const out = join(docsDir, 'FILE_MANIFEST_SHA256.txt');
  writeFileSync(out, buildManifest(), 'utf8');
  console.log(`WROTE ${out} (${docsFiles().length} files)`);
}
