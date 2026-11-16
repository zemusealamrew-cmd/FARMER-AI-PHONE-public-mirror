# builder3 — የRAM guard መስፈርት እና የተጠበቁ ውጤቶች (v2.12-wip)

**ሁኔታ፦ የሙከራ አካባቢ የለም — ሁሉም ሙከራዎች UNKNOWN/BLOCKED። ይህ ሰነድ የመስፈርቱን ንድፍ እና የሚጠበቁ ውጤቶችን ብቻ ይዟል።**

## የRAM guard ንድፍ (ኮድ፦ `MainActivity.ramSufficient()`)

**B3-RAM-01 በኮድ ደረጃ ተስተካክሏል፦** የቋሚ 1200MB ደንብ ተክቷል።

| ንጥል | ዋጋ | ማብራሪያ |
|---|---|---|
| የሞዴል መጠን | **በመለኪያ** — `modelFile().length()` በሂደቱ ውስጥ የተጫነው ፋይል ውነታዊ መጠን | የ1.3 ብዜት ወይም ማንኛውም ያልተረጋገጠ ብዜት **አይጠቀምም** (ባለቤት ውድቅ አድርጎታል) |
| የነፃ ትውስታ ልኬት | `ActivityManager.MemoryInfo.availMem` (እውነተኛ የስርዓት ልኬት) | የቋሚ የRAM ግምት ሳይሆን የተለካ |
| Headroom | `MIN_HEADROOM_BYTES = 384MB` | **ያልተመዘገበ (UNCALIBRATED) ቦታ ያዢ** — ለKV-cache/process overhead፤ በተለያዩ መሣሪያዎች በT-DQA-20 ልኬት መመዝገብ አለበት፤ ከዚያ በኋላ ብቻ የተረጋገጠ ይባላል |
| ውሳኔ | `availMem > modelBytes + MIN_HEADROOM_BYTES` | ውሳኔው ለማስረጃ በ`G1RAM` tag ይመዘገባል (availMem፣ modelBytes፣ needed፣ allowed) |
| የሚፈተሽበት መንገዶች | `ask()` (ዋና ጫና)፣ `tts_test`፣ `mic_test` | ሁሉም የድምፅ/የAI መንገዶች በ`aiAllowed()` |

## የተጠበቁ ውጤቶች (አልተካሄዱም — UNKNOWN)

| ሁኔታ | የተጠበቀ ውጤት | verdict ሲካሄድ |
|---|---|---|
| 20-1 emulator `-memory 1536` + autorun ask | `G1RAM` log `allowed=false`፤ llama አይጀምርም፤ ምንም lmkd kill የለም፤ አፕ ሕያው | PASS ከ3/3 ተደጋጋሚ ሩጫ |
| 20-2 በቂ RAM (control) | `allowed=true`፤ llama ይሠራል፤ መልስ ይመለሳል | PASS |
| የheadroom ልኬት | 20-1/20-2 ውጤቶች + የተለመደ የllama RSS ልኬት MIN_HEADROOM_BYTESን ያስተካክላሉ | የተመዘገበ ልኬት ያስፈልጋል |

## ተጨማሪ ማስታወሻ

- Probe script (`android-shell/builder3/probe_dqa17_20_v212.sh`) **ምንም verdict አያስቀምጥም** — ጥሬ ማስረጃ ብቻ፤ PASS/FAIL ክለሳ ይጠይቃል። የጥሪ ማስገባት በemulator console (`adb emu gsm call`) እውነተኛ ነው፤ በእውነተኛ መሣሪያ HUMAN-REQUIRED ሆኖ ይመዘገባል (18-blocker.txt)።
- 17-1/17-2 በ`ai_key_on` test hook በራስ-ሰር ይፈተሻሉ፤ 17-3 key-ON control ማስረጃው እንደሚሠራ ያረጋግጣል።
