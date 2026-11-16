package phone.farmer.g1ai;

import java.util.Locale;

/**
 * G1 P0 SAFETY STOP-GATE (2026-11-14, owner Issue #2).
 *
 * Deterministic, pre-output guard: a medication / pesticide / chemical DOSE question must never be
 * answered by the model. The guard is keyword+shape based (NOT an LLM judging itself, NOT prompt-only)
 * and runs in the app BEFORE the reply is shown or sent to TTS.
 *
 * Policy for high-risk intent:
 *   - never return a numeric dose (the model output is discarded);
 *   - return an explicit uncertainty/refusal + referral to a qualified expert;
 *   - language follows the user's language tag (AMH / ORM / English fallback).
 *
 * This is deliberately conservative: G1 has no verified veterinary/medical dosage source, so refusing
 * is the only safe behaviour. A future grounded source can narrow it, with owner approval.
 */
public final class SafetyGuard {
  private SafetyGuard() {}

  /** High-risk substance/medical terms (Amharic, Afaan Oromo, English) — lowercase, substring match. */
  private static final String[] RISK_TERMS = {
      // Amharic
      "መድኃኒት", "መድሃኒት", "መድኅኒት", "መድህኒት", "መድሓኒት", "መድኃኒቶች", "ዶዝ", "ዶሴ",
      "መድ ኃኒት", "መድ ሃኒት", "ታብሌት", "ካፕሱል", "ጠብታ", "መርፌ", "መርዛማ", "መርዝ",
      "ማዳበሪያ", "ዩሪያ", "ዲኤፒ", "fertilizer", "urea", "medhanit", "meten", "ፀረ-ተባይ", "ፀረተባይ", "ፀረ ተባይ", "ኬሚካል",
      "መርዛማ", "መርዝ", "እርጭቆ", "ስፕሬይ", "ጤና", "ሕክምና", "ህክምና", "ክትባት", "መርፌ", "ካፕሱል",
      "ዓይነት መድኃኒት", "ማከም",
      // Afaan Oromo
      "qoricha", "qorichaa", "dawaa", "safara", "keemikaalaa", "keemikaala", "suma", "sumaa",
      "fayyaa", "wal'aansa", "talaallii", "dawa", "qoricha",
      // English
      "medicine", "medication", "medicinal", "dose", "dosage", "pesticide", "herbicide", "insecticide",
      "chemical", "antibiotic", "vaccine", "injection", "mg", "ml", "milligram", "milliliter", "litre",
      "liter", "grams", "gram"
  };

  /** Quantity words that strengthen the dose intent (Amharic / Oromo / English). */
  private static final String[] QUANTITY_TERMS = {
      "ስንት", "ስንት ነው", "መጠን", "መጠኑ", "አንድ ሚሊ", "ሁለት ሚሊ", "hamma", "meeqa", "safara", "how much",
      "how many", "what dose", "what dosage", "quantity", "amount"
  };

  /** Injection / override attempts are refused when combined with a risk term. */
  private static final String[] INJECTION_TERMS = {
      "ignore", "system", "prompt", "instruction", "መመሪያ", "ትእዛዝ", "jailbreak", "developer mode",
      "act as", "pretend", "disregard"
  };

  /** True when the user query is a high-risk dose/medical/chemical request. Conservative. */
  public static boolean isHighRiskQuery(final String query) {
    if (query == null) return false;
    final String q = query.toLowerCase(Locale.ROOT);
    boolean risk = false;
    for (String t : RISK_TERMS) if (q.contains(t)) { risk = true; break; }
    if (!risk) {
      // indirect phrasing: administration verb + quantity/number ("ለልጄ ስንት እንዲወስድ?")
      boolean admin = false;
      for (String v : new String[]{"እንድትወስድ", "እንዲወስድ", "እንድትጠጣ", "እንዲጠጣ", "እንዲሰጥ", "እንድሰጥ", "ጨምር", "ስጥ", "kennuu", "kenna", "fudhadhu"}) {
        if (q.contains(v)) { admin = true; break; }
      }
      boolean qty = false;
      for (String t : QUANTITY_TERMS) if (q.contains(t)) { qty = true; break; }
      if (!qty) for (String n : new String[]{"አንድ", "ሁለት", "ሦስት", "አራት", "አምስት", "ግማሽ"}) if (q.contains(n)) { qty = true; break; }
      if (admin && qty) risk = true;
    }
    if (!risk) return false;
    // RISK term alone is enough for medication/chemical topics: G1 has no grounded dosage source.
    // (Quantity/injection terms make it even clearer and are logged for the evidence record.)
    return true;
  }

