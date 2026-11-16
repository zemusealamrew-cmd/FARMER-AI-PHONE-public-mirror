"""Paired real CPU conversations. Preparation is separate; inference stays offline."""
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import threading
import time
import argparse
from model_probe_support import render_messages,sampling_arguments
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'app/src'))
from model_prompt import bound_chat,native_token_count

def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        while block:=stream.read(8*1024*1024):h.update(block)
    return h.hexdigest()

parser=argparse.ArgumentParser();parser.add_argument('output');parser.add_argument('--profile');parser.add_argument('--label',default='research-candidate');parser.add_argument('--cases',default='data/evaluation/g1-paired-model-conversations.json');parser.add_argument('--sampling-profile',default='legacy-greedy',choices=('legacy-greedy','qwen35-instruct','gemma4-instruct'));options=parser.parse_args()
out=Path(options.output);case_path=root/options.cases
cases=json.loads(case_path.read_text())
profile_paths=[options.profile] if options.profile else ['model_registry/offline-g1-profile.json','model_registry/g1-dialogue-candidate-afrique.json']
profiles=[json.loads((root/p).read_text()) for p in profile_paths]
labels=[options.label] if options.profile else ['baseline-qwen3','candidate-afrique-qwen35']
sampling=sampling_arguments(options.sampling_profile)
report=json.loads(out.read_text()) if out.exists() else {'date':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'scope':'paired synthetic development conversations, not held-out or native-speaker acceptance','network':json.loads(Path(os.environ['G1_NETNS_EVIDENCE']).read_text()),'training_performed':False,'production_model_selected':False,'fixture_sha256':sha(case_path),'sampling_profile':options.sampling_profile,'sampling_parameters':sampling,'results':[],'artifacts':[]}
if report['fixture_sha256']!=sha(case_path):raise SystemExit('FIXTURE_CHANGED')
def save():out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
guard_script="import {readFileSync} from 'node:fs';import {inspectGeneratedReply} from './app/src/generation-guard.mjs';import {classifyRisk} from './app/src/safety.mjs';const x=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({quality:inspectGeneratedReply(x.text,x.locale,x.user),risk:classifyRisk(x.text,x.locale)}));"
for profile,label in zip(profiles,labels):
    spec=next(m for m in profile['models'] if m['id']=='unsloth/Qwen3-4B-GGUF') if label.startswith('baseline') else profile['models'][0]
    item=spec['files'][0];weights=root/'app/models'/spec['local_directory']/item['path']
    if not weights.is_file():
        report['awaiting_artifact']=str(weights);save();raise SystemExit(2)
    assert sha(weights)==item['sha256']
    native=profile['native_runtime'];binary=root/native['local_binary'];tokenizer=root/native['tokenizer_binary']
    assert sha(binary)==native['executable_sha256'];assert sha(tokenizer)==native['tokenizer_sha256']
    if not any(a['label']==label for a in report['artifacts']):report['artifacts'].append({'label':label,'id':spec['id'],'revision':spec['revision'],'bytes':weights.stat().st_size,'sha256':item['sha256'],'runtime_sha256':native['executable_sha256']})
    for case in cases:
        history=list(case.get('initial_history',[]))[-6:]
        for index,user in enumerate(case['turns']):
            turn_number=index+1+case.get('turn_offset',0)
            prior=next((r for r in report['results'] if r['label']==label and r['case']==case['id'] and r['turn']==turn_number),None)
            if prior:
                history.append({'role':'user','content':user})
                if prior['accepted_for_history']:history.append({'role':'assistant','content':prior['native']['text']})
                history=history[-6:];continue
            messages=[{'role':'system','content':case['system']},*history,{'role':'user','content':user}]
            started=time.monotonic()
            if profile.get('chat_template'):
                prompt=render_messages(profile,messages);count=native_token_count(tokenizer,weights,prompt)
                if count>1916:raise ValueError('RESEARCH_FIXTURE_EXCEEDS_CONTEXT_BUDGET')
                usage={'prompt_tokens':count,'prompt_token_budget':1916,'context_messages_dropped':0}
            else:prompt,usage=bound_chat(messages,lambda s:native_token_count(tokenizer,weights,s),128)
            preparation_seconds=round(time.monotonic()-started,3)
            cmd=[str(binary),'-m',str(weights),'-p',prompt,'-n','128','-c','2048','-t','2','--no-context-shift','--no-conversation','--no-display-prompt','--no-warmup','--no-perf','--simple-io','--offline','--log-verbosity','0','--log-colors','off','--no-log-prefix','--no-log-timestamps',*sampling]
            before=resource.getrusage(resource.RUSAGE_CHILDREN);started=time.monotonic()
            process=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            stop=threading.Event();samples=[]
            def sample():
                while not stop.is_set():
                    try:
                        status=Path(f'/proc/{process.pid}/status').read_text()
                        samples.append(int(next(s.split()[1] for s in status.splitlines() if s.startswith('VmRSS:'))))
                    except (OSError,StopIteration):pass
                    stop.wait(.05)
            sampler=threading.Thread(target=sample);sampler.start()
            try:
                stdout,stderr=process.communicate(timeout=150)
                text=stdout.decode('utf-8',errors='replace').replace('[end of text]','').split('<|im_end|>')[0].split('<|im_start|>')[0].strip()
                result={'returncode':process.returncode,'text':text,'raw_stdout':stdout.decode('utf-8',errors='replace'),'stderr_tail':stderr.decode('utf-8',errors='replace')[-600:]}
            except subprocess.TimeoutExpired:
                process.kill();process.communicate();result={'code':'NATIVE_INFERENCE_TIMEOUT','text':None}
            finally:stop.set();sampler.join()
            elapsed=round(time.monotonic()-started,3);after=resource.getrusage(resource.RUSAGE_CHILDREN)
            checked=json.loads(subprocess.check_output([os.environ['G1_NODE'],'--input-type=module','-e',guard_script],input=json.dumps({'text':result.get('text') or '', 'locale':case['locale'],'user':user}).encode(),cwd=root))
            accepted=result.get('returncode')==0 and '\ufffd' not in (result.get('text') or '') and checked['quality']['ok'] and checked['risk']['level']=='low'
            report['results'].append({'label':label,'case':case['id'],'turn':turn_number,'locale':case['locale'],'user':user,'actual_messages':messages,'history_source':case.get('history_source'),'context_usage':usage,'prompt_sha256':hashlib.sha256(prompt.encode()).hexdigest(),'preparation_seconds':preparation_seconds,'generation_wall_seconds':elapsed,'generation_child_cpu_seconds':round(after.ru_utime+after.ru_stime-before.ru_utime-before.ru_stime,3),'sampled_child_peak_rss_kib':max(samples) if samples else None,'rss_samples':len(samples),'native':result,'checks':checked,'accepted_for_history':accepted,'semantic_acceptance':False})
            history.append({'role':'user','content':user})
            if accepted:history.append({'role':'assistant','content':result['text']})
            history=history[-6:];report.pop('awaiting_artifact',None);save();print(label,case['id'],turn_number,result.get('returncode',result.get('code')),flush=True)
report['completed']=True;save()
