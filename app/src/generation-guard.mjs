// Negative-only quality checks. Script compatibility is NOT language identification.
export function inspectGeneratedReply(text, locale, userText = null) {
  const words=String(text??'').trim().split(/\s+/).filter(Boolean);
  const normalize=s=>String(s??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  if(words.length>=5 && userText && normalize(text)===normalize(userText))return {ok:false,code:'MODEL_ECHO_ONLY'};
  if(!words.length)return {ok:false,code:'EMPTY_GENERATION'};
  // Actual CPU probes exposed repeated runs hidden by a varied prefix and an
  // incomplete final token. Check consecutive runs throughout the reply; normal
  // non-adjacent reuse of a word is not itself a repetition failure.
  const tokens=normalize(text).split(/\s+/).filter(Boolean);
  for(let width=1;width<=32;width++){
    const repeats=width>=12?2:Math.max(4,Math.ceil(8/width));
    const needed=width*repeats;
    if(tokens.length<needed)continue;
    for(let start=0;start+needed<=tokens.length;start++){
      if(tokens.slice(start,start+needed).every((token,i)=>token===tokens[start+i%width]))return {ok:false,code:'MODEL_OUTPUT_REPETITIVE'};
    }
  }
  if(words.length>=15){
    const counts=new Map();let repeated=false;
    for(let i=0;i+2<words.length;i++){const gram=words.slice(i,i+3).join(' ');const n=(counts.get(gram)??0)+1;counts.set(gram,n);if(n>=4)repeated=true;}
    if(repeated&&counts.size/(words.length-2)<0.55)return {ok:false,code:'MODEL_OUTPUT_REPETITIVE'};
  }
  // The dialogue prompt/facts block must never be quoted back to the user. This is a
  // negative-only check: any reply containing our internal markers or label phrases is
  // rejected instead of being displayed.
  const INTERNAL = /(\[CORRECTION\]|\[SUPERSEDED\]|LATEST-WINS|OLDER value from the user facts list|አታቅርብ|አትጥቀስ|በቃላትህ ብቻ|ውሂብ ናቸው|የቅርብ ጊዜ የተጠቃሚ መረጃ|የቀድሞ መረጃ፦)/u;
  if (INTERNAL.test(String(text??''))) return {ok:false,code:'MODEL_OUTPUT_INTERNAL_LEAK'};
  const letters=[...String(text)].filter(c=>/\p{L}/u.test(c));
  const expected=locale==='am'?/\p{Script=Ethiopic}/u:/\p{Script=Latin}/u;
  if(letters.length&&letters.filter(c=>expected.test(c)).length/letters.length<0.6)return {ok:false,code:'MODEL_LANGUAGE_MISMATCH'};
  // Latin script is not evidence of Oromo: the pinned model can answer an Oromo turn in
  // English. Reject clearly English replies instead of showing misinformation.
  if(locale==='om'){
    const en=(String(text).toLowerCase().match(/\b(the|and|was|were|said|would|could|should|because|about|from|with|this|that|his|her|their|president|family|people|then|than|have|has|been|will|not)\b/g)||[]).length;
    if(en>=3)return {ok:false,code:'MODEL_LANGUAGE_MISMATCH'};
  }
  return {ok:true,language_verified:false};
}
