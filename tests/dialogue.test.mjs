import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeBase } from '../app/src/knowledge.mjs';
import { Dialogue } from '../app/src/dialogue.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kb = KnowledgeBase.load(join(REPO, 'data', 'knowledge', 'entries.json'));

const fresh = () => new Dialogue({ kb, locale: 'am' });

test('R-05 / CI-01፦ ክፍት ውይይት ከምንጭ ጋር ይመልሳል (grounded answer)', () => {
  const d = fresh();
  const r = d.respond({ text: 'የበቆሎ ዘር እንዴት ይዘራል' });
  assert.equal(r.type, 'answer');
  assert.ok(r.claims.length > 0, 'የምንጭ ማስረጃ (claims) ግዴታ ነው');
  assert.ok(r.claims[0].source?.kind, 'የምንጭ ዓይነት ማሳየት አለበት');
  assert.ok(r.kb_status, 'የመዝገብ ደረጃ ከመልሱ ጋር ይዛወራል');
  assert.equal(r.kb_status, 'DEMO_FIXTURE_UNVERIFIED');
});

test('R-05 / OP-02፦ ተከታታይ ጥያቄ የቀድሞውን ርዕስ ይይዛል (multi-turn context)', () => {
  const d = fresh();
  const first = d.respond({ text: 'የእንስሳት መጠጫ ውሃ ስንት ጊዜ ነው' });
  assert.equal(first.type, 'answer');
  assert.equal(first.topicIds[0], 'livestock_water');
  const second = d.respond({ text: 'ተጨማሪ ዝርዝር' });
  assert.equal(second.type, 'answer', 'የታሰረ ጥያቄ ከዜሮ አልመለሰም');
  assert.equal(second.followUp, true);
  assert.ok(second.claims.every((c) => c.topic_id === 'livestock_water'), 'የተከታታይ ማስታወሻ ወደ ቀድሞ ርዕስ ተመልሷል');
  assert.equal(second.turn, 2);
});

test('R-05 / G1-D03፦ ወደ ቀድሞው ርዕስ የሚመልስ ተከታታይ ጥያቄ (anaphora) ርዕሱን ይዞ መልስ ይሰጣል', () => {
  const d = fresh();
  assert.equal(d.respond({ text: 'የእንስሳት መጠጫ ውሃ ስንት ጊዜ ነው' }).type, 'answer');
  const second = d.respond({ text: 'ከዚያ በፊት ምን ማድረግ አለብኝ' });
  assert.equal(second.type, 'answer', 'ያለ ተዛማጅ ቃል ጥያቄው ወደ ቀድሞ ርዕስ መመለስ አለበት');
  assert.equal(second.followUp, true);
  assert.ok(second.claims.every((c) => c.topic_id === 'livestock_water'), 'ማስታወሻው የቀድሞውን ርዕስ ብቻ ይከተላል');
});

test('R-05 / R-10፦ ጠቋሚ የሌለውና ያልተያያዘ ጥያቄ ከርዕስ በኋላም አልፎ አይፈጥርም (no eager reuse)', () => {
  const d = fresh();
  d.respond({ text: 'የእንስሳት መጠጫ ውሃ ስንት ጊዜ ነው' });
  const r = d.respond({ text: 'የጨረቃ ጉዞ ማረፊያ ጊዜ ስንት ነው' });
  assert.equal(r.type, 'unknown', 'ያለ ጠቋሚና ያለ ተዛማጅ እውቀት "አላውቅም" ብቻ ነው');
  assert.equal(r.escalation, 'EXPERT_REFERRAL');
});

test('R-05 / CI-03፦ በአፋን ኦሮሞ ተከታታይ ጥያቄ ርዕስ ይይዛል (Oromo anaphora)', () => {
  const d = fresh();
  const first = d.respond({ text: 'Hidhi beeyladaa yoomtu?', localeHint: 'om' });
  assert.equal(first.type, 'answer', 'የመጀመሪያ የአፋን ኦሮሞ ጥያቄ መዝገብ ያገኛል');
  const second = d.respond({ text: 'Itti furnisi', localeHint: 'om' });
  assert.equal(second.type, 'answer', 'ጠቋሚ ያለው ተከታታይ ጥያቄ ወደ ቀድሞ ርዕስ ይመለሳል');
  assert.equal(second.followUp, true);
});

