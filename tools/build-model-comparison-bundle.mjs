// Collect actual outputs and measurements; absent tests remain NOT_RUN.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const experiments=[
 ...['baseline','afrique','official','gemma'].map(m=>[m,`evidence/g1-continuation-${m}-2026-11-08.json`]),
 ['paired','evidence/g1-paired-model-comparison-2026-11-08.json'],
 ['afrique','evidence/g1-afrique-focused-inference-2026-11-08.json'],
 ['afrique','evidence/g1-afrique-compact-inference-2026-11-08.json'],
 ['baseline','evidence/g1-component-controls-qwen3-2026-11-08.json'],
 ['official','evidence/g1-official-qwen35-control-inference-2026-11-08.json'],
 ['official','evidence/g1-official-qwen35-sampling-inference-2026-11-08.json'],
 ['official','evidence/g1-official-qwen35-context-pack-inference-2026-11-08.json'],
 ['gemma','evidence/g1-gemma4-live-dialogue-2026-11-08.json'],
 ['gemma','evidence/g1-gemma4-comprehension-ablations-2026-11-08.json'],
 ['gemma','evidence/g1-gemma4-native-rephrasing-inference-2026-11-08.json'],
 ['gemma','evidence/g1-gemma4-in-context-demo-inference-2026-11-08.json'],
];
const profiles=['model_registry/offline-g1-profile.json','model_registry/g1-dialogue-candidate-afrique.json','model_registry/g1-dialogue-candidate-qwen35.json','model_registry/g1-dialogue-candidate-gemma4.json'];
const labels=['baseline','afrique','official','gemma'];
const models=profiles.map((p,i)=>{const x=read(p),m=i===0?x.models.find(m=>m.id==='unsloth/Qwen3-4B-GGUF'):x.models[0];return {label:labels[i],profile:p,id:m.id,revision:m.revision,license:m.license,files:m.files,production_selected:false,rights_evidence:i===0?'evidence/g1-model-license-findings-2026-11-07.json':`evidence/g1-${['','afrique','official-qwen35','gemma4'][i]}-research-rights-2026-11-08.json`};});
const bundle={date:new Date().toISOString(),scope:'Builder-run development comparison; not independent/native-speaker acceptance',models,training_performed:false,better_bilingual_model_established:false,production_model_selected:false,gates:'G1 HOLD; G2/G3 NOT AUTHORIZED; G4 NO-GO',rights_evidence:models.map(m=>({model:m.label,path:m.rights_evidence,record:read(m.rights_evidence)})),experiments:[],outputs:[],assessment:read('evidence/g1-model-common-assessment-2026-11-08.json')};
const aliases={'baseline-qwen3':'baseline','candidate-afrique-qwen35':'afrique','candidate-official-qwen35':'official','candidate-gemma4-e2b':'gemma'};
for(const [model,p] of experiments){const r=read(p);bundle.experiments.push({model,path:p,sha256:createHash('sha256').update(readFileSync(p)).digest('hex'),status:r.completed?'COMPLETED':r.interruption?'INCOMPLETE_STOPPED':'INCOMPLETE',completed_trials:r.results.length,interruption:r.interruption??null});for(const x of r.results){const n=x.native??x.result;bundle.outputs.push({model:aliases[x.label]??model,experiment:p,input_messages:x.actual_messages??x.messages??null,user:x.user??null,history_source:x.history_source??null,sampling_profile:r.sampling_profile??null,sampling_parameters:r.sampling_parameters??null,case:x.case??x.id,turn:x.turn??null,locale:x.locale??(x.id?.slice(0,2)),native:n,wall_seconds:x.generation_wall_seconds??x.wall_seconds,cpu_seconds:x.generation_child_cpu_seconds??x.cpu_seconds,rss_kib:x.sampled_child_peak_rss_kib??x.child_peak_rss_kib_lifetime,rss_measurement:x.sampled_child_peak_rss_kib!==undefined?'sampled native child, 50 ms':'native children process-lifetime high-water',cpu_percent_of_one_core:100*(x.generation_child_cpu_seconds??x.cpu_seconds)/(x.generation_wall_seconds??x.wall_seconds),cpu_measurement:"native child user+system core-seconds divided by wall time; 100% = one busy core",checks:x.checks??null});}}
writeFileSync(process.argv[2]??'evidence/g1-four-model-comparison-bundle-2026-11-08.json',JSON.stringify(bundle,null,2)+'\n');
console.log(JSON.stringify({models:models.length,experiments:bundle.experiments.length,trials:bundle.outputs.length,incomplete:bundle.experiments.filter(x=>x.status!=='COMPLETED').map(x=>x.path),better_bilingual_model_established:false}));
