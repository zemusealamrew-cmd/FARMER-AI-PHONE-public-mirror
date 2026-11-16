import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inspectGeneratedReply} from '../app/src/generation-guard.mjs';
test('G1 generative adapter rejects observed repetitive output and incompatible script, without claiming language understanding',()=>{
 assert.equal(inspectGeneratedReply('እንደ እንደ ነው '.repeat(8),'am').code,'MODEL_OUTPUT_REPETITIVE');
 const observed='አንጻ ሁለት በሬዎች አሉኝ፣ እና ሁለት በሬዎች አሉኝ እንደ እኛ እንደ እኛ እንደ እኛ እንደ እኛ እንደ እኛ ';
 assert.equal(inspectGeneratedReply(observed,'am').code,'MODEL_OUTPUT_REPETITIVE');
 const actualOromo=JSON.parse(readFileSync(new URL('../evidence/g1-loop-guard-before-2026-11-07.json',import.meta.url))).actual_model_output;
 assert.equal(inspectGeneratedReply(actualOromo,'om').code,'MODEL_OUTPUT_REPETITIVE');
 const voiceRun=JSON.parse(readFileSync(new URL('../evidence/g1-real-voice-restored-2026-11-07.json',import.meta.url)));
 const repeatedParagraph=voiceRun.results.find(r=>r.case==='author-human-voice-to-voice'&&r.locale==='om').actual.text;
 assert.equal(inspectGeneratedReply(repeatedParagraph,'om').code,'MODEL_OUTPUT_REPETITIVE');
 assert.equal(inspectGeneratedReply('Maqaan kee Caalaa dha. Sangoota lama qabda. Maqaan kee sirrii dha.','om').ok,true);
 assert.equal(inspectGeneratedReply('Maqaan koo eenyu? Sangoota meeqa qaba?','om','Maqaan koo eenyu? Sangoota meeqa qaba?').code,'MODEL_ECHO_ONLY');
 assert.equal(inspectGeneratedReply('This is only English.','am').code,'MODEL_LANGUAGE_MISMATCH');
 assert.equal(inspectGeneratedReply('ሰላም። ተጨማሪ መረጃ ይስጡኝ።','am').ok,true);
 assert.equal(inspectGeneratedReply('Maqaan kee Caalaa dha.','om').ok,true);
 assert.equal(inspectGeneratedReply('This is English, not proven Oromo.','om').language_verified,false);
});

test('internal prompt/facts labels are rejected instead of shown to the user', () => {
  const leaked = inspectGeneratedReply('የቅርብ ጊዜ የተጠቃሚ መረጃ፦ የቀድሞ መረጃ፦ ከሁለት ሳምንት ወዲህ ዝናብ አልጣለም።', 'am', 'ዝናብ አልጣለም?');
  assert.equal(leaked.ok, false);
  assert.equal(leaked.code, 'MODEL_OUTPUT_INTERNAL_LEAK');
  const clean = inspectGeneratedReply('የቀድሞው መረጃ ከሁለት ሳምንት ወዲህ ዝናብ አልጣለም ነበር።', 'am', 'ዝናብ አልጣለም?');
  assert.notEqual(clean.code, 'MODEL_OUTPUT_INTERNAL_LEAK');
});

test('Oromo replies in English are rejected (Latin script is not language ID)', () => {
  const english = "Former US President George H. W. Bush said: Bush's view was that if a son didn't grow up to be a soldier, then the family should be allowed to disown its son.";
  assert.equal(inspectGeneratedReply(english, 'om', 'Roobni hin roobne.').code, 'MODEL_LANGUAGE_MISMATCH');
  const oromo = "Roobni torban sadii hin roobne. Maaloo boqqolloo keessanii keessa jiru ilaalaa.";
  assert.notEqual(inspectGeneratedReply(oromo, 'om', 'Roobni hin roobne.').code, 'MODEL_LANGUAGE_MISMATCH');
});
