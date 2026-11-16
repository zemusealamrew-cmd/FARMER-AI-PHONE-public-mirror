// Diagnostic fact presence and a blinded review pack; never a quality gate.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const report=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(!report.completed)throw Error('INFERENCE_COMPARISON_INCOMPLETE');
const rubric=JSON.parse(readFileSync('data/evaluation/g1-paired-model-rubric.json','utf8'));
const models=[...new Set(report.results.map(r=>r.label))];
const words=text=>String(text??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/);
const summary={scope:rubric.scope,semantic_quality_accepted:false,native_speaker_review_completed:false,models:models.map(label=>{
 const rows=report.results.filter(r=>r.label===label);
 return {label,cases:rows.length,completed_native_calls:rows.filter(r=>r.native.returncode===0).length,accepted_for_history:rows.filter(r=>r.accepted_for_history).length,
 facts:rubric.fact_probes.map(probe=>{const row=rows.find(r=>r.case===probe.case&&r.turn===probe.turn);return {case:probe.case,turn:probe.turn,mechanically_usable:row?.accepted_for_history??false,lexical_presence:Object.fromEntries(['name','quantity'].filter(k=>probe[k]).map(k=>[k,probe[k].some(word=>words(row?.native.text).includes(word.normalize('NFKC').toLowerCase()))]))};}),
 generation_wall_seconds:rows.map(r=>r.generation_wall_seconds),generation_cpu_seconds:rows.map(r=>r.generation_child_cpu_seconds),sampled_peak_rss_kib:rows.map(r=>r.sampled_child_peak_rss_kib)};
}),limits:[rubric.prohibited_inference,'Preparation downloads overlapped early baseline and late Afrique inference; timings are observed laptop measurements, not a controlled speed ranking.','128 output-token cap, two CPU threads, greedy seed 0 and 2048 context are equal across both models.','Small public development examples do not establish performance on unseen farmer speech.']};
writeFileSync(process.argv[3],JSON.stringify(summary,null,2)+'\n');
const review=report.results.map(row=>({review_id:createHash('sha256').update(row.label+'|'+row.case+'|'+row.turn).digest('hex').slice(0,12),case:row.case,turn:row.turn,locale:row.locale,conversation:row.actual_messages.filter(m=>m.role!=='system'),response:row.native.text,ratings:{meaning:null,context_recall:null,correction:null,fluency:null,safety:null},reviewer:null})).sort((a,b)=>a.review_id.localeCompare(b.review_id));
writeFileSync(process.argv[4],JSON.stringify({scope:'blinded output review pack; no ratings entered',rubric:rubric.required_human_review,items:review},null,2)+'\n');
console.log(JSON.stringify(summary.models.map(m=>({label:m.label,calls:m.completed_native_calls,mechanically_usable:m.accepted_for_history,facts:m.facts})),null,2));