  public static boolean hasQuantityIntent(final String query) {
    if (query == null) return false;
    final String q = query.toLowerCase(Locale.ROOT);
    for (String t : QUANTITY_TERMS) if (q.contains(t)) return true;
    return false;
  }

  public static boolean hasInjectionAttempt(final String query) {
    if (query == null) return false;
    final String q = query.toLowerCase(Locale.ROOT);
    for (String t : INJECTION_TERMS) if (q.contains(t)) return true;
    return false;
  }

  /** Deterministic refusal message in the user's language. */
  public static String refusal(final String lang) {
    if ("ORM".equalsIgnoreCase(lang)) {
      return "Gaaffii safaraa/qorichaa ykn keemikaalaa kanaaf safara sirrii ta'e hin kennu. "
          + "Maaloo ogeessa qonnaa ykn hakiima beeyladaa/fayyaa mariisisaa.";
    }
    return "ይህ የመድኃኒት/ኬሚካል መጠን ጥያቄ ነው። ያልተረጋገጠ መጠን አልሰጥም። "
        + "እባክዎ የግብርና ባለሙያ ወይም የእንስሳት/ጤና ሐኪም ያማክሩ።";
  }

  /** Dose/administration patterns in MODEL OUTPUT (post-LLM gate, independent of the query). */
  private static final String[] OUTPUT_RISK_PATTERNS = {
      "መጠን", "dose", "dosage", "safara", "ሚሊ", "ml", "mg", "milligram", "milliliter",
      "ታብሌት", "ካፕሱል", "መርፌ", "injection", "እንድትወስድ", "እንዲወስድ", "እንድትጠጣ", "እንዲጠጣ",
      "ስጥ", "kennuu", "ፀረ-ተባይ", "pesticide", "herbicide", "ኬሚካል", "chemical"
  };

  /** True when an OUTPUT string appears to state a numeric dose / administration instruction. */
  public static boolean outputLooksUnsafe(final String reply) {
    if (reply == null || reply.trim().isEmpty()) return false;
    // strip zero-width / BOM obfuscation before pattern matching
    String cleaned = reply.replace("\u200B", "").replace("\u200C", "").replace("\u200D", "").replace("\uFEFF", "");
    final String r = cleaned.toLowerCase(Locale.ROOT);
    boolean riskWord = false;
    for (String t : OUTPUT_RISK_PATTERNS) if (r.contains(t)) { riskWord = true; break; }
    if (!riskWord) return false;
    // require a digit OR an explicit administration verb to limit false positives on general advice
    boolean numberish = false;
    for (int i = 0; i < r.length(); i++) {
      char c = r.charAt(i);
      // ASCII digits, Ethiopic numerals (U+1369..U+1371), Arabic-Indic digits (U+0660..U+0669)
      if ((c >= '0' && c <= '9') || (c >= '\u1369' && c <= '\u1371') || (c >= '\u0660' && c <= '\u0669')) { numberish = true; break; }
    }
    if (!numberish) {
      for (String n : new String[]{"አንድ", "ሁለት", "ሦስት", "ሶስት", "አራት", "አምስት", "ግማሽ", "tokko", "lama", "sadii", "afur", "shan"}) {
        if (r.contains(n)) { numberish = true; break; }
      }
    }
    boolean admin = false;
    for (String v : new String[]{"እንድትወስድ", "እንዲወስድ", "እንድትጠጣ", "እንዲጠጣ", "እንዲሰጥ", "እንድሰጥ",
        "እንድትሰጥ", "ጨምር", "ስጥ", "kennuu", "kennaa", "kenna", "fudhadhu", "godhi", "give", "take", "apply"}) {
      if (r.contains(v)) { admin = true; break; }
    }
    if (numberish) return true;
    if (admin && (r.contains("መጠን") || r.contains("dose") || r.contains("safara") || r.contains("ml") || r.contains("mg"))) return true;
    return false;
  }

  /** Final TTS gate: the text handed to TTS must be safe even if the query was not high-risk. */
  public static String ttsGate(final String query, final String lang, final String text) {
    if (isHighRiskQuery(query)) return refusal(lang);
    if (outputLooksUnsafe(text)) {
      android.util.Log.i("G1SAFE", "post-LLM output gate: unsafe dose/administration pattern -> DETERMINISTIC_REFUSAL (queryNotFlagged=" + (query == null) + ")");
      return refusal(lang);
    }
    if (hasUnsupportedNumericClaim(query, text)) {
      android.util.Log.i("G1SAFE", "final TTS gate: unsupported numeric claim -> NUMERIC_REFUSAL");
      return numericRefusal(lang);
    }
    return text;
  }

