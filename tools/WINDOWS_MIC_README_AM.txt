FARMER-AI — በWindows ቀጥታ የማይክ ምርመራ

ይህ ከብሮውዘር የተለየ የG1 ምርመራ መሣሪያ ነው።
Chrome፣ localhost፣ Node፣ Python፣ AI እና የፕሮጀክቱ resampler አይጠቀምም።
Windows 10/11፣ Windows PowerShell 5.1 እና .NET Framework 4.8 ይጠቀማል።
በተለመዱ Windows 10/11 ኮምፒውተሮች ውስጥ እነዚህ አሉ፤ አዲስ SDK አይጫንም።
Windows API/GUI በባለቤቱ ላፕቶፕ ላይ ገና አልተረጋገጡም።

1. ZIP ፋይሉን Extract All በማለት ይፍቱ። ፋይሎቹን በአንድ ማህደር ያስቀምጡ።
2. START-WINDOWS-MIC.cmd የሚለውን በሁለት ጠቅታ ይክፈቱ።
3. በአዲሱ መስኮት የማይክ ፈቃድ ሳጥኑን ይምረጡ።
4. «1. መቅዳት ጀምር» → ጥቂት ሰከንዶች ይናገሩ → «2. መቅዳት አቁም»።
   እርስዎ ካላቆሙት ከ10 ሰከንድ በኋላ በራሱ ይቆማል።
5. «3. ድምፄን አድምጥ» ይጫኑ። የራስዎ ንግግር ነው ወይስ «ሲጥ» ነው የሚሰማው?
6. ሲጨርሱ «ቅጂውን ሰርዝ» ይጫኑና መስኮቱን ይዝጉ።

ይህ የWindows ነባር/default ማይክን ይጠቀማል።
Windows Settings → System → Sound → Input ላይ የተመረጠውን ማይክ ማወቅ ይቻላል።
የWindows ነባር ግቤትና በbrowser የተመረጠው መሣሪያ አንድ መሆናቸው አልተረጋገጠም።
ፈቃድ ከተከለከለ Windows Settings → Privacy (& security) → Microphone → desktop-app access ይፈትሹ።

ግላዊነት፦
- ምንም ድምፅ ወይም መለኪያ አይላክም፤ ኔትወርክ አይጠቀምም።
- Windows የግል WAV በTemp ውስጥ በዚህ ሙከራ ልዩ FarmerAiMic-... ማህደር ያስቀምጣል።
- በመደበኛ cancel/close ይሰረዛል። ፕሮግራሙ በግድ ከተቋረጠ ግን Temp ውስጥ ሊቀር ይችላል።
- «መለኪያ ብቻ አስቀምጥ» audio፣ device name/ID፣ transcript ወይም የፋይል መንገድ የሌለው JSON ብቻ ያስቀምጣል።
- የግል WAV መላክ አያስፈልግም።

WINDOWS_MIC_START_FAILED ወይም WINDOWS_AUDIO_ERROR ከታየ፣ stage/code ብቻ ይመዝግቡ።
የTemp መንገድ የአማርኛ ፊደል ካለው፣ native MCI በተመሳሳይ ማህደር የWindows short-path alias ይጠቀማል።
ASCII alias ከሌለ MCI_UNICODE_PATH_UNSUPPORTED ይታያል፤ ድምፅ ወደ ሌላ ቦታ አይቀዳም።
የማይደገፍ native format/device/Windows policy የራሱን ስህተት ያሳያል፤ የተዘጋጀ tone/ምትክ ድምፅ አይጫወትም።

ውጤት፦
- እዚህ ንግግር ከተሰማ፣ የWindows ቀጥታ መንገድ ለዚህ ሙከራ ይሠራል፤ የG1 browser ችግር በራሱ አልተፈታም።
- እዚህም «ሲጥ»/ጸጥታ ከሆነ፣ የOS default input/output፣ driver፣ privacy/mute፣ መሣሪያ ወይም የዚህ native API ድጋፍ መለየት ይቀጥላል።
- ማይክ ወይም ስፒከር ተበላሽቷል ብሎ ያለ ማስረጃ አይወሰንም።

Stage B FAILED/UNRESOLVED፤ G1 HOLD፤ G2/G3 NOT AUTHORIZED፤ G4 NO-GO።

የPR #18 ቁጥጥር ምላሽ፦
- የWindows ማስነሳት ገና አልተፈተሸም። ከቁጥጥር ፈቃድ በፊት ባለቤቱ ሙከራውን እንዲደግም አይጠየቅም።
- የቀድሞ ቅጂ መሰረዝ ካልተቻለ cleanup-wav / PRIVATE_WAV_DELETE_FAILED ይታያል፤ አዲስ ቅጂ አይጀምርም።
- የመልሶ ማጫወቻውን ከዘጉ በኋላ መሰረዝን መድገም ይቻላል።
- የማስነሳት ስህተት ቢኖር በTemp FarmerAiMic-startup-...json ውስጥ stage/code/HResult ብቻ ይቀመጣል፤ ድምፅና የግል ስህተት ጽሑፍ አይካተቱም።
- በግድ ሲቋረጥ የቀረ የቀድሞ Temp ማህደር በአዲስ ማስነሳት በራሱ አይሰረዝም።
