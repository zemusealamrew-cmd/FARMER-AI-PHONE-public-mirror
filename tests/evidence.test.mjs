// F-19 / F-20 / R-38 / R-40 / NR-08፦ የማስረጃ ሰለባ (hash chain)፣ የሀብት ልኬት እና የp95 ስሌት።
// ማስረጃው በራሱ ተቀምጦ "ተመዝግቧል" ሊባል አይገባም — ለውጥ ሲደርስ ማረጋገጫው ግዴታ መሰባበር አለበት።
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceLog, measure, percentile, resourceSnapshot } from '../app/src/evidence.mjs';

const logPath = () => join(mkdtempSync(join(tmpdir(), 'farmerevidence-')), 'evidence.jsonl');

test('R-38 / F-20፦ የተመዘገቡ entries ሰለባውን ያጸኑና seq ከ1 ይጀምራል', () => {
  const path = logPath();
  const log = new EvidenceLog({ path, gate: 'G1', device: 'laptop-demo', build: 'g1-test' });
  const a = log.record('session_start', { locale: 'am' });
  const b = log.record('answer', { claim_ids: ['KB-AM-001'] });
  const c = log.record('session_end', {});

  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3], 'seq ተከታታይ እና ከ1 የሚጀምር ነው');
  assert.equal(a.prev_hash, null, 'የመጀመሪያው entry ያለፈ hash የለውም');
  assert.equal(b.prev_hash, a.entry_hash, 'ሁለተኛው የመጀመሪያውን hash ይይዛል');
  assert.match(a.entry_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.build, 'g1-test');
  assert.equal(a.gate, 'G1');

  const chain = log.verifyChain();
  assert.equal(chain.ok, true);
  assert.equal(chain.code, 'CHAIN_VERIFIED');
  assert.equal(chain.entries, 3);
  assert.equal(chain.head, c.entry_hash, 'head የመጨረሻው entry hash ነው');
});

test('R-38፦ መዝገቡ ዳግም ሲከፈት ሰለባው አይቆረጥም (reopen continues the chain)', () => {
  const path = logPath();
  const first = new EvidenceLog({ path });
  const one = first.record('kind_a', {});
  const reopened = new EvidenceLog({ path });
  const two = reopened.record('kind_b', {});
  assert.equal(two.seq, 2);
  assert.equal(two.prev_hash, one.entry_hash, 'አዲሙ ኦብጀክት ከዲስክ የተነበበ head ላይ ተከታይሏል');
  assert.equal(reopened.verifyChain().ok, true);
});

test('R-38 / NR-08፦ entry ይዘት ቢቀየር hash ስለማይገናኝ ፍተሻው ወዲያውኑ ይይዛል', () => {
  const path = logPath();
  const log = new EvidenceLog({ path });
  log.record('answer', { text: 'ወዳጅ' });
  log.record('error', { code: 'ASR_TIMEOUT' });
  assert.equal(log.verifyChain().ok, true, 'ከመቅረጹ በፊት ሰለባው ትክክል ነው');

  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const tampered = { ...JSON.parse(lines[1]), code: 'NOT_AN_ERROR' };
  writeFileSync(path, `${lines[0]}\n${JSON.stringify(tampered)}\n`, 'utf8');

  const after = new EvidenceLog({ path }).verifyChain();
  assert.equal(after.ok, false);
  assert.equal(after.code, 'HASH_MISMATCH');
  assert.equal(after.seq, 2);
});

test('R-38፦ entry ቢደበቅ ወይም ቅደም ተከተል ቢቀየር CHAIN_BREAK ይመዘገባል', () => {
  const path = logPath();
  const log = new EvidenceLog({ path });
  for (const kind of ['a', 'b', 'c', 'd']) log.record(kind, {});

  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  writeFileSync(path, lines.slice(1).map((l) => `${l}\n`).join(''), 'utf8');

  const after = new EvidenceLog({ path }).verifyChain();
  assert.equal(after.ok, false);
  assert.equal(after.code, 'CHAIN_BREAK', 'የቀረው መዝገብ ከnull head ጋር ስለማይገናኝ መቅረጹ ይታወቃል');
  assert.equal(after.seq, 2, 'መቅረጹ የተገኘበት ተራ — የ1ኛው ስለተወገደ የ2ኛው prev_hash ከnull ጋር አይዛመድም');
});