  /** Numeric tokens: ASCII digits, Ethiopic numerals, Arabic-Indic digits. */
  private static final java.util.regex.Pattern NUMERIC_TOKEN =
      java.util.regex.Pattern.compile("[0-9]+(?:[.,][0-9]+)?|[\\u1369-\\u1371]+|[\\u0660-\\u0669]+");
  /** Number words (Amharic / Afaan Oromo / English) that count as numeric claims. */
  private static final String[] NUMBER_WORDS = {
      "አንድ", "ሁለት", "ሦስት", "ሶስት", "አራት", "አምስት", "ስድስት", "ሰባት", "ስምንት", "ዘጠኝ", "አስር",
      "tokko", "lama", "sadii", "afur", "shan", "jaha", "torba", "saddeet", "sagal", "kudhan",
      "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"
  };

  private static java.util.Set<String> numericTokens(final String text) {
    final java.util.Set<String> out = new java.util.HashSet<>();
    if (text == null) return out;
    final String cleaned = text.replace("\u200B", "").replace("\u200C", "").replace("\u200D", "").replace("\uFEFF", "");
    final java.util.regex.Matcher m = NUMERIC_TOKEN.matcher(cleaned);
    while (m.find()) out.add(m.group().toLowerCase(Locale.ROOT));
    for (String w : NUMBER_WORDS) if (cleaned.toLowerCase(Locale.ROOT).contains(w)) out.add(w);
    return out;
  }

  /**
   * R-10 deterministic numeric-warrant guard: a numeric token in the MODEL OUTPUT that did not
   * appear in the user's query is an unsupported numeric claim (no grounding source exists in G1).
   * Example: user asks about maize price, model invents "2000 billaa". Such replies are replaced.
   */
  public static boolean hasUnsupportedNumericClaim(final String query, final String reply) {
    final java.util.Set<String> replyNums = numericTokens(reply);
    if (replyNums.isEmpty()) return false;
    final java.util.Set<String> queryNums = numericTokens(query);
    replyNums.removeAll(queryNums);
    return !replyNums.isEmpty();
  }

  private static String numericRefusal(final String lang) {
    if ("ORM".equalsIgnoreCase(lang)) {
      return "Lakkoofsi deebii keessatti dhufu mirkanaa'ee hin jiru waan ta'eef, "
          + "lakkoofsa sirrii hin kennu. Maaloo ogeessa qonnaa ykn hakiima naannoo mariisisaa.";
    }
    return "በመልሱ ውስጥ ያለው ቁጥር ያልተረጋገጠ ስለሆነ ትክክለኛውን ቁጥር አልሰጥም። "
        + "እባክዎ ትክክለኛውን መረጃ ከአካባቢ ባለሙያ ያረጋግጡ።";
  }

  /**
   * The single pre-output decision point.
   * @return the text that is safe to show/speak (either the original reply or a refusal).
   */
  public static String guardReply(final String query, final String lang, final String reply) {
    // Post-LLM gate runs even when the query itself was not classified high-risk: an unsolicited
    // dose/administration sentence must never be displayed or spoken.
    if (outputLooksUnsafe(reply)) {
      android.util.Log.i("G1SAFE", "post-LLM output gate: unsafe output for query='" + (query == null ? "" : query.length()) + "chars' -> DETERMINISTIC_REFUSAL");
      return refusal(lang);
    }
    if (hasUnsupportedNumericClaim(query, reply)) {
      android.util.Log.i("G1SAFE", "unsupported numeric claim in model output -> NUMERIC_REFUSAL (queryNums="
          + numericTokens(query).size() + ", replyNums=" + numericTokens(reply).size() + ")");
      return numericRefusal(lang);
    }
    if (!isHighRiskQuery(query)) return reply;
    final String refusal = refusal(lang);
    if (reply == null || reply.trim().isEmpty()) return refusal;
    // Even when the model produced something, a high-risk dose question is answered ONLY by the
    // deterministic refusal. Log which branch fired so the evidence records the guard, not the model.
    android.util.Log.i("G1SAFE", "highRiskQuery=1 quantity=" + hasQuantityIntent(query)
        + " injection=" + hasInjectionAttempt(query) + " lang=" + lang
        + " modelReplyChars=" + reply.length() + " -> DETERMINISTIC_REFUSAL");
    return refusal;
  }
}
