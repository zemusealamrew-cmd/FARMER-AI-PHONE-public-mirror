// Real local HTTP + model inference, with author-published human input and synthetic follow-up.
// Run preparation first. This tool never downloads models/audio or claims human acceptance.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { platform, release, totalmem, cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inspectWav } from '../app/src/asr.mjs';
import { errorRate, toWav16kMono } from './voice-check.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const work = mkdtempSync(join(tmpdir(),'g1-offline-voice-'));
const hash = data => createHash('sha256').update(data).digest('hex');
const port = Number(process.env.G1_CHECK_PORT ?? 8979);
const base = `http://127.0.0.1:${port}`;
const out = process.argv[2] ?? join(root,'evidence/offline-model-voice-2026-11-07.json');
const report = { date: new Date().toISOString(), host: { platform: platform(), release: release(), logical_cpus: cpus().length, memory_bytes: totalmem() }, branch: process.env.G1_EVIDENCE_BRANCH ?? null, base_commit: process.env.BUILD_REF ?? null, runtime_source_sha256: Object.fromEntries(['app/server.mjs','app/src/offline_models.py','app/src/offline-models.mjs','app/src/generation-guard.mjs','app/src/asr.mjs','app/src/tts.mjs'].map(p=>[p,hash(readFileSync(join(root,p)))])), dialogue_override: process.env.G1_OM_DIALOGUE_MODEL ?? null, model_profile_sha256: hash(readFileSync(join(root,'model_registry/offline-g1-profile.json'))), gate: 'G1 HOLD / REQUIRES EVIDENCE', tts_scope: 'CC-BY-NC-4.0 noncommercial research only', results: [], errors: [], limitations: ['No physical microphone or machine-wide networking-disabled proof','Author demo clips may overlap training; not independent acceptance','Source clip participant consent is not independently verified; source audio is not redistributed','Generated TTS follow-ups are synthetic, not human speech','No native-speaker listening/intelligibility/safety sign-off','No phone feasibility or G1–G4 approval'] };
const save = () => writeFileSync(out,JSON.stringify(report,null,2)+'\n');
report.application_network_namespace = process.env.G1_NETNS_EVIDENCE ? JSON.parse(readFileSync(process.env.G1_NETNS_EVIDENCE,'utf8')) : null;
report.synthetic_followups_enabled = process.env.G1_CHECK_SKIP_SYNTHETIC_FOLLOWUP !== '1';
if (process.env.G1_TTS_ENGINE === 'espeak-ng') report.tts_scope = 'GPL-3.0-or-later experimental formant synthesis; no listener acceptance';
const child = spawn(process.execPath,['app/server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),EVIDENCE_PATH:join(work,'events.jsonl'),UPDATE_STATE_DIR:join(work,'updates'),G1_OFFLINE_MODELS:'1',G1_NONCOMMERCIAL_RESEARCH:process.env.G1_TTS_ENGINE==='espeak-ng'?'0':'1',BUILD_REF:process.env.BUILD_REF??'UNSPECIFIED_WORKING_TREE'},stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',b=>{stderr+=b;});child.stdout.on('data',()=>{});
const post = async (path,body) => {const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(240000)});return {http:response.status,...await response.json()};};
const summarize = r => ({http:r.http,type:r.type,code:r.code,text:r.text?.slice(0,500),transcript_preview:r.transcript?.slice(0,80),transcript_sha256:r.transcript?hash(r.transcript):null,asr:r.asr,model:r.model,metrics:r.metrics,verification:r.verification});
const wav = (kind) => {
 const n=kind==='short'?1000:16000,b=Buffer.alloc(44+n*2);
 b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
 let seed=91;
 for(let i=0;i<n;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const value=kind==='silence'?0:kind==='noise'?(seed%18000)-9000:Math.round(9000*Math.sin(2*Math.PI*(kind==='beep'?2000:440)*i/16000));b.writeInt16LE(value,44+2*i);}return b;
};
try {
 for(let i=0;i<100;i++){try{if((await fetch(base+'/api/status')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const id=(await post('/api/session',{})).session_id;
 for(const kind of ['silence','short','tone','beep','noise']){
  const before=await (await fetch(base+'/api/metrics')).json();const r=await post('/api/audio',{session_id:id,locale:'am',wav_base64:wav(kind).toString('base64')});const after=await(await fetch(base+'/api/metrics')).json();
  const expected=kind==='silence'?'SILENT_CAPTURE':kind==='short'?'AUDIO_TOO_SHORT':'NON_SPEECH_CAPTURE';
  report.results.push({case:kind,expected,actual:summarize(r),pass:r.code===expected,no_successful_asr_increment:before.asr_ms.n===after.asr_ms.n,no_dialogue_increment:before.text_turn_ms.n===after.text_turn_ms.n});save();
 }
 const fixtures=JSON.parse(readFileSync(join(root,'model_registry/g1-speech-fixtures.json')));
 for(const f of fixtures.fixtures.filter(f=>!process.env.G1_CHECK_LOCALE||f.locale===process.env.G1_CHECK_LOCALE)){
  const session=(await post('/api/session',{})).session_id;
  const normalized=toWav16kMono(readFileSync(join(root,f.local_path)));
  if (!normalized.ok) throw new Error(normalized.code);
  const input=normalized.buffer;
  const r=await post('/api/audio',{session_id:session,locale:f.locale,wav_base64:input.toString('base64')});
  const entry={case:'author-human-voice-to-voice',locale:f.locale,input_source:f.url,input_sha256:hash(input),input_seconds:inspectWav(input).seconds,reference_source:fixtures.source_model_card,scores:r.transcript?errorRate(f.reference,r.transcript):null,actual:summarize(r)};
  if(r.text){const spoken=await post('/api/tts',{session_id:session,locale:f.locale,text:r.text});const bytes=spoken.wav_base64?Buffer.from(spoken.wav_base64,'base64'):null;entry.tts={...spoken,wav_base64:undefined,path:undefined};if(bytes){const p=join(root,'app/.tmp',`voice-reply-${f.locale}-${report.date.replace(/\D/g,'')}.wav`);writeFileSync(p,bytes);entry.output={local_path:p,bytes:bytes.length,sha256:hash(bytes)};}}
  entry.pipeline_completed=r.code==='GENERATED'&&entry.tts?.ok===true;entry.conversation_quality='REQUIRES_NATIVE_SPEAKER_EVIDENCE';
  report.results.push(entry);save();
  if (!report.synthetic_followups_enabled) continue;
  const generatedInput=await post('/api/tts',{session_id:session,locale:f.locale,text:f.follow_up});
  if(generatedInput.wav_base64){const followAudio=toWav16kMono(Buffer.from(generatedInput.wav_base64,'base64'));if(!followAudio.ok)throw new Error(followAudio.code);const response=await post('/api/audio',{session_id:session,locale:f.locale,wav_base64:followAudio.buffer.toString('base64')});const e={case:'synthetic-spoken-follow-up',locale:f.locale,input_text:f.follow_up,scores:response.transcript?errorRate(f.follow_up,response.transcript):null,actual:summarize(response)};if(response.text){const spoken=await post('/api/tts',{session_id:session,locale:f.locale,text:response.text});e.tts={...spoken,wav_base64:undefined,path:undefined};}e.pipeline_completed=response.code==='GENERATED'&&e.tts?.ok===true;report.results.push(e);}else report.results.push({case:'follow-up-tts-failed',locale:f.locale,code:generatedInput.code});save();
 }
 // A call interrupts an actual in-flight model request, never releases a stale reply.
 const session=(await post('/api/session',{})).session_id;
 const pending=post('/api/text',{session_id:session,locale:'om',text:'Naannoo koo keessatti waa\u0027ee barnootaa maal gochuu danda\u0027a?'});
 await new Promise(r=>setTimeout(r,300));const started=Date.now();const incoming=await post('/api/call',{session_id:session,action:'incoming',kind:'normal'});const call_response_ms=Date.now()-started;const interrupted=await pending;
 report.results.push({case:'call-preempts-model',incoming_code:incoming.code,call_response_ms,interruption_settled_ms:Date.now()-started,reply:summarize(interrupted),pass:interrupted.code==='CALL_INTERRUPTED'});save();
 report.completed=true;
} catch(error){report.errors.push(String(error.stack??error));process.exitCode=1;} finally {child.kill();await new Promise(r=>child.once('exit',r));report.server_stderr=stderr.slice(-1000);save();console.log(JSON.stringify({out,results:report.results.length,errors:report.errors,gate:report.gate}));}
