"""Before/after actual native context overflow, with unchanged pinned weights."""
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'app/src'))
from model_prompt import render_chat,bound_chat,native_token_count
profile=json.loads((root/'model_registry/offline-g1-profile.json').read_text())
native=profile['native_runtime'];binary=root/native['local_binary'];tokenizer=root/native['tokenizer_binary']
model=root/'app/models/Qwen3-4B-Q4_K_M.gguf'
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        while block:=f.read(8*1024*1024):h.update(block)
    return h.hexdigest()
entry=next(m for m in profile['models'] if m['id']=='unsloth/Qwen3-4B-GGUF')['files'][0]
assert sha(model)==entry['sha256']
assert sha(binary)==native['executable_sha256']
assert sha(tokenizer)==native['tokenizer_sha256']
out=Path(sys.argv[1]);cases=json.loads((root/'data/evaluation/g1-dialogue-development-cases.json').read_text())
report={'date':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'scope':'actual pinned tokenizer and native inference; synthetic long-history development regression, not language acceptance','model_sha256':entry['sha256'],'tokenizer_sha256':native['tokenizer_sha256'],'network':json.loads(Path(os.environ['G1_NETNS_EVIDENCE']).read_text()),'training_performed':False,'results':[]}
for case in [c for c in cases if c['id'].endswith('baseline')]:
    locale=case['id'].split('-')[0]
    filler=('ይህ ያለፈ የውይይት ርዕስ ነው። ' if locale=='am' else 'Kun mata duree marii darbee dha. ')*100
    messages=[case['messages'][0],*[{'role':'user','content':filler[:2000]} for _ in range(4)],*case['messages'][1:]]
    raw=render_chat(messages)
    started=time.monotonic()
    prompt,usage=bound_chat(messages,lambda p:native_token_count(tokenizer,model,p),96)
    assembly_seconds=round(time.monotonic()-started,3)
    for mode,text in [('before-unbounded',raw),('after-token-budget',prompt)]:
        started=time.monotonic();before=resource.getrusage(resource.RUSAGE_CHILDREN)
        cmd=[str(binary),'-m',str(model),'-p',text,'-n','96','-c','2048','-t','2','--no-conversation','--no-display-prompt','--no-warmup','--no-perf','--simple-io','--temp','0','--seed','0','--offline','--log-verbosity','0','--log-colors','off','--no-log-prefix','--no-log-timestamps']
        if mode.startswith('after'):cmd.append('--no-context-shift')
        try:
            run=subprocess.run(cmd,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=150)
            result={'returncode':run.returncode,'text':run.stdout.replace('[end of text]','').strip(),'stderr_tail':run.stderr[-600:]}
        except subprocess.TimeoutExpired:result={'code':'NATIVE_INFERENCE_TIMEOUT'}
        after=resource.getrusage(resource.RUSAGE_CHILDREN)
        report['results'].append({'locale':locale,'mode':mode,'input_messages':len(messages),'input_content_lengths':[len(m['content']) for m in messages],'context_usage':usage,'assembly_seconds':assembly_seconds,'current_question_intact':case['messages'][-1]['content'] in text,'recent_user_facts_intact':case['messages'][-2]['content'] in text,'system_intact':text.startswith(render_chat([messages[0]]).split('<|im_start|>assistant')[0]),'prompt_sha256':hashlib.sha256(text.encode()).hexdigest(),'prompt_tokens':native_token_count(tokenizer,model,text),'wall_seconds':round(time.monotonic()-started,3),'cpu_seconds':round(after.ru_utime+after.ru_stime-before.ru_utime-before.ru_stime,3),'child_peak_rss_kib_lifetime':after.ru_maxrss,'result':result})
        out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(locale,mode,flush=True)
report['completed']=True
out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
