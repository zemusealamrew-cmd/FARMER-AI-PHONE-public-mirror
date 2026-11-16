"""Real pinned CPU prompt diagnostic. Fixed development cases, not acceptance."""
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time
import argparse
from model_probe_support import render_messages,sampling_arguments

root = Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('cases');parser.add_argument('output')
parser.add_argument('--profile',default='model_registry/offline-g1-profile.json')
parser.add_argument('--max-tokens',type=int,default=96,choices=(96,128))
parser.add_argument('--sampling-profile',default='legacy-greedy',choices=('legacy-greedy','qwen35-instruct','gemma4-instruct'))
options=parser.parse_args()
profile = json.loads((root/options.profile).read_text())
spec = next((m for m in profile['models'] if m['id']=='unsloth/Qwen3-4B-GGUF'),profile['models'][0])
model = spec['files'][0]
weights = root/'app/models'/spec['local_directory']/model['path']
binary = root/profile['native_runtime']['local_binary']
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        while block:=stream.read(8*1024*1024): h.update(block)
    return h.hexdigest()
assert sha(weights)==model['sha256']
assert sha(binary)==profile['native_runtime']['executable_sha256']
cases=json.loads(Path(options.cases).read_text())
out=Path(options.output)
report={'date':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'scope':'fixed development prompts; actual inference; not native-speaker or held-out acceptance', 'network':json.loads(Path(os.environ['G1_NETNS_EVIDENCE']).read_text()),'model_id':spec['id'],'revision':spec['revision'],'max_output_tokens':options.max_tokens,'model_sha256':model['sha256'],'native_sha256':profile['native_runtime']['executable_sha256'],'training_performed':False,'results':[]}
sampling=sampling_arguments(options.sampling_profile)
report.update(sampling_profile=options.sampling_profile,sampling_parameters=sampling)
for case in cases:
    prompt=render_messages(profile,case['messages'])
    if case.get('reference_prompt_sha256') and hashlib.sha256(prompt.encode()).hexdigest()!=case['reference_prompt_sha256']:
        raise ValueError('COMPARISON_INPUT_CONTEXT_MISMATCH')
    before=resource.getrusage(resource.RUSAGE_CHILDREN); started=time.monotonic()
    command=[str(binary),'-m',str(weights),'-p',prompt,'-n',str(options.max_tokens),'-c','2048','-t','2','--no-conversation','--no-display-prompt','--no-warmup','--no-perf','--simple-io','--offline','--log-verbosity','0','--log-colors','off','--no-log-prefix','--no-log-timestamps',*sampling]
    try:
        run=subprocess.run(command,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=150)
        result={'returncode':run.returncode,'text':run.stdout.replace('[end of text]','').split('<|im_end|>')[0].split('<|im_start|>')[0].strip(),'raw_stdout':run.stdout,'stderr_tail':run.stderr[-400:]}
    except subprocess.TimeoutExpired as error:
        result={'code':'NATIVE_INFERENCE_TIMEOUT','text':None,'partial_stdout':(error.stdout or b'').decode('utf-8',errors='replace'),'partial_stderr':(error.stderr or b'').decode('utf-8',errors='replace')[-600:]}
    after=resource.getrusage(resource.RUSAGE_CHILDREN)
    report['results'].append({'id':case['id'],'messages':case['messages'],'prompt_sha256':hashlib.sha256(prompt.encode()).hexdigest(),'wall_seconds':round(time.monotonic()-started,3),'cpu_seconds':round(after.ru_utime+after.ru_stime-before.ru_utime-before.ru_stime,3),'child_peak_rss_kib_lifetime':after.ru_maxrss,'result':result})
    out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(case['id'],flush=True)
report['completed']=True
out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
