import { normalize } from './util.mjs';

const HIGH_RISK_PATTERNS = [
  { id: 'chemical_dose', re: /(መርዝ|ኬሚካል|qoricha|kemikaalii)/, doseRe: /(መጠን|ስንት|ስንት ጠብታ|hamma|meeqa|drops?|ml|ሚሊ)/ },
  { id: 'human_medicine', re: /(መድኃኒት|መድሃኒት|ታውላ|በሽታ|qoricha|dhukkuba)/, doseRe: /(መጠን|ስንት|hamma|meeqa|mg|ሚሊ)/ },
  { id: 'vet_medicine', re: /(እንስሳ.*መድኃኒት|beeylada.*qoricha)/, doseRe: /(መጠን|ስንት|hamma|meeqa)/ },
  { id: 'emergency', re: /(አደጋ|ድንገት|መርዝ ጠጣ|balaa|hatattama)/, doseRe: /.*/ },
];

// F-13 / R-24 / OP-10፦ ማይታመን ምንጭ (SMS፣ FM፣ ማስታወሻ) ውስጥ የተገጠመ ትእዛዝ መለያ።
// የአማርኛ ቃላት በቅርንጫፍ (stem) ተጻፉ፦ ትእዛዝ/ትእዛዞችን፣ መመሪያ/መመሪያዎች ስለሚለዋወጡ ሙሉ ቃል መፈለግ
// አያልፋቸውም። ግቤቱ ለራሱና ለተነጻጨረው (normalize) ቅጂ ይፈተሻል፤ ቅደም ተከተሉ የማይቀየር ስለሆነ ሁለቱም ቅርጸቶች ተደርገዋል።
const UNTRUSTED_INSTRUCTION = [
  /ignore (all )?(previous|prior) instructions/i,
  /(ከላይ|ያለፈ|ቀድሞ|ሁሉንም).{0,24}(ትእዛ|መመሪ)/,
  /(ትእዛ|መመሪ).{0,20}(ተው|አጥፋ|አትሰማ|አትከተል|ለውጥ|ሁሉን)/,
  /(delete|erase|format|wipe).{0,24}(file|data|storage|folder)/i,
  /(ፋይል|መረጃ|ዝርዝር|ማከማቻ).{0,20}(አጥፋ|አጠፋ|ሰርዝ|አግልል|አጥፉ|ሰርዙ)/,
  /(አጥፋ|አጠፋ|ሰርዝ|delete|erase|wipe|format).{0,24}(ፋይል|መረጃ|ዝርዝር|ማከማቻ|file|data|storage)/i,
  /(send|transfer).{0,24}(money|birr|account)/i,
  /(ላክ|ላኩ|ያስተላልፍ|ክፈሉ|ክፍያ).{0,24}(ብር|ገንዘብ|አካውንት)/,
  /(ብር|ገንዘብ|አካውንት).{0,24}(ላክ|ላኩ|ያስተላልፍ|ክፈሉ|ክፍያ)/,
  /(call|dial).{0,24}(premium|international)/i,
  /(ደውል|ደውሉ|አጎብለል).{0,24}(የውጭ|ዓለም|ፕሬሚየም|ዋጋ ባለው ቁጥር)/,
  /(otp|password|pin|secret code|ኮድ|የይለፍ ቃል|ማረጋገጢያ).{0,24}(send|share|read|tell|ላክ|ላኩ|አጋራ|ጋራ|ነግር|ንበብ)/i,
  /(send|share|read|tell|ላክ|ላኩ|አጋራ|ጋራ|ነግር|ንበብ).{0,24}(otp|password|pin|ኮድ|የይለፍ ቃል|ማረጋገጢያ)/i,
  /(activate|install).{0,24}(app|software|program)/i,
  /(ጫን|ክፈት|ተካ).{0,24}(መተግበሪያ|ሶፍትዌር|ትእዛዝ)/,
];

export function detectUntrustedInstruction(text) {
  const raw = String(text ?? '');
  const n = normalize(raw);
  const matched = [];
  for (const re of UNTRUSTED_INSTRUCTION) {
    if (re.test(raw) || re.test(n)) matched.push(String(re));
  }
  return { untrusted: matched.length > 0, matched };
}

export function classifyRisk(text, locale) {
  const n = normalize(text);
  const hits = [];
  let level = 'low';
  for (const p of HIGH_RISK_PATTERNS) {
    if (p.re.test(n) && p.doseRe.test(n)) {
      hits.push(p.id);
      level = 'high';
    }
  }
  if (level !== 'high' && /(መርዝ|ኬሚካል|qoricha|kemikaalii)/.test(n)) level = 'medium';
  return { level, reasons: hits, locale };
}

export function redactOtp(text) {
  return String(text ?? '')
    .replace(/\b\d{4,8}\b/g, (m) => (m.length >= 4 && m.length <= 8 ? '••••' : m))
    .replace(/(OTP|ኮድ|code)\s*[:：-]?\s*[A-Za-z0-9]{4,8}/gi, '$1 ••••');
}

export function safetyGate({ text, risk, topResult, locale }) {
  const am = locale !== 'om';
  if (risk.level === 'high') {
    const doseQuery = risk.reasons.some((r) => r.endsWith('_dose') || r === 'human_medicine' || r === 'vet_medicine');
    return {
      blocked: true,
      action: 'REFUSE_SPECIFIC_DOSAGE_AND_ESCALATE',
      message: am
        ? 'ይህ የአደጋ ጥያቄ ነው። ትክክለኛ መጠን ወይም የሕክምና ውሳኔ በግምት አልሰጥም። እባክዎ የግብርና ባለሙያውን ወይም የጤና/እንስሳት ሐኪምን ያነጋግሩ።'
        : 'Gaaffiin kun balaa qaba. Hamma sirrii ykn murtee fayyaa tilmaamaan hin kennu. Ogeessa qonnaa ykn hakiima fayyaa/beeyladaa qunnamaa.',
      doseQuery,
      topClaimId: topResult?.entry?.claim_id ?? null,
    };
  }
  if (risk.level === 'medium') {
    return {
      blocked: false,
      action: 'ANSWER_WITH_CAUTION',
      message: am ? 'መረጃው ጊዜው ያለፈበት ሊሆን ይችላል፤ ከምንጭ ያረጋግጡ።' : 'Odeeffannoon yeroo darbe ta’uu danda’a; madda irraa mirkaneessaa.',
    };
  }
  return { blocked: false, action: 'ANSWER', message: null };
}
