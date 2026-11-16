import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOfflineModel, stopOfflineWorker, offlineModelStatus } from '../app/src/offline-models.mjs';

test('G1 offline model backend requires explicit opt-in and does not claim acceptance', async () => {
  const original=process.env.G1_OFFLINE_MODELS;
  try {delete process.env.G1_OFFLINE_MODELS;assert.equal((await runOfflineModel({kind:'asr'})).code,'OFFLINE_MODELS_DISABLED');assert.equal(offlineModelStatus().acceptance,'REQUIRES EVIDENCE');}
  finally {if(original===undefined)delete process.env.G1_OFFLINE_MODELS;else process.env.G1_OFFLINE_MODELS=original;}
});

test('G1 model admission is bounded; interruption releases pending work and permits a clean restart', {skip:process.platform==='win32'}, async () => {
  const dir=mkdtempSync(join(tmpdir(),'g1-worker-contract-'));
  const script=join(dir,'worker.mjs'),launcher=join(dir,'python');
  writeFileSync(script,"import {createInterface} from 'node:readline'; createInterface({input:process.stdin}).on('line',line=>{const job=JSON.parse(line);if(job.kind!=='hold')console.log(JSON.stringify({ok:true,code:'TEST_REPLY'}));});");
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  writeFileSync(launcher,'#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(script)+'\n');chmodSync(launcher,0o755);
  const before={enabled:process.env.G1_OFFLINE_MODELS,python:process.env.G1_MODEL_PYTHON};
  try {
    process.env.G1_OFFLINE_MODELS='1';process.env.G1_MODEL_PYTHON=launcher;
    const pending=runOfflineModel({kind:'hold'});
    assert.equal((await runOfflineModel({kind:'next'})).code,'OFFLINE_MODEL_BUSY');
    stopOfflineWorker();assert.equal((await pending).code,'OFFLINE_MODEL_INTERRUPTED');
    assert.equal((await runOfflineModel({kind:'next'})).code,'TEST_REPLY');
    assert.equal((await runOfflineModel({kind:'hold'},50)).code,'OFFLINE_MODEL_TIMEOUT');
    assert.equal((await runOfflineModel({kind:'next'})).code,'TEST_REPLY');
  } finally {
    stopOfflineWorker();if(before.enabled===undefined)delete process.env.G1_OFFLINE_MODELS;else process.env.G1_OFFLINE_MODELS=before.enabled;
    if(before.python===undefined)delete process.env.G1_MODEL_PYTHON;else process.env.G1_MODEL_PYTHON=before.python;
    rmSync(dir,{recursive:true,force:true});
  }
});
