import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const sha256File = (path) => sha256(readFileSync(path));
export const newId = (prefix) => `${prefix}-${randomUUID()}`;

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

const ETHIOPIC_PUNCT = /[\u1360-\u137F]/g;
const COMBINING = /[\u0300-\u036f]/g;

export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(ETHIOPIC_PUNCT, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(text) {
  const n = normalize(text);
  return n ? n.split(' ') : [];
}

export function isAmharicScript(text) {
  return /[\u1200-\u137F]/.test(String(text ?? ''));
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function nowIso() {
  return new Date().toISOString();
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
