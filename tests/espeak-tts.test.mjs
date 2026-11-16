import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ttsStatus } from '../app/src/tts.mjs';

test('experimental commercial-license TTS status does not inherit MMS noncommercial opt-in or claim acceptance', () => {
  const names=['G1_OFFLINE_MODELS','G1_TTS_ENGINE','G1_NONCOMMERCIAL_RESEARCH'];
  const previous=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  try {
    process.env.G1_OFFLINE_MODELS='1';process.env.G1_TTS_ENGINE='espeak-ng';process.env.G1_NONCOMMERCIAL_RESEARCH='0';
    const status=ttsStatus();
    assert.equal(status.license,'GPL-3.0-or-later');
    assert.equal(status.acceptance,'REQUIRES EVIDENCE');
    assert.equal(status.network_required,false);
    assert.deepEqual(Object.keys(status.locale_support),['am','om']);
    assert.equal(status.locale_support.am.code,'UPSTREAM_TESTING_NOT_LISTENER_ACCEPTED');
  } finally {for(const key of names)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
});

test('TTS refuses unsupported locales, empty input and a tampered runtime before executing it', () => {
  const script = `
import sys,tempfile,json,hashlib
from pathlib import Path
sys.path.insert(0,'app/src')
from espeak_tts import synthesize
with tempfile.TemporaryDirectory() as directory:
 root=Path(directory)
 assert synthesize(root,{'locale':'en'})['code']=='TTS_LOCALE_UNSUPPORTED'
 assert synthesize(root,{'text':' '})['code']=='EMPTY_TEXT'
 (root/'model_registry').mkdir()
 (root/'model_registry/espeak-ng-profile.json').write_text(json.dumps({'files':[{'path':'bad','bytes':1,'sha256':'0'*64}]}))
 assert synthesize(root,{'text':'test'})['code']=='ESPEAK_RUNTIME_MISSING'
 (root/'app/bin/espeak-ng').mkdir(parents=True)
 (root/'app/bin/espeak-ng/bad').write_bytes(b'x')
 assert synthesize(root,{'text':'test'})['code']=='ESPEAK_RUNTIME_HASH_MISMATCH'
 if sys.platform=='win32':
  (root/'model_registry/espeak-ng-profile.json').write_text(json.dumps({'files':[{'path':'bad','bytes':1,'sha256':hashlib.sha256(b'x').hexdigest()}]}))
  assert synthesize(root,{'text':'test'})['code']=='TTS_RUNTIME_PLATFORM_UNSUPPORTED'
`;
  const result=spawnSync(process.env.G1_MODEL_PYTHON ?? 'python3',['-c',script],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
