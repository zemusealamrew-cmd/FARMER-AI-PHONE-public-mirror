import { readFileSync } from 'node:fs';
import { normalize, tokens, sha256File, nowIso } from './util.mjs';

// R-10 / CI-01፦ አናገራዊ (function) ቃላት ርዕስ አይወስኑም። እነዚህ ቃላት ብቻ ከተገኙ ፍለጋው ውጤት
// የለውምና ሥርዓቱ "አላውቅም" ይላል — በቃልኪዳን ብቻ የተሳሳተ ርዕስ መልስ መስጠት ይከለከላል።
const STOPWORDS = new Set([
  'ያ', 'የ', 'ከ', 'በ', 'ለ', 'ወደ', 'ጋር', 'ላይ', 'ውስ', 'እና', 'ወይም', 'ግን', 'ነው', 'ነች', 'ናቸው', 'ነበር',
  'ሆነ', 'ሆነው', 'ይሆን', 'ካልሆነ', 'ምን', 'የት', 'ማን', 'ለምን', 'እንዴት', 'ስንት', 'ምንድን', 'ያህል', 'ብቻ',
  'አንድ', 'ሁሉ', 'ሁሌም', 'እንደ', 'ከላይ', 'ታች', 'ደግሞ', 'ስለዚህ', 'ስለ', 'ኔ', 'አንተ', 'እርሱ', 'እርሷ', 'እኔ',
  'fi', 'ykn', 'kan', 'ni', 'haa', 'akka', 'hunda', 'tokko', 'sanaa', 'isni', 'isin', 'kuni',
]);

// የአማርኛ/አፋን ኦሮሞ ቃላት ምድብና መደላደል ስለሚያስፈልጉ፣ ከግማሽ ቃል መዳሰስ በጥቂት ሁኔታዎች ብቻ ይፈቀዳል።
const MIN_PARTIAL_TOKEN = 3;

function isPartialMatch(qTok, kw) {
  // ቅጥያ/መዋሃድ ለማገናዘብ መዳሰስ ይፈቀዳል፤ ግን ሁለቱም በ3 ፊደል ላይ ሲሆኑ ብቻ።
  // አጭር አናገራዊ ቃላት (ያ፣ በቂ፣ እና...) በሌላ ቃል መካከል ስለሚገኙ የተሳሳተ ርዕስ ይመርጡ ነበር።
  if (qTok.length < MIN_PARTIAL_TOKEN || kw.length < MIN_PARTIAL_TOKEN) return false;
  return qTok.includes(kw) || kw.includes(qTok);
}

function contentTokens(text) {
  const out = [];
  for (const t of tokens(text)) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

export class KnowledgeBase {
  constructor(path) {
    this.path = path;
    this.reload();
  }

  reload() {
    this.hash = sha256File(this.path);
    const raw = JSON.parse(readFileSync(this.path, 'utf8'));
    this.version = raw.kb_version;
    this.status = raw.kb_status;
    this.notice = { am: raw.notice_am, om: raw.notice_om };
    this.entries = raw.entries;
    return this;
  }

  static load(path) {
    return new KnowledgeBase(path);
  }

  isExpired(entry, at = nowIso()) {
    if (!entry.valid_until) return false;
    return new Date(entry.valid_until).getTime() < new Date(at).getTime();
  }

  search(query, locale, { limit = 3, at = nowIso() } = {}) {
    const qTokens = contentTokens(query);
    if (qTokens.length === 0) return [];

    const scored = [];
    for (const entry of this.entries) {
      if (locale && entry.locale !== locale) continue;
      let score = 0;
      const hit = [];
      for (const kw of entry.keywords) {
        const k = normalize(kw);
        if (!k || STOPWORDS.has(k)) continue;
        if (qTokens.includes(k) || qTokens.some((t) => isPartialMatch(t, k))) {
          score += 2;
          hit.push(kw);
        }
      }
      const titleTokens = contentTokens(entry.title);
      for (const t of titleTokens) if (qTokens.includes(t)) score += 1;
      if (score > 0) {
        scored.push({
          entry,
          score,
          matched: hit,
          expired: this.isExpired(entry, at),
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  byTopic(topicId) {
    return this.entries.filter((e) => e.topic_id === topicId);
  }

  conflictsFor(results) {
    if (results.length < 2) return [];
    const top = results[0];
    return results.filter(
      (r) => r.entry.topic_id === top.entry.topic_id && r.entry.claim_id !== top.entry.claim_id && r.entry.answer !== top.entry.answer
    );
  }
}
