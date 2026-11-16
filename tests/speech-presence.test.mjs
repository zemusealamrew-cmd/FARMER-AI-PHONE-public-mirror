import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectSpeechSignal, validUtterance } from '../app/src/speech-presence.mjs';
function wav(samples) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF'); out.writeUInt32LE(out.length-8,4); out.write('WAVE',8);
  out.write('fmt ',12); out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);
  out.writeUInt32LE(16000,24);out.writeUInt32LE(32000,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);
  out.write('data',36);out.writeUInt32LE(samples.length*2,40);
  samples.forEach((v,i)=>out.writeInt16LE(v,44+i*2)); return out;
}
test('Issue #6: exact pure tones, beeps and DC are negative preflight results independent of ASR availability', () => {
  for (const frequency of [100,440,1000,2000]) for(const amplitude of [3,9000]) {
    const b=wav(Array.from({length:16000},(_,i)=>Math.round(amplitude*Math.sin(2*Math.PI*frequency*i/16000))));
    assert.equal(inspectSpeechSignal(b).code,'NON_SPEECH_CAPTURE');
  }
  assert.equal(inspectSpeechSignal(wav(Array(16000).fill(10))).code,'NON_SPEECH_CAPTURE');
});
test('Issue #6: negative preflight never claims random noise or an unclassified signal is speech', () => {
  let seed=17;
  const b=wav(Array.from({length:16000},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed%1000)-500;}));
  const r=inspectSpeechSignal(b);
  assert.equal(r.ok,true);assert.equal(r.speech_verified,false);
});
test('Issue #6: event-only annotations are not utterances; speech with annotations remains usable', () => {
  for(const text of ['[BEEP]','[noise] [MUSIC]','<|nospeech|>','...',''])assert.equal(validUtterance(text),false);
  for(const text of ['[AMH] ሰላም','[ORM] akkam','[noise] ለምን','beep'])assert.equal(validUtterance(text),true);
});
