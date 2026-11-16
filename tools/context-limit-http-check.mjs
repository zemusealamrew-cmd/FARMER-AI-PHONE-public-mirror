// Actual HTTP -> pinned worker -> context rejection -> MMS speech, no doubles.
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve('.'),out=resolve(process.argv[2]);
const hash=x=>createHash('sha256').update(x).digest('hex');
const state=join(root,'app/.tmp/context-limit-http');mkdirSync(state,{recursive:true});
const port=8983,base=`http://127.0.0.1:${port}`;
const report={date:new Date().toISOString(),scope:'actual oversized-text handling and research TTS; no physical mic/speaker or native listening acceptance',training_performed:false,hashes:Object.fromEntries(['app/server.mjs','app/src/offline_models.py','app/src/model_prompt.py','model_registry/offline-g1-profile.json'].map(p=>[p,hash(readFileSync(join(root,p)))])),network:JSON.parse(readFileSync(process.env.G1_NETNS_EVIDENCE)),errors:[]};
const child=spawn(process.execPath,['app/server.mjs'],{env:{...process.env,PORT:String(port),G1_OFFLINE_MODELS:'1',G1_NONCOMMERCIAL_RESEARCH:'1',EVIDENCE_PATH:join(state,'events.jsonl'),UPDATE_STATE_DIR:join(state,'updates')},stdio:['ignore','pipe','pipe']});
let stderr='';child.stdout.on('data',()=>{});child.stderr.on('data',b=>{stderr+=b;});
async function post(path,body){return await (await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(240000)})).json();}
try{
 let ready=false;for(let i=0;i<150;i++){try{ready=(await fetch(base+'/')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,200));}if(!ready)throw Error('SERVER_NOT_READY');
 const {session_id}=await post('/api/session',{});
 const started=performance.now();report.response=await post('/api/text',{session_id,locale:'am',text:'ሀ'.repeat(2000)});report.wall_ms=Math.round(performance.now()-started);
 if(report.response.code!=='MODEL_CONTEXT_TOO_LONG')throw Error('EXPECTED_CONTEXT_LIMIT_CODE');
 const speech=await post('/api/tts',{session_id,locale:'am',text:report.response.text});
 const bytes=speech.wav_base64?Buffer.from(speech.wav_base64,'base64'):null;
 report.speech={...speech,wav_base64:undefined,path:undefined};
 if(bytes){writeFileSync(join(state,'shorten-question-am.wav'),bytes);report.output={bytes:bytes.length,sha256:hash(bytes)};}
 if(!speech.ok||!bytes)throw Error('EXPECTED_ACTUAL_TTS');report.completed=true;
}catch(error){report.errors.push(String(error.stack??error));process.exitCode=1;}
finally{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));report.stderr_tail=stderr.slice(-1000);writeFileSync(out,JSON.stringify(report,null,2)+'\n');}
