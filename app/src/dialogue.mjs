import { normalize, isAmharicScript, tokens, nowIso } from './util.mjs';
import { classifyRisk, safetyGate } from './safety.mjs';

const FOLLOW_UP = [
  /^(ተጨማሪ|ጨማሪ|ዝርዝር|ለምን|እንዴት|ለምሳሌ)/,
  /^(more|details?|why|how|example)/i,
  /^(dabalata|bal'ina|maaliif|akkamitti)/i,
  // R-05፦ ወደ ቀድሞው ርዕስ የሚመልስ ጠቋሚ (anaphora) — ቃል ካልተገናኘ ርዕሱን ይይዛል፣ አይፈጥርም
  // ጥንቃቄ፦ የጥያቄ ቃላት ብቻ (ስንት/ምን) ጠቋሚ አይደሉም — አዲስ ርዕስ ሊኖራቸው ይችላል
  /(ከዚህ|ከዚያ|ያን|እርሱ|እርሷ|እነሱ|ሌላ|ተከታታይ|ቀጥል|ያለፈው|አማርኛውን|ከላይ)/,
  /\b(sanaa?|isni|isin|kuni|lakkumsa|dabalata|itti|duuratti)\b/i,
];

const GREETING = /^(ሰላም|ሰላም ነው|ጤና ይስጥልኝ|እንደምን ነህ|እንደምን ነሽ|akkam|nagaa|as-salaam)/;
const HELP = /(እገዛ|እንዴት እጠቀም|እንዴት ይሠራ|help|gargaarsa|akkamitti fayyadama)/;
// የምርቱ ቋንቋዎች ብቻ — የASR ኢንጂን ምልከት (`-l am`/`-l om`) ከእነዚህ ውጭ ከሆነ ምርጫ አይደለም
const PRODUCT_LOCALES = new Set(['am', 'om']);
// OP-03: explicit return/correction phrases. Keep these narrow so ordinary questions
// that happen to contain "previous" are not hijacked.
const TOPIC_RETURN = [
  /(?:ወደ\s*)?ቀድሞ(?:ው)?\s*(?:ርዕስ|ጉዳይ)/i,
  /ተመለስ(?:ልኝ|በ|ወደ)?/i,
  /\b(?:previous|prior|last)\s+(?:topic|subject)\b/i,
  /\b(?:go\s+back|back\s+to)\b/i,
  /\b(?:mata\s*duree|duree)\s*(?:duraa|darbee)\b/i,
  /\bdeeb[i']?i\b/i,
];
const CORRECTION = [
  /^(?:አይደለም|ተሳስተዋል|ስህተት\s*ነው|ያ\s*ስህተት\s*ነው)/i,
  /\b(?:not\s+correct|that'?s\s+wrong|incorrect)\b/i,
  /\b(?:sirrii\s*miti|dogoggora)\b/i,
];

export class Dialogue {
  constructor({ kb, locale = 'am' }) {
    this.kb = kb;
    this.locale = locale;
    this.lastTopicId = null;
    this.lastClaimIds = [];
    this.lastAnswer = null;
    this.leafClarification = null;
    this.turns = 0;
    this.topicHistory = [];
  }

  setLocale(locale) {
    this.locale = locale === 'om' ? 'om' : 'am';
  }

  // F-08 / NR-03፦ ቀላል የጽሑፍ-ገበታ ምልከታ ብቻ — እውነተኛ LID ደረጃው UNKNOWN ነው።
  // ባዶ/ፊደል-የሌለው ግቤት null ይመልሳል (ቋንቋ አልተለየም) እንጂ በስህተት ወደ አፋን ኦሮሞ አይቀይርም።
  detectLocale(text) {
    const raw = String(text ?? '');
    if (!raw.trim()) return null;
    if (isAmharicScript(raw)) return 'am';
    if (/\p{L}/u.test(raw)) return 'om';
    return null;
  }

  respond({ text, localeHint }) {
    const started = performance.now();
    const detected = this.detectLocale(text);
    // ምልከቱ (hint) የኢንጂኑ ቋንቋ ሲነሣ ከጽሑፍ-ገበታ ይበልጥ እውቅና ነው፦ ላቲን ፊደል «አፋን ኦሮሞ»
    // ማለት አይደለም — የእንግሊዘኛ ወይም የተዛወረ ግልጽ የአማርኛ ጥያቄ በላቲን ስለሚጻፍ መልሱ በተሳሳተ
    // ቋንቋ አይወጣም (F-08/R-07)። የአማርኛ ፊደል ግን ሁልጊዜ ግልጽ ነው — ምልከቱን ያስወግዳል።
    const hint = PRODUCT_LOCALES.has(localeHint) ? localeHint : null;
    const locale = detected === 'am' ? 'am' : hint ?? detected ?? this.locale;
    this.locale = locale;
    this.turns += 1;
    const q = normalize(text);

    if (!q) {
      return this.finish({
        type: 'clarify',
        text: this.t(locale, 'ድምፅዎን አልሰማሁም። እባክዎ እንደገና ይናገሩ ወይም ይጻፉ።', 'Sagalee keessan hin dhageenye. Irra deebi’aa dubbadhaa ykn barreessaa.'),
        locale,
        started,
      });
    }

    if (GREETING.test(q)) {
      this.leafClarification = null;
      return this.finish({
        type: 'greeting',
        text: this.t(locale, 'ሰላም! የAI ቁልፍን ተጭነው ስለ እርሻ፣ እንስሳት፣ ገበያ ወይም ስልክ ይጠይቁኝ።', 'Akkam! Qonna, beeylada, gabaa ykn bilbila ilaalchisee na gaafadhaa.'),
        locale,
        started,
      });
    }

    const risk = classifyRisk(text, locale);
    const gatePreview = safetyGate({ text, risk, topResult: null, locale });
    if (gatePreview.blocked) {
      this.leafClarification = null;
      return this.finish({
        type: 'refuse',
        text: gatePreview.message,
        textShort: gatePreview.message,
        locale,
        risk,
        safety: gatePreview,
        started,
      });
    }

    const leafReply = this.clarifyLeaves(q, { locale, risk, started });
    if (leafReply) return leafReply;
    this.leafClarification = null;

    if (TOPIC_RETURN.some((re) => re.test(q))) {
      const returned = this.returnToPreviousTopic({ text, locale, risk, started });
      if (returned) return returned;
    }
    if (CORRECTION.some((re) => re.test(q)) && this.lastTopicId) {
      const corrected = this.restateLastTopic({ text, locale, risk, started });
      if (corrected) return corrected;
    }

    if (HELP.test(q)) {
      const e = this.kb.search('ስልክ እገዛ', locale, { limit: 1 })[0];
      return this.finish({
        type: 'answer',
        text: e ? e.entry.answer : this.t(locale, 'የስልክ እገዛ መረጃ አልተገኘም።', 'Gargaarsi bilbilaa hin argamne.'),
        locale,
        claims: e ? [e] : [],
        risk,
        started,
      });
    }

    const results = this.kb.search(text, locale, { limit: 3 });
    const isFollowUp = FOLLOW_UP.some((re) => re.test(q));

    if (results.length === 0 && isFollowUp && this.lastTopicId) {
      const retry = this.kb
        .byTopic(this.lastTopicId)
        .filter((e) => e.locale === locale)
        .map((entry) => ({ entry, score: 1, matched: [], expired: this.kb.isExpired(entry) }));
      if (retry.length) return this.answerFrom(retry, { text, locale, risk, started, followUp: true });
    }

    if (results.length === 0) {
      return this.finish({
        type: 'unknown',
        text: this.t(
          locale,
          'ይህን ጥያቄ በተረጋገጠ የአካባቢ እውቀት አላገኘሁም። በግምት አልመልስም። እባክዎ በሌላ አገላለጽ ይጠይቁ ወይም የአካባቢ ባለሙያ ያነጋግሩ።',
          'Gaaffii kana beekumsa naannoo mirkanaa’een hin argadne. Tilmaamaan hin deebisu. Kana booda haala biraan gaafadhaa ykn ogeessa naannoo qunnamaa.'
        ),
        locale,
        risk,
        started,
        escalation: 'EXPERT_REFERRAL',
      });
    }

    return this.answerFrom(results, { text, locale, risk, started, followUp: false });
  }

  clarifyLeaves(q, { locale, risk, started }) {
    const maize = /በቆሎ|\bboqqolloo\w*\b/u.test(q);
    const leaves = /ቅጠል|ቅጠሎ|\bbaal(?:a|li|le|leen)\b/u.test(q);
    const yellow = /ቢጫ|\bkeelloo\b/u.test(q);
    const initial = maize && leaves && yellow;
    const pending = this.leafClarification;
    if (!initial && !pending) return null;

    const negated = /አይደለም|አይደሉም|አልሆነም|አልሆኑም|\bmiti\b|\bhin\b/u.test(q);
    if (negated && (leaves || yellow || /^(አይደለም|አይደሉም|miti)$/u.test(q))) {
      this.leafClarification = null;
      this.lastTopicId = null;
      this.lastClaimIds = [];
      this.lastAnswer = null;
      return this.finish({
        type: 'clarify', code: 'LEAF_OBSERVATION_UNCLEAR', locale, risk, started,
        text: this.t(locale,
          'የቢጫ ቅጠል ምልከታውን እንደተረጋገጠ አልወስድም። እባክዎ ያዩትን ለውጥ በሌላ አገላለጽ ይግለጹ።',
          'Baalli keelloo ta\'uu akka mirkanaa\'etti hin fudhadhu. Maaloo jijjiirama argitan haala biraatiin ibsaa.'),
        claims: [], response_basis: 'rule_based_clarification',
      });
    }
    const positionReply = q
      .replace(/(?:የ)?በቆሎ(?:ዬ)?|\bboqqolloo\w*\b(?: koo)?/gu, ' ')
      .replace(/ቢጫ(?: ሆኗል| ሆነዋል)?|\bkeelloo\b(?: ta e| ta aniiru)?/gu, ' ')
      .replace(/\s+/g, ' ').trim();
    const lower = /^(?:(?:ከ|የ)?(?:ታች|ታችኛው|ታችኞቹ)(?: ቅጠሎቹ| ቅጠሎች| ቅጠል)?(?: ነው| ናቸው)?|(?:baal(?:a|li) )?(?:jalaa|gadii)(?: ti| dha)?)$/u.test(positionReply);
    const upper = /^(?:(?:ከ|የ)?(?:ላይ|ላይኛው|ላይኞቹ)(?: ቅጠሎቹ| ቅጠሎች| ቅጠል)?(?: ነው| ናቸው)?|(?:baal(?:a|li) )?(?:gubbaa|olii)(?: ti| dha)?)$/u.test(positionReply);
    const both = /^(ሁለቱም|ሁሉም|lamaanuu|hundi)$/u.test(positionReply);
    if (!initial && !leaves && !lower && !upper && !both) return null;
    const positionKnown = lower || upper || both;

    // የተጠቃሚው ምልከታ የእውቀት ማስረጃ አይደለም፤ የዘር አዘራር ውጤት ለምልክት ጥያቄ አይተካም።
    this.lastTopicId = null;
    this.lastClaimIds = [];
    this.lastAnswer = null;
    this.leafClarification = {
      topic_id: 'maize_leaf_yellowing',
      leaf_position: lower ? 'lower' : upper ? 'upper' : both ? 'both' : null,
      source: 'user_observation',
    };
    const context = { ...this.leafClarification };
    if (!positionKnown) {
      return this.finish({
        type: 'clarify', code: 'LEAF_POSITION_REQUIRED', locale, risk, started,
        text: this.t(locale,
          'የበቆሎ ቅጠል ቢጫ መሆን ብቻ ምክንያቱን ለመወሰን አይበቃም። የታችኞቹ ቅጠሎች ናቸው፣ የላይኞቹ ወይስ ሁለቱም?',
          'Baalli boqqolloo keelloo ta\'uun qofti sababa isaa murteessuuf hin ga\'u. Baala jalaa, baala gubbaa moo lamaanuu?'),
        context, missing_slots: ['leaf_position'], claims: [], followUp: false,
        response_basis: 'rule_based_clarification',
      });
    }
    const position = this.t(locale,
      lower ? 'የታችኞቹ' : upper ? 'የላይኞቹ' : 'የሁለቱም ክፍል',
      lower ? 'jalaa' : upper ? 'gubbaa' : 'jalaa fi gubbaa');
    return this.finish({
      type: 'unknown', code: 'EXPERT_REVIEW_REQUIRED', locale, risk, started,
      text: this.t(locale,
        `${position} የበቆሎ ቅጠሎች ቢጫ መሆናቸውን ገልጸዋል። ይህን ከቀደመው ጥያቄዎ ጋር ይዣለሁ። ምክንያቱን የሚያረጋግጥ እውቀት በመዝገቡ የለኝም፤ በግምት ሕክምና አልመክርም። ይህን መረጃ ለአካባቢዎ የግብርና ባለሙያ ይንገሩ።`,
        `Baalli boqqolloo ${position} keelloo ta'uu ibsitaniittu. Kana gaaffii keessan duraa wajjin yaadadheera. Sababa isaa mirkaneessuuf beekumsa gahaa galmee keessatti hin qabu; yaala tilmaamaan hin gorsu. Odeeffannoo kana ogeessa qonnaa naannoo keessaniif himaa.`),
      context, missing_slots: [], claims: [], followUp: true,
      response_basis: 'rule_based_clarification', escalation: 'EXPERT_REFERRAL',
    });
  }

  returnToPreviousTopic({ text, locale, risk, started }) {
    while (this.topicHistory.length) {
      const previous = this.topicHistory.pop();
      if (!previous || previous === this.lastTopicId) continue;
      const results = this.kb
        .byTopic(previous)
        .filter((e) => e.locale === locale)
        .map((entry) => ({ entry, score: 1, matched: [], expired: this.kb.isExpired(entry) }));
      if (!results.length) continue;
      const reply = this.answerFrom(results, { text, locale, risk, started, followUp: true, trackHistory: false });
      reply.returned_to_previous_topic = previous;
      return reply;
    }
    return null;
  }

  restateLastTopic({ text, locale, risk, started }) {
    const results = this.kb
      .byTopic(this.lastTopicId)
      .filter((e) => e.locale === locale)
      .map((entry) => ({ entry, score: 1, matched: [], expired: this.kb.isExpired(entry) }));
    if (!results.length) return null;
    const reply = this.answerFrom(results, { text, locale, risk, started, followUp: true, trackHistory: false });
    reply.correction_of_topic = this.lastTopicId;
    return reply;
  }

  reset() {
    this.lastTopicId = null;
    this.lastClaimIds = [];
    this.lastAnswer = null;
    this.leafClarification = null;
    this.topicHistory = [];
    this.turns = 0;
  }

  answerFrom(results, { text, locale, risk, started, followUp, trackHistory = true }) {
    const top = results[0];
    const conflicts = this.kb.conflictsFor(results).filter((c) => c.entry.answer !== top.entry.answer);
    const safety = safetyGate({ text, risk, topResult: top, locale });
    const expired = top.expired;

    let body = top.entry.answer;
    let suffix = '';
    if (conflicts.length) {
      suffix += this.t(
        locale,
        ' ማስታወሻ፦ በመዝገቡ ውስጥ ተቃራኒ መረጃ አለ፤ ከሁለቱም ምንጭ ማረጋገጥ ያስፈልጋል።',
        ' Hubachiisa: galmee keessatti odeeffannoo wal faallessu jira; lamaanuu madda irraa mirkaneessuu barbaachisa.'
      );
    }
    if (expired) {
      suffix += this.t(
        locale,
        ' ማስታወሻ፦ ይህ መረጃ ጊዜው አልፏል፤ እንደ ዛሬ አይውሰድ።',
        ' Hubachiisa: odeeffannoon kun yeroon isaa darbe; akka har’aa hin fudhatin.'
      );
    }
    if (safety.message) suffix += ` ${safety.message}`;
    body = `${body}${suffix}`;

    if (trackHistory && this.lastTopicId && this.lastTopicId !== top.entry.topic_id) {
      if (this.topicHistory[this.topicHistory.length - 1] !== this.lastTopicId) {
        this.topicHistory.push(this.lastTopicId);
        if (this.topicHistory.length > 6) this.topicHistory.shift();
      }
    }
    this.lastTopicId = top.entry.topic_id;
    this.lastClaimIds = results.map((r) => r.entry.claim_id);
    this.lastAnswer = body;

    return this.finish({
      type: 'answer',
      text: body,
      textShort: top.entry.answer_short || top.entry.answer,
      locale,
      topicIds: [...new Set(results.map((r) => r.entry.topic_id))],
      claims: results.map((r) => ({
        claim_id: r.entry.claim_id,
        topic_id: r.entry.topic_id,
        score: r.score,
        matched: r.matched,
        source: r.entry.source,
        captured_at: r.entry.source.captured_at,
        valid_until: r.entry.valid_until,
        expired: r.expired,
        risk_level: r.entry.risk_level,
        verification: r.entry.confidence_basis,
      })),
      conflict: conflicts.length > 0,
      followUp,
      risk,
      safety,
      started,
    });
  }

  t(locale, am, om) {
    return locale === 'om' ? om : am;
  }

  finish(payload) {
    const latency = Math.round((performance.now() - payload.started) * 100) / 100;
    delete payload.started;
    return {
      ...payload,
      latency_ms: latency,
      kb_version: this.kb.version,
      kb_status: this.kb.status,
      kb_hash: this.kb.hash,
      kb_notice: this.kb.notice[payload.locale] || this.kb.notice.am,
      turn: this.turns,
      at: nowIso(),
    };
  }
}