test('R-10 / NR-12፦ ያልታወቀ ጥያቄ "አላውቅም" ብሎ ወደ ባለሙያ ይመራል፣ አልፎ አልፎ አይፈጥርም', () => {
  const d = fresh();
  // ጥያቄው ከመዝገቡ ቃላት ጋር ምንም ግንኙነት የለውም — "በግምት መመለስ" የለም።
  const r = d.respond({ text: 'የጨረቃ ጉዞ ማረፊያ ጊዜ ስንት ነው' });
  assert.equal(r.type, 'unknown');
  assert.equal(r.escalation, 'EXPERT_REFERRAL');
  assert.match(r.text, /አላገኘሁም|በግምት አልመልስም/);
  assert.ok(!/¥|\$\d/.test(r.text), 'የተፈጠረ ቁጥር የለም');
});

test('R-10 / F-21፦ የተሳሳተ ርዕስ ላይ ያለ ቃል ብቻውን መልስ አይፈጥርም (no keyword-only hallucination)', () => {
  const d = fresh();
  const r = d.respond({ text: 'የጨረቃ ላይ የነጭ ሽንፈር ዋጋ ስንት ነው' });
  // "ዋጋ" ስላለ የገበያ መዝገብ ይገኛል፤ ግን መልሱ "የዛሬውን ዋጋ ያረጋግጡ" ብቻ ነው፣ ቁጥር አይፈጥርም
  assert.equal(r.type, 'answer');
  assert.ok(!/\d[\d,.]*\s*ብር/.test(r.text), 'ማረጋገጫ-የሌለው ማሳያ ቁጥር አይናገርም');
});

test('R-10 / F-21፦ ያልተመዘገበ ርዕስ ላይ የተነሳ ጥያቄ በተሳሳተ ርዕስ መልስ አይሰጥም (no wrong-topic answer)', () => {
  const d = fresh();
  d.respond({ text: 'የእርሻ መሬት ዝግጅት ምንድነው' });
  // ዝናብ በቂ ካልሆነ — በማሳያው መዝገብ ውስጥ የዝናብ-በቃሚነት መዝገብ የለም። አማራጩ የተሳሳተ ርዕስ መልስ አይደለም።
  const r = d.respond({ text: 'ያ በቂ ዝናብ ካልሆነስ' });
  assert.equal(r.type, 'unknown', 'ያልተመዘገበ ርዕስ "አላውቅም" ሆኖ መቅረት አለበት');
  assert.equal(r.escalation, 'EXPERT_REFERRAL');
  const topics = (r.claims ?? []).map((c) => c.topic_id);
  assert.ok(!topics.includes('market_price'), 'የገበያ ዋጋ መልስ ለዝናብ ጥያቄ ተሰጥቷል');
});

test('R-07 / CI-03፦ የቋንቋ መለያ ጽሑፍን አይደቀቅም (Amharic vs Afaan Oromo)', () => {
  const d = fresh();
  const om = d.respond({ text: 'Bishaan beeyladaa hamma qabna?' });
  assert.equal(om.locale, 'om');
  const am = d.respond({ text: 'የእንስሳት ውሃ ስንት ጊዜ' });
  assert.equal(am.locale, 'am');
});

// F-08 / R-07 — በምርት መንገድ ላይ የተገኘ እውነተኛ ጉድለት (evidence/g1-product-path-latency.json)፦
// የASR ማስመሰያ/የተዛወረ ግብይት ላቲን ፊደል ስለሚጽፍ መልሱ በአፋን ኦሮሞ ወጥቷል፤ የኢንጂኑ ቋንቋ ምልከት ተደምስሶ።
test('F-08 / R-07፦ የኢንጂን ቋንቋ ምልከት (localeHint=am) ከላቲን ጽሑፍ አይደምሰስም', () => {
  const d = fresh();
  const r = d.respond({ text: '[BEEP]', localeHint: 'am' });
  assert.equal(r.locale, 'am', 'ላቲን ብቻ ስለሆነ «አፋን ኦሮሞ» አይባልም');
  assert.equal(r.type, 'unknown');
  assert.match(r.text, /አላገኘሁም|በግምት አልመልስም/, 'የማይከፈል መልስ በአማርኛ ይሰጣል');
});

