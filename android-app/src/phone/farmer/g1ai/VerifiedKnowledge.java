package phone.farmer.g1ai;

import java.util.Locale;

/**
 * Offline, source-cited Amharic retrieval for high-frequency farmer questions.
 * This path does NOT load the LLM; it is the fast/reliable route for covered topics.
 * Content is intentionally conservative: uncertain diagnosis is referred to local extension.
 */
final class VerifiedKnowledge {
  static final class Result {
    final String id; final String answer; final String source; final boolean followup;
    Result(String id, String answer, String source, boolean followup) { this.id = id; this.answer = answer; this.source = source; this.followup = followup; }
  }
  static final class Entry {
    final String id; final String[] keywords; final String answer; final String source;
    Entry(String id, String[] keywords, String answer, String source) {
      this.id = id; this.keywords = keywords; this.answer = answer; this.source = source;
    }
  }
  static final Entry[] ENTRIES = new Entry[] {
    new Entry("KB-AM-CABBAGE-01", new String[]{"ጎመን", "ነጭ", "ነጥብ", "ቅጠል", "ነጭ ነጥብ"},
      "በጎመን ላይ ነጭ ነጥብ ብዙውን ጊዜ የነጭ ዝገት (Albugo candida)፣ የዱቄት ፈንገስ ወይም የነፍሳት ጉዳት ነው። የነጭ ዝገት ቅጠል ላይ ከፍ ያለ ነጭ አረፋ ያመጣል፤ በቀዝቃዛና እርጥብ የአየር ሁኔታ ይስፋፋል። የተጎዱ ቅጠሎችን አስወግድ፣ ተክሎችን 45–60 ሴ.ሜ አራራቅ፣ ውሃን ከቅጠል በላይ አታፍስስ፣ 2–3 ዓመት ከብረታማ ቤተሰብ ጋር አትዘራ። ዱቄቱ በእጅ ከተጠረገ የዱቄት ፈንገስ ነው፤ አየርና ፀሐይ እንዲያገኝ አድርግ። መርዝ የሚመረጠው በሽታው ከተረጋገጠ በኋላ በተመዘገበ መርዝ መለያ መሠረት ነው።",
      "FAO IPM / የአካባቢ እርሻ ኤክስቴንሽን መመሪያ"),
    new Entry("KB-AM-SOIL-01", new String[]{"አፈር", "መሬት", "ማዘጋጀት", "ማረስ", "ማጽዳት"},
      "አፈርን 15–20 ሴ.ሜ ጥልቀት ማረስ ሥሮች እንዲዘልቁ፣ አየርና ውሃ እንዲገቡ ይረዳል። ተክል ቅሪትን አጽዱ፣ ኮምፖስት ወይም የበሰበሰ ፍግ በአፈር ምርመራ መሰረት ጨምሩ፤ ኦርጋኒክ ንጥረ ነገር ውሃን ይይዛል። እርጥበትን በማልቻ/ጭቃ ጠብቁ፤ በተዳፋት መሬት ኮንቱር ቋሚና የውሃ መውረጃ ይስሩ።",
      "FAO የመሬት/ውሃ መመሪያ / የአካባቢ ኤክስቴንሽን"),
    new Entry("KB-AM-MAIZE-01", new String[]{"በቆሎ", "ዘር", "መዝራት", "ረድፍ", "አቀማመጥ"},
      "በቆሎን በረድፍ መዝራት ቅጠሎች ብርሃን እንዲያገኙ፣ አየር እንዲዘዋወርና አረም/ማዳበሪያ በቀላሉ እንዲተዳደሩ ይረዳል። ለመካከለኛ ዕድሜ ዝርያ በቂ ዝናብ ባለበት ረድፍ 75 ሴ.ሜ፣ በረድፍ 25–30 ሴ.ሜ (≈53,000–57,000 ተክል/ሄክታር) ይዘራል። ዘርን 4–5 ሴ.ሜ ጥልቅ ዝሩ፣ ማዳበሪያን በአፈር ምርመራ መሰረት ይጠቀሙ፣ በ2–3 ሳምንት አረም ያጽዱ።",
      "FAO/የኢትዮጵያ ኤክስቴንሽን የበቆሎ መመሪያ"),
    new Entry("KB-AM-LIVESTOCK-01", new String[]{"ከብት", "ውሃ", "መጠጣት", "እንስሳ", "በቂ ውሃ"},
      "ውሃ የእንስሳት ሰውነት ሙቀት፣ ወተት ምርትና መኖ መፈጨት ይረዳል፤ ወተት 87% ውሃ ነው። ላም ~30–50 ሊት/ቀን፣ ወተት ሰጪ 60–100+ ሊት፣ በግ/ፍየል 3–6 ሊት ይፈልጋል (ሙቀት/መኖ ይለያያል)። ንጹህ ውሃ በቀን ቢያንስ 2 ጊዜ፣ ጥላ፣ ንጹህ መያዣ ያዘጋጁ።",
      "FAO የእንስሳት እንክብካቤ መመሪያ / የአካባቢ ኤክስቴንሽን"),
    new Entry("KB-AM-PESTICIDE-01", new String[]{"መርዝ", "ኬሚካል", "ጥንቃቄ", "መርጨት", "መርዝ መጠን"},
      "መርዝ በቆዳ፣ በመተንፈሻ አካልና በአይን ይገባል፤ ስለዚህ ጓንት/ጭምብል/ልብስ ያስፈልጋል። ተባዩን/በሽታውን ካወቁ በኋላ በኢትዮጵያ የተመዘገበ መርዝ ይምረጡ፣ መለያውን ያንብቡ፣ ልጆች/እንስሳትን ያርቁ፣ ከመርጨት በኋላ በሳሙና ይታጠቡ። መጠኑን በመለያው መሰረት ብቻ ይጠቀሙ።",
      "FAO/WHO የፀረ-ተህዋሲያን ደህንነት መመሪያ"),
    new Entry("KB-AM-MARKET-01", new String[]{"ገበያ", "ዋጋ", "ሽያጭ", "ግዢ", "የዛሬ ዋጋ"},
      "የገበያ ዋጋ በአቅርቦት፣ በጥራት፣ በወቅትና በግዢ ፍላጎት ይወሰናል። ከአካባቢ ገበያ፣ ከአንድ ላይ ማህበራት ዋጋ ያወዳድሩ፤ የመመዘኛ/መያዣ/ትራንስፖርት ወጪ ግምት ውስጥ ያስገቡ፤ ከመሸጥዎ በፊት ቢያንስ 2 ምንጮችን ያረጋግጡ።",
      "የአካባቢ ገበያ መረጃ / ኤክስቴንሽን"),
    new Entry("KB-AM-MAIZE-FERT-01", new String[]{"ማዳበሪያ", "ዩሪያ", "ዲኤፒ", "ናይትሮጅን", "በቆሎ ማዳበሪያ"},
      "የበቆሎ ማዳበሪያ በአፈር ምርመራ ይወሰናል። በተለምዶ ለአንድ ሄክታር 100–150 ኪ.ግ ናይትሮጅን፣ 46–92 ኪ.ግ ፎስፌት እና 60–120 ኪ.ግ ፖታሽ ይመከራል፤ ይህም በዝርያ/አፈር/አካባቢ ይለያያል። ሲዘራ 1/3 ናይትሮጅንና ሁሉን ፎስፌት/ፖታሽ ይስጡ፤ በ6–8 ሳምንት ቀሪውን ናይትሮጅን ይስጡ።",
      "FAO/የኢትዮጵያ ኤክስቴንሽን የሰብል ምግብ መመሪያ"),
    new Entry("KB-AM-FALLARMY-01", new String[]{"ፎል አርሚወርም", "የበቆሎ ተባይ", "አባጨጓሬ", "የቅጠል ቀዳዳ", "ነጭ ፍሬ"},
      "የፎል አርሚወርም አባጨጓሬ በበቆሎ ውስጥ ቅጠል ይበላል፤ በቅጠል ቀዳዳ፣ በሰም መሰል ፍሬና በተጠመጠመ የአየር ክፍል ይታወቃል። በየሳምንቱ 10 ተክሎችን ይመርምሩ፤ የተጎዱ ክፍሎችን አስወግዱ፤ አየር/ፀሐይ እንዲያገኝ አድርጉ፤ የተመዘገበ ባዮሎጂካል ወይም ኬሚካል መፍትሄ ከኤክስቴንሽን ይመረጣል።",
      "FAO/IPM የፎል አርሚወርም መመሪያ"),
    new Entry("KB-AM-CABBAGE-PEST-01", new String[]{"ጎመን ተባይ", "አባጨጓሬ", "አፊድ", "ቀዳዳ", "ነጭ ዝንብ"},
      "የጎመን ቅጠል ላይ ቀዳዳ/አባጨጓሬ ካለ የአረንጓዴ አባጨጓሬ፣ አፊድ ወይም የነጭ ዝንብ ሊሆን ይችላል። ቅጠሉን ወደ ታች አገላብጠው እንቁላል/አባጨጓሬ ይፈልጉ፤ የተጎዱ ቅጠሎችን ያስወግዱ፤ ወፎችና ጠቃሚ ነፍሳት እንዲኖሩ ያድርጉ። መርዝ ከተባዩ መለያ መሰረት ብቻ።",
      "FAO/IPM የጎመን ተባይ መመሪያ"),
    new Entry("KB-AM-CHICKEN-01", new String[]{"ዶሮ", "እንቁላል", "ዶሮ መኖ", "ዶሮ ጤና", "ኮርክ"},
      "የዶሮ ጤና ለማረጋገጥ ንጹህ ውሃ፣ የተመጣጠነ መኖ (ተከማች/ፕሮቲን/ማዕድን)፣ ንጹህ መጠለያና በቂ አየር ያስፈልጋል። የመኖ መጠን በዕድሜ/ዓይነት ይለያያል፤ የተለያዩ ዕድሜዎችን አታደባልቁ። የመተንፈሻ/የሆድ ህመም ምልክት ካለ ከእንስሳት ህክምና ባለሙያ ጋር ያማክሩ።",
      "FAO የእንስሳት እንክብካቤ መመሪያ"),
    new Entry("KB-AM-DAIRY-FEED-01", new String[]{"ላም መኖ", "ወተት", "ተከማች መኖ", "ሳር", "የወተት ላም"},
      "ወተት ሰጪ ላም ጥራት ያለው ሳር/ለምለም መኖ፣ የተመጣጠነ ተከማች መኖ፣ ማዕድንና ንጹህ ውሃ ያስፈልጋታል። የመኖ መጠን በክብደት፣ በወተት መጠንና በአካባቢ ይወሰናል፤ በድንገት መኖ አይቀይሩ። የተመጣጠነ የተከማች መኖ መጠን ከእንስሳት ኤክስቴንሽን ያረጋግጡ።",
      "FAO የወተት እንስሳት መመሪያ"),
    new Entry("KB-AM-COMPOST-01", new String[]{"ኮምፖስት", "ፍግ", "ኦርጋኒክ", "አፈር ማዳበሪያ"},
      "ኮምፖስት ለማዘጋጀት ደረቅ ቅጠል/ሳር፣ አረንጓዴ ቅሪት፣ የእንስሳት ፍግ እና አፈር በተራራማ ቁልቁል ደረቅ/እርጥብ በማድረግ ይቀላቀላሉ። በየ2–3 ሳምንቱ ይገለብጡ፤ በ2–3 ወር ውስጥ ይበሰብሳል። ጎርፍ/ፀሐይ እንዳይመታው ጥላ ያድርጉ።",
      "FAO የአፈር ለምነት መመሪያ"),
    new Entry("KB-AM-STORAGE-01", new String[]{"ማከማቸት", "መጋዘን", "እርጥበት", "ብናኝ", "ጥቅል"},
      "ምርትን ከማከማቸት በፊት በፀሐይ ላይ በቂ ማድረቅ፣ የተበላሸውን መለየት እና ንጹህ/ደረቅ መጋዘን ማዘጋጀት ያስፈልጋል። እርጥበት ከ12–13% በታች ይሁን (ለእህል)፤ ጎተራው አየር እንዲዘዋወር፣ ከመሬት/ግድግዳ ርቆ እንዲቀመጥ ያድርጉ። በየወሩ ለብናኝ/እርጥበት ይመርምሩ።",
      "FAO የድህረ-ምርት አያያዝ መመሪያ"),
    new Entry("KB-AM-IRRIGATION-01", new String[]{"መስኖ", "ውሃ", "ማጠራቀሚያ", "እርጥበት", "ድርቅ"},
      "ውሃን በብቃት ለመጠቀም የአፈር እርጥበትን በየ3–5 ቀኑ ይመርምሩ፤ ጠዋት ወይም ማታ ያጠጡ፤ ቅጠል ላይ አያፍስሱ። የውሃ መጠን በሰብል/አፈር/ወቅት ይወሰናል፤ የመውረጃ ቦይና ማልቻ ያዘጋጁ። የዝናብ ውሃ ማጠራቀሚያ በተቻለ መጠን ይጠቀሙ።",
      "FAO የውሃ አያያዝ መመሪያ"),
    new Entry("KB-AM-PHONE-01", new String[]{"ai ቁልፍ", "sms", "OTP", "ፈቃድ", "ስልክ"},
      "AI ቁልፍ ON አድርገው «ጠይቅ» (ፈጣን ጽሑፍ) ወይም «ውይይት ጀምር» (ድምፅ) ይጠቀሙ። የድምፅ ጥያቄ ASR ስለሚፈልግ ይቀዘፋል። SMS የሚነበበው በፍቃድና AI ቁልፍ ብቻ ነው፤ OTP/የግል መልእክት አይነበብም፤ ፈቃድ ሲሻር የተገኘው መረጃ ይጠፋል።",
      "FARMER-AI-PHONE የተጠቃሚ መመሪያ")
  };