test('R-38 / F-20፦ የማንበብ ያልቻለ መስመር UNPARSEABLE_LINE በማለት ይገለጻል (silent skip አይደለም)', () => {
  const path = logPath();
  const log = new EvidenceLog({ path });
  log.record('answer', { ok: true });
  appendFileSync(path, 'ይህ JSON አይደለም\n', 'utf8');
  const after = new EvidenceLog({ path }).verifyChain();
  assert.equal(after.ok, false);
  assert.equal(after.code, 'UNPARSEABLE_LINE');
});

test('R-40 / F-07 / F-11፦ የሀብት ናሙና ሊለካ የሚችል ቁጥሮችን ይሰጣል', () => {
  const snap = resourceSnapshot();
  for (const key of ['rss_mb', 'heap_used_mb', 'heap_total_mb', 'external_mb', 'uptime_ms']) {
    assert.equal(typeof snap[key], 'number', `${key} ቁጥር መሆን አለበት`);
    assert.ok(Number.isFinite(snap[key]), `${key} finite መሆን አለበት`);
  }
  assert.ok(snap.rss_mb > 0, 'RSS ከ0 ይበልጣል');
  assert.ok(snap.heap_used_mb <= snap.heap_total_mb, 'የተጠቀመ heap ከጠቅላላው አይበልጥም');
});

test('R-40 / F-11፦ measure ጊዜንና የድርጊት ውጤትን አንድ ላይ ይመልሳል', async () => {
  const out = await measure(() => Promise.resolve(Array.from({ length: 2000 }, (_, i) => i)));
  assert.equal(out.result.length, 2000);
  assert.ok(Number.isFinite(out.ms) && out.ms >= 0);
  assert.equal(typeof out.rss_delta_mb, 'number');
});

test('R-40 / CI-14፦ percentile ትክክለኛ ደረጃዎችን ይመልሳል፣ ለባዝ ዜሮ አይደለም', () => {
  const values = [9, 1, 5, 3, 7, 2, 8, 4, 10, 6];
  assert.equal(percentile(values, 50), 5, 'p50 የማዕከሉ ዋጋ ነው');
  assert.equal(percentile(values, 95), 10);
  assert.equal(percentile(values, 100), 10, 'ከ100% በላይ መውጣት የለበትም');
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([], 95), null, 'ዜሮ ናሙና "አልታወቀም" እንጂ 0 አይደለም');
});

test('F-07 / R-38፦ seq በENV ብቻ ይቀጥላል — እያንዳንዱ መዝገብ ሙሉ ፋይሉን አያነብም (O(n²) ማራኪ የለም)', () => {
  const path = logPath();
  const first = new EvidenceLog({ path, gate: 'G1', device: 'laptop-demo' });
  first.record('a', {});
  first.record('b', {});
  assert.equal(first.seq, 2, 'በENV የተቆጠረው ተከታታይ ነው');
  // ሂደት ሲዘጋና ሲከፈት ከፋይሉ ቁጥር ይቀጥላል — ተከታታይነቱ አይሰበርም
  const second = new EvidenceLog({ path, gate: 'G1', device: 'laptop-demo' });
  assert.equal(second.seq, 2, 'ከፋይሉ የተነበበ መነሻ ቁጥር');
  const c = second.record('c', {});
  assert.equal(c.seq, 3);
  assert.equal(second.verifyChain().ok, true, 'ሰለባው ከፍትሐዊ seq ጋር ይጸናል');
  // reset ከፋይሉ ጋር ተከታታይ ቁጥሩን ዜሮ ያደርጋል
  second.reset();
  assert.equal(second.seq, 0);
  assert.equal(second.record('d', {}).seq, 1);
});