test('F-08 / R-07፦ የአማርኛ ፊደል ሲታየ ምልከቱ ሁልጊዜ ይቀድማል (om ምልከት ቢኖርም)', () => {
  const d = fresh();
  const r = d.respond({ text: 'የአገር ማከሚያ ጊዜ ምን ይሁን?', localeHint: 'om' });
  assert.equal(r.locale, 'am');
});

test('F-08 / R-07፦ ያልተደገፈ ቋንቋ ምልከት (en) የምርት ቋንቋ አይመደበኛም — ጽሑፉ ብቻ ይወስናል', () => {
  const d = fresh();
  const latin = d.respond({ text: 'The farmer should plant maize', localeHint: 'en' });
  assert.equal(latin.locale, 'om', 'en ምርት ቋንቋ ስላልሆነ እንደ ያለ-ምልከት ላቲን ይቆጠራል');
  const ethiopic = d.respond({ text: 'የጤና ደንቡር ዘር', localeHint: 'en' });
  assert.equal(ethiopic.locale, 'am');
});

test('R-01 / CI-04፦ ችግር የሌለው ግቤት (empty) አልሰማሁኝ ማስተዋወቅ ይሰጣል', () => {
  const d = fresh();
  const r = d.respond({ text: '   ' });
  assert.equal(r.type, 'clarify');
  assert.match(r.text, /አልሰማሁም/);
});

test('CI-04 / R-05፦ የቢጫ ቅጠል ጥያቄ በሁለቱም ቋንቋዎች ያጣራል፣ የታች መልስንም ያስታውሳል', () => {
  for (const [locale, text, reply] of [
    ['am', 'የበቆሎዬ ቅጠል ቢጫ ሆኗል፤ ምን ላድርግ?', 'ከታች ቅጠሎቹ ነው'],
    ['om', "Baalli boqqolloo koo keelloo ta'e; maal godhu?", 'Baala jalaa ti'],
  ]) {
    const d = fresh();
    const first = d.respond({ text, localeHint: locale });
    assert.equal(first.type, 'clarify');
    assert.equal(first.code, 'LEAF_POSITION_REQUIRED');
    assert.deepEqual(first.claims, []);
    assert.deepEqual(first.missing_slots, ['leaf_position']);
    const second = d.respond({ text: reply, localeHint: locale });
    assert.equal(second.code, 'EXPERT_REVIEW_REQUIRED');
    assert.equal(second.followUp, true);
    assert.equal(second.locale, locale);
    assert.equal(second.context.topic_id, 'maize_leaf_yellowing');
    assert.equal(second.context.leaf_position, 'lower');
    assert.equal(second.context.source, 'user_observation');
    assert.equal(second.escalation, 'EXPERT_REFERRAL');
    assert.equal(second.response_basis, 'rule_based_clarification');
    assert.equal(first.context.leaf_position, null, 'የቀድሞው ውጤት በኋላ አይቀየርም');
    assert.deepEqual(second.claims, [], 'የማይኖር የምክር ምንጭ አይፈጠርም');
  }
});

test('CI-04፦ ላይኛውና ሁለቱም ቅጠሎች የተለየ አውድ ይይዛሉ', () => {
  for (const [reply, position] of [['ከላይ ቅጠሎቹ ነው', 'upper'], ['ሁለቱም', 'both'], ['Baala gubbaa ti', 'upper'], ['lamaanuu', 'both']]) {
    const d = fresh();
    d.respond({ text: 'የበቆሎ ቅጠል ቢጫ ሆኗል' });
    const r = d.respond({ text: reply });
    assert.equal(r.context.leaf_position, position);
    assert.equal(r.followUp, true);
  }
});

test('R-10 / CI-04፦ የቅጠል አውድ አዲስ ርዕስንና ሌላ ውይይትን አይወርስም', () => {
  const d = fresh();
  d.respond({ text: 'የበቆሎ ቅጠል ቢጫ ሆኗል' });
  assert.equal(fresh().respond({ text: 'ከታች ቅጠሎቹ ነው' }).type, 'unknown');
  const other = d.respond({ text: 'የእንስሳት መጠጫ ውሃ ስንት ጊዜ ነው' });
  assert.equal(other.topicIds[0], 'livestock_water');
  assert.equal(d.leafClarification, null);
  const later = d.respond({ text: 'ከታች ቅጠሎቹ ነው' });
  assert.equal(later.type, 'unknown');
  assert.equal(later.context, undefined);
});