  private static final java.util.Map<String, String> FOLLOWUPS = new java.util.HashMap<>();
  static {
    FOLLOWUPS.put("KB-AM-CABBAGE-01", "ተጨማሪ እርምጃ፦ 1) የተጎዱ ቅጠሎችን በፕላስቲክ አሽገው ከእርሻ ውጪ ያጥፉ። 2) በየ3–4 ቀኑ 10 ተክሎችን ይመርምሩ። 3) ውሃን ጠዋት ብቻ ይስጡ፤ ቅጠል ማታ እርጥብ አይሁን። 4) በሽታው ከተስፋፋ የተመዘገበ ፈንገስ መድኃኒት ከኤክስቴንሽን ባለሙያ ጋር ይምረጡ።");
    FOLLOWUPS.put("KB-AM-MAIZE-01", "ተጨማሪ እርምጃ፦ 1) የአፈር እርጥበት በቂ ሲሆን ዝሩ፤ ዘርን 4–5 ሴ.ሜ ጥልቅ ያድርጉ። 2) ማዳበሪያን በአፈር ምርመራ መሰረት በዝርያው መጠን ይጠቀሙ። 3) በ2–3 ሳምንት አረም ያጽዱ፤ በ6–8 ሳምንት የላይኛውን ማዳበሪያ ይስጡ። 4) የገመድ ተባይ/የበሽታ ምልክት በየሳምንቱ ይመርምሩ።");
    FOLLOWUPS.put("KB-AM-LIVESTOCK-01", "ተጨማሪ እርምጃ፦ 1) ውሃ በቀን ቢያንስ 2 ጊዜ ይስጡ፤ በሙቀት ጊዜ 3–4 ጊዜ። 2) የውሃ መያዣውን በየቀኑ ያጽዱ፤ አረንጓዴ ውሃ አይስጡ። 3) የድርቀት ምልክት፦ ዓይን ወደ ውስጥ መግባት፣ ቆዳ መሳብ፣ ምግብ መቀነስ። 4) ምልክቱ ካለ ወተት/ስጋ መቀነስ ይታያል፤ ከእንስሳት ህክምና ባለሙያ ያማክሩ።");
    FOLLOWUPS.put("KB-AM-SOIL-01", "ተጨማሪ እርምጃ፦ 1) አፈርን 15–20 ሴ.ሜ አርሱ፤ የሚበረክት ንብርብር ይጠብቁ። 2) ኮምፖስት/የበሰበሰ ፍግ በአፈር ምርመራ መሰረት ይጨምሩ። 3) በተዳፋት መሬት ኮንቱር ቋሚና የውሃ መውረጃ ይስሩ። 4) አፈርን በየ2–3 ዓመቱ ይመርምሩ፤ ኦርጋኒክ ንጥረ ነገርን ይጨምሩ።");
    FOLLOWUPS.put("KB-AM-PESTICIDE-01", "ተጨማሪ እርምጃ፦ 1) ተባዩን/በሽታውን ከመወሰን በፊት መርዝ አይጠቀሙ። 2) የተመዘገበ መርዝ ብቻ ይምረጡ፤ መለያውን ያንብቡ። 3) ጓንት/ጭምብል/ልብስ ይጠቀሙ፤ ልጆች/እንስሳትን ያርቁ። 4) ከመርጨት በኋላ በሳሙና ይታጠቡ፤ መያዣውን በአግባቡ ያስወግዱ።");
    FOLLOWUPS.put("KB-AM-MARKET-01", "ተጨማሪ እርምጃ፦ 1) የአካባቢውን የዛሬ ዋጋ ከ2 ምንጮች ያረጋግጡ። 2) የጥራት ደረጃውን (A/B/C) ይለዩ። 3) የመያዣ/ትራንስፖርት/ኪሳራ ወጪ ጨምረው የተጣራ ትርፍ ያሰሉ። 4) በማህበር ወይም በቡድን ሽያጭ የተሻለ ዋጋ ሊያገኙ ይችላሉ።");
  }

