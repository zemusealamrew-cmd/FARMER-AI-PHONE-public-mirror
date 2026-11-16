// Real Chromium + synthetic microphone. No human-speech/ASR acceptance claim.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'g1-browser-'));
const pause = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['app/server.mjs'], { cwd: root, env: { ...process.env, PORT: '8977', EVIDENCE_PATH: join(work, 'events.jsonl'), UPDATE_STATE_DIR: join(work, 'updates') }, stdio: 'ignore' });
const browser = spawn(process.env.CHROMIUM ?? '/usr/bin/chromium', ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=8978', `--user-data-dir=${work}/chrome`, 'about:blank'], { stdio: 'ignore' });
let socket;
try {
  let tabs;
  for (let i=0;i<100;i++) { try { tabs=await (await fetch('http://127.0.0.1:8978/json')).json(); if(tabs.length) break; } catch {} await pause(100); }
  assert.ok(tabs?.length, 'Chromium debugging endpoint ready');
  socket = new WebSocket(tabs[0].webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let seq=0; const pending=new Map();
  socket.onmessage=e=>{const m=JSON.parse(e.data); if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}};
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await pause(100);}throw Error('timeout: '+expression);};
  const version=await cdp('Browser.getVersion');
  await cdp('Page.navigate',{url:'http://127.0.0.1:8977'});
  await wait('typeof S !== "undefined" && S.session_id !== null');
  // Observe actual browser tracks/contexts and the real HTTP request; no AudioNode mocks.
  const before = await evaluate(`(async()=>{const s=await navigator.mediaDevices.getUserMedia({audio:true});try{s.getAudioTracks()[0].connect(null);return 'unexpected success';}catch(e){return e.name;}finally{s.getTracks().forEach(t=>t.stop());}})()`);
  assert.equal(before,'TypeError');
  await evaluate(`globalThis.captures=[];globalThis.contexts=[];globalThis.sent=[];
    const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async (...a)=>{const s=await gum(...a);captures.push(s);return s;};
    const AC=AudioContext;globalThis.AudioContext=class extends AC{constructor(...a){super(...a);contexts.push(this);}};
    const f=fetch;globalThis.fetch=async (url,opts)=>{if(url==='/api/audio')sent.push(JSON.parse(opts.body));return f(url,opts);};
    $('aiKey').click(); startRecording();`);
  await wait('S.recording !== null && Number($("recPeak").textContent)>0');
  const level=await evaluate('Number($("recPeak").textContent)');
  await pause(600);
  await evaluate('stopRecording(true)');
  const wav=await evaluate(`sent[0].wav_base64`);
  const bytes=Buffer.from(wav,'base64');
  assert.equal(bytes.readUInt32LE(24),16000);assert.equal(bytes.readUInt16LE(22),1);
  assert.ok(bytes.length>44+9600);
  assert.equal(await evaluate('captures.every(s=>s.getTracks().every(t=>t.readyState==="ended")) && contexts.every(c=>c.state==="closed")'),true);
  const results=[{case:'synthetic capture → real HTTP /api/audio',peak:level,rate:16000,bytes:bytes.length,pass:true}];
  for(const [name,action] of [['cancel','cancelRecording()'],['Escape',`$('recDialog').dispatchEvent(new Event('cancel',{cancelable:true}))`],['AI key off',`$('aiKey').click()`]]){
    await evaluate('startRecording()'); await wait('S.recording !== null');
    await evaluate(action); await wait('S.recording === null && contexts.every(c=>c.state==="closed")');
    assert.equal(await evaluate('sent.length'),1);results.push({case:name,pass:true});
  }
  await evaluate(`$('aiKey').click();startRecording();`);
  await wait('S.recording !== null');
  await evaluate(`$('callIn').onclick()`);
  await wait('S.recording === null && contexts.every(c=>c.state==="closed")');
  assert.equal(await evaluate('sent.length'),1);
  await evaluate(`startRecording()`);
  assert.equal(await evaluate('S.recording === null'),true);
  await evaluate(`$('callEnd').onclick()`);
  results.push({case:'incoming simulated call stops microphone and prevents restart until call ends',pass:true});
  await evaluate(`navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('denied','NotAllowedError');};startRecording();`);
  await wait('S.micRequest === null');assert.equal(await evaluate('S.recording === null && sent.length===1'),true);
  results.push({case:'permission denied (injected rejection)',pass:true});
  const report={date:new Date().toISOString(),browser:version.product,html_sha256:createHash('sha256').update(readFileSync(new URL('../app/public/index.html',import.meta.url))).digest('hex'),before_fix_api_call:before,source:'Chromium fake media device (synthetic signal); permission rejection injected',results,gate:'G1 HOLD / REQUIRES EVIDENCE',limitations:['No physical microphone or consented human speech','No target-language ASR/TTS acceptance','No G2/G3 authorization; G4 NO-GO']};
  writeFileSync(new URL('../evidence/browser-mic-check-2026-11-07.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {socket?.close();browser.kill();server.kill();await pause(500);rmSync(work,{recursive:true,force:true});}