test('R-09 / CI-04፦ ማጣሪያ በኬሚካል ጥበቃ ፊት አይቀድምም', () => {
  const d = fresh();
  d.respond({ text: 'የበቆሎ ቅጠል ቢጫ ሆኗል' });
  const r = d.respond({ text: 'ከታች ቅጠሎቹ ነው፤ መርዝ ስንት መጠን ልጨምር' });
  assert.equal(r.type, 'refuse');
  assert.equal(d.leafClarification, null);
  assert.equal(r.context, undefined);
});

test('R-05 / CI-04፦ ባዶ ግቤት አውድን ያቆያል፤ ሰላምታ ግን ማጣሪያውን ይዘጋል', () => {
  const d = fresh();
  d.respond({ text: 'የበቆሎ ቅጠል ቢጫ ሆኗል' });
  assert.equal(d.respond({ text: '' }).type, 'clarify');
  assert.equal(d.respond({ text: 'ከታች ቅጠሎቹ ነው' }).context.leaf_position, 'lower');
  d.respond({ text: 'ሰላም' });
  assert.equal(d.leafClarification, null);
});

test('R-10 / CI-04፦ የቅጠል ጥያቄ የቀድሞ አዘራር አውድን አይጠቀምም', () => {
  const d = fresh();
  assert.equal(d.respond({ text: 'የበቆሎ ዘር እንዴት ይዘራል' }).type, 'answer');
  d.respond({ text: 'የበቆሎዬ ቅጠል ቢጫ ሆኗል' });
  const unknown = d.respond({ text: 'ተጨማሪ' });
  assert.equal(unknown.type, 'unknown');
  assert.equal(d.lastTopicId, null);
});

test('CI-04 / R-10፦ ረዘም ያለ የቅጠል መልስ ወደ አዘራር አይመለስም', () => {
  for (const [question, reply] of [
    ['የበቆሎዬ ቅጠል ቢጫ ሆኗል', 'የታችኞቹ የበቆሎ ቅጠሎች ናቸው'],
    ['የበቆሎዬ ቅጠል ቢጫ ሆኗል', 'የታችኞቹ የበቆሎ ቅጠሎች ቢጫ ሆነዋል'],
    ["Baalli boqqolloo koo keelloo ta'e", 'Baala boqqolloo jalaa ti'],
    ["Baalli boqqolloo koo keelloo ta'e", "Baalli boqqolloo jalaa keelloo ta'e"],
  ]) {
    const d = fresh();
    d.respond({ text: question });
    const r = d.respond({ text: reply });
    assert.equal(r.code, 'EXPERT_REVIEW_REQUIRED');
    assert.equal(r.context.leaf_position, 'lower');
    assert.deepEqual(r.claims, []);
  }
});

test('CI-04 / R-10፦ ያልተለየ የቅጠል ተከታይ መልስ ይጣራል', () => {
  for (const reply of ['የበቆሎ ቅጠሎቹ ዳር ዳር ነው', 'Baala boqqolloo muraasa']) {
    const d = fresh();
    d.respond({ text: 'የበቆሎ ቅጠል ቢጫ ሆኗል' });
    const r = d.respond({ text: reply });
    assert.equal(r.code, 'LEAF_POSITION_REQUIRED');
    assert.equal(r.context.leaf_position, null);
    assert.deepEqual(r.claims, []);
  }
});

test('CI-04 / R-10፦ አሉታዊ ምልከታ በተቃራኒው አይመዘገብም', () => {
  for (const text of ['የበቆሎ ቅጠል ቢጫ አይደለም', 'Baalli boqqolloo keelloo miti']) {
    for (const pending of [false, true]) {
      const d = fresh();
      if (pending) d.respond({ text: 'የበቆሎ ቅጠል ቢጫ ሆኗል' });
      const r = d.respond({ text });
      assert.equal(r.code, 'LEAF_OBSERVATION_UNCLEAR');
      assert.equal(r.context, undefined);
      assert.equal(d.leafClarification, null);
      assert.deepEqual(r.claims, []);
      assert.equal(d.respond({ text: 'ሁለቱም' }).context, undefined);
    }
  }
});