  private static Entry byId(String id) { for (Entry e : ENTRIES) if (e.id.equals(id)) return e; return null; }

  static Result lookup(String q, String lastTopicId) {
    if (q == null || q.trim().isEmpty()) return null;
    final String n = q.toLowerCase(Locale.ROOT);
    Entry best = null; int bestScore = 0;
    for (Entry e : ENTRIES) { int score = 0; for (String k : e.keywords) if (n.contains(k.toLowerCase(Locale.ROOT))) score += 2 + Math.min(8, k.length() / 3); if (score > bestScore) { bestScore = score; best = e; } }
    if (best != null && bestScore >= 2) return new Result(best.id, best.answer, best.source, false);
    if (lastTopicId != null && (n.contains("ለምን") || n.contains("ተጨማሪ") || n.contains("ዝርዝር") || n.contains("እርምጃ") || n.contains("ምን ላድርግ") || n.contains("ስለዚህ") || n.contains("እንዴት አድርጌ") || n.contains("ቀጥል"))) {
      Entry prev = byId(lastTopicId);
      if (prev != null && FOLLOWUPS.containsKey(prev.id)) return new Result(prev.id, FOLLOWUPS.get(prev.id), prev.source, true);
    }
    // Fast-first guarantee: if no exact KB entry matched, return a category-grounded
    // clarifying answer immediately; the slow LLM is optional, not the default for every question.
    if (q != null && !q.trim().isEmpty()) {
      if (n.contains("ሰብል") || n.contains("ተክል") || n.contains("ቅጠል") || n.contains("ዘር") || n.contains("ማዳበሪያ") || n.contains("አፈር") || n.contains("በሽታ") || n.contains("ተባይ")) {
        return new Result("KB-QUICK-PLANT", "የተክል ጤና/እርሻ ጥያቄ ነው። የሰብሉን ዓይነት፣ የተጎዳውን ክፍል (ቅጠል/ሥር/ፍሬ) እና ምልክቱን (ነጭ/ቢጫ/ቡናማ ነጥብ፣ ቀዳዳ፣ መጠመጥ) ይንገሩኝ፤ በቅርብ ፎቶም ያንሱ። ኬሚካል ከመጠቀም በፊት ምልክቱን ያረጋግጡ።", "የእርሻ አጠቃላይ መመሪያ", true);
      }
      if (n.contains("ከብት") || n.contains("ላም") || n.contains("በግ") || n.contains("ፍየል") || n.contains("ዶሮ") || n.contains("እንስሳ")) {
        return new Result("KB-QUICK-ANIMAL", "የእንስሳ ጤና/እንክብካቤ ጥያቄ ነው። የእንስሳው ዓይነት/ዕድሜ፣ የመብላት/የውሃ/የወተት ሁኔታ እና ምልክቶችን ይንገሩኝ። ንጹህ ውሃና ጥላ ይስጡ፤ ምልክቱ ከባድ ከሆነ ከእንስሳት ህክምና ባለሙያ ጋር ያማክሩ።", "የእንስሳት እንክብካቤ መመሪያ", true);
      }
      if (n.contains("ገበያ") || n.contains("ዋጋ") || n.contains("ሽያጭ") || n.contains("ግዢ")) {
        return new Result("KB-QUICK-MARKET", "የገበያ ጥያቄ ነው። ሰብሉን/ምርቱን፣ መጠኑን፣ ጥራቱን እና የሚሸጡበትን ገበያ ይንገሩኝ። ቢያንስ 2 የአካባቢ ዋጋዎችን ያወዳድሩ፤ የመያዣ/ትራንስፖርት ወጪንም ጨምረው ያሰሉ።", "የአካባቢ ገበያ መመሪያ", true);
      }
      return new Result("KB-QUICK-CLARIFY", "ጥያቄዎን በትክክል ለመመለስ ትንሽ መረጃ ያስፈልጋል። ስለ የትኛው ሰብል/እንስሳ/አፈር/ገበያ እንደሆነ និង ያዩትን ምልክት ይንገሩኝ።", "የእርሻ አጠቃላይ መመሪያ", true);
    }
    return null;
  }

  static Result lookup(String q) { return lookup(q, null); }
}
