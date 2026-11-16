import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeBase } from '../app/src/knowledge.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KB_PATH = join(REPO, 'data', 'knowledge', 'entries.json');

// የተረጋገገ clock፦ ማብቂያ ግዜ ላይ የተመሠረተ ፍተሻ ከዛሬ ቀን እንዳይወሰድ
const NOW = '2026-11-04T12:00:00.000Z';
const AFTER_MARKET_EXPIRY = '2026-12-01T12:00:00.000Z';

const kb = KnowledgeBase.load(KB_PATH);

test('F-10 / R-05፦ አማርኛ ጥያቄ ከእውቀት መዝገብ ይመልሳል (retrieval-first)', () => {
  const hits = kb.search('የእርሻ መሬት እንዴት እዘጋጃለሁ', 'am', { at: NOW });
  assert.ok(hits.length > 0, 'ዝግጅት ጥያቄ ማረጋገጫ ማግኘት አለበት');
  assert.equal(hits[0].entry.topic_id, 'soil_preparation');
  assert.equal(hits[0].entry.locale, 'am');
  assert.ok(hits[0].entry.source?.kind, 'የምንጭ ዓይነት ግዴታ ነው');
  assert.ok(hits[0].entry.source?.captured_at, 'የመረጃ ቀጠሮ ግዴታ ነው');
});

test('F-08 / R-07፦ የአፋን ኦሮሞ ጥያቄ ወደ አማርኛ መልስ አይቀየርም (locale isolation)', () => {
  const hits = kb.search('qonna lafa qophii', 'om', { at: NOW });
  assert.ok(hits.length > 0);
  for (const h of hits) assert.equal(h.entry.locale, 'om', 'ቋንቋ የመቀላቀል ጥያቄ አልፏል');
});

test('F-17 / LC-03፦ ጊዜው ያለፈ መረጃ ምልክት ይደረጋል፣ አይደፋም', () => {
  const fresh = kb.search('ገበያ ዋጋ', 'am', { at: NOW });
  const stale = kb.search('ገበያ ዋጋ', 'am', { at: AFTER_MARKET_EXPIRY });
  assert.equal(fresh[0].expired, false);
  assert.equal(stale[0].expired, true, 'የዋጋ መረጃ ማብቂያ ግዜው ሲደርስ stale መሆን አለበት');
  assert.equal(stale[0].entry.topic_id, 'market_price');
});

test('F-10 / R-09፦ ተቃራኒ የዕውቀት ጥናቶች ይገለጣሉ (conflict detection)', () => {
  const topic = 'soil_preparation';
  const both = kb.byTopic(topic);
  assert.ok(both.length >= 2, 'አንድ ርዕስ በሁለት ቋንቋ መዝገብ አለው');
  const am = kb.search('እርሻ መሬት ዝግጅት', 'am', { limit: 3, at: NOW });
  const conflicts = kb.conflictsFor(am);
  assert.ok(Array.isArray(conflicts), 'የግጭት ማውጫ ምንጭ ዳታ ሲኖር ባዶ ወይም ዝርዝር መሆን አለበት');
});

test('R-10 / NR-12፦ ያልተገለጸ ጥያቄ ዜሮ ማረጋገጫ ይመልሳል (no silent guessing)', () => {
  const hits = kb.search('የጨረቃ ላይ ማዕድ እንዴት እቆፍራለሁ', 'am', { at: NOW });
  assert.equal(hits.length, 0, 'ያልተመዘገበ ርዕስ ሐሰተኛ ማጣመም የለም');
});

test('R-10 / F-10፦ አናገራዊ ቃላት የተሳሳተ ርዕስ መልስ አይምረጡም (particle noise regression)', () => {
  // የነበረው ጉድለት፦ «ያ በቂ ዝናብ ካልሆነስ» በ«ገበያ» ውስጥ ያለው አንድ ፊደል ብቻ ተዳስሶ የገበያ መዝገብ መርጧል።
  for (const q of ['ያ በቂ ዝናብ ካልሆነስ', 'ያ የተላከ መልዕክት ምንድነው', 'ስለ እኔ ከላይ ምን ይሁን']) {
    assert.equal(kb.search(q, 'am', { at: NOW }).length, 0, `${q} — ያለ ይዘት ጥያቄ ርዕስ መርጧል`);
  }
  // ይዘት ያላቸው ቃላት ቀደምት ሽፋኖቻቸውን አያጣሉም
  assert.equal(kb.search('የገበያ ዋጋ ስንት ነው', 'am', { at: NOW })[0].entry.topic_id, 'market_price');
  assert.equal(kb.search('የእንስሳት መጠጫ ውሃ', 'am', { at: NOW })[0].entry.topic_id, 'livestock_water');
  assert.equal(kb.search('መርዝ ስለት አደጋ', 'am', { at: NOW })[0].entry.topic_id, 'pesticide_safety');
});

test('F-06፦ የመዝገብ ሃሽ ለውጥን ይከታከላል', () => {
  const again = KnowledgeBase.load(KB_PATH);
  assert.equal(again.hash, kb.hash, 'አንድ ዓይነት ይዘት አንድ ዓይነት ሃሽ');
  assert.match(kb.hash, /^[0-9a-f]{64}$/);
  assert.equal(kb.status, 'DEMO_FIXTURE_UNVERIFIED', 'የማሳያ መዝገብ "የማይታመን" መሆኑ ግልጽ መሆን አለበት');
});

test('R-23፦ ፍለጋው የግል መረጃ አይጠይቅምና አያስቀምጥም', () => {
  const before = kb.entries.length;
  kb.search('ስለ እኔ ቤተሰብ ንገረኝ', 'am', { at: NOW });
  assert.equal(kb.entries.length, before, 'ፍለጋ ውሂብ አይጨምርም/አይቀይርም');
});