test('F-11 / CI-14፦ የውይይት ሂደት ፍጥነት ማስረጃ (no network)', () => {
  const d = fresh();
  const samples = [];
  for (let i = 0; i < 25; i += 1) {
    const r = d.respond({ text: 'የበቆሎ ዘር አቀማመጥ ምን ይመስላል' });
    samples.push(r.latency_ms);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95) - 1];
  assert.ok(Number.isFinite(p95), 'የp95 ልኬት አለ');
  assert.ok(p95 < 200, `አካባቢያዊ ፍለጋ በቂ ፍጥነት አለው (p95=${p95}ms) — ኢንተርኔት የለም`);
});

// OP-03: continuous questions, topic change, explicit return to the previous topic, correction, and reset.
test('Topic switch, explicit return and correction keep the right context; reset clears it', () => {
  const d = fresh();
  const first = d.respond({ text: 'የእንስሳት መጠጥ አስፈልጎ ነው' });
  assert.equal(first.type, 'answer');
  assert.equal(first.topicIds[0], 'livestock_water');
  const changed = d.respond({ text: 'የገበያ ዋጋ እንዴት ነው' });
  assert.equal(changed.type, 'answer');
  assert.equal(changed.topicIds[0], 'market_price');
  const returned = d.respond({ text: 'ወደ ቀድሞ ርዕስ ተመለስ' });
  assert.equal(returned.type, 'answer', 'explicit return must answer from the previous topic');
  assert.equal(returned.returned_to_previous_topic, 'livestock_water');
  assert.ok(returned.claims.every((c) => c.topic_id === 'livestock_water'));
  const corrected = d.respond({ text: 'ያ ስህተት ነው' });
  assert.equal(corrected.type, 'answer', 'correction must restate the current topic, not invent a new one');
  assert.equal(corrected.correction_of_topic, 'livestock_water');
  d.reset();
  const noContext = d.respond({ text: 'ወደ ቀድሞ ርዕስ ተመለስ' });
  assert.equal(noContext.type, 'unknown', 'reset must remove previous-topic context');
});

test('OP-03: explicit previous-topic return is narrow and does not consume history on unrelated Amharic', () => {
  const d = fresh();
  assert.equal(d.respond({ text: 'የእንስሳት መጠጫ ውሃ ስንት ጊዜ ነው' }).topicIds[0], 'livestock_water');
  assert.equal(d.respond({ text: 'የገበያ ዋጋ እንዴት ነው' }).topicIds[0], 'market_price');

  const unrelated = d.respond({ text: 'ቀድሞ ወይዘሪት' });
  assert.equal(unrelated.type, 'unknown');
  assert.equal(unrelated.returned_to_previous_topic, undefined);
  assert.equal(unrelated.claims, undefined, 'unknown response must not attach unsupported claims');
  const shortUnrelated = d.respond({ text: 'እንግዳ ቃል' });
  assert.equal(shortUnrelated.type, 'unknown', 'unrelated two-word input must not reuse current topic');
  assert.equal(shortUnrelated.returned_to_previous_topic, undefined);

  const returned = d.respond({ text: 'ወደ ቀድሞ ርዕስ ተመለስ' });
  assert.equal(returned.type, 'answer');
  assert.equal(returned.returned_to_previous_topic, 'livestock_water',
    'unrelated input must not consume the previous-topic history');
});

test('OP-03: Afaan Oromo explicit previous-topic return restores Oromo context', () => {
  const d = fresh();
  const first = d.respond({ text: 'Bishaan beeyladaa hamma qabna?' });
  assert.equal(first.locale, 'om');
  assert.equal(first.topicIds[0], 'livestock_water');
  const changed = d.respond({ text: "Gatii gabaa har'aa" });
  assert.equal(changed.locale, 'om');
  assert.equal(changed.topicIds[0], 'market_price');

  const returned = d.respond({ text: 'mata duree duraa' });
  assert.equal(returned.locale, 'om');
  assert.equal(returned.type, 'answer');
  assert.equal(returned.returned_to_previous_topic, 'livestock_water');
  assert.ok(returned.claims.every((c) => c.topic_id === 'livestock_water'));
});
