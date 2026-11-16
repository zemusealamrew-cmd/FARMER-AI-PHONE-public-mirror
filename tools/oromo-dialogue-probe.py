"""Evaluate the already pinned optional Oromo research model with actual weights."""
import io
import json
import os
from pathlib import Path
import resource
import runpy
import sys
import time
import hashlib

root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'app/src'))
sys.stdin=io.StringIO('')
worker=runpy.run_path(str(root/'app/src/offline_models.py'))
os.environ['G1_OM_DIALOGUE_MODEL']='kkenna'
tokenizer,model=worker['load']('dialogue','om')
cases=json.loads(Path(sys.argv[1]).read_text())
out=Path(sys.argv[2])
report={'date':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'scope':'actual pinned external Oromo research model; development probes, not acceptance','training_performed':False,'native_speaker_signoff':False,'network_isolation':worker['ISOLATION'],'results':[]}
for case in cases:
    for label in ['pinned-kkenna-existing-loader']:
        rendered=tokenizer.apply_chat_template(case['messages'],tokenize=False,add_generation_prompt=True,enable_thinking=False)
        started=time.monotonic();before=resource.getrusage(resource.RUSAGE_SELF)
        result=worker['handle']({'kind':'dialogue','locale':'om','messages':case['messages'],'max_tokens':96})
        after=resource.getrusage(resource.RUSAGE_SELF)
        report['results'].append({'id':case['id'],'template':label,'messages':case['messages'],'rendered_prompt':rendered,'prompt_sha256':hashlib.sha256(rendered.encode()).hexdigest(),'wall_seconds':round(time.monotonic()-started,3),'cpu_seconds':round(after.ru_utime+after.ru_stime-before.ru_utime-before.ru_stime,3),'peak_rss_kib_lifetime':after.ru_maxrss,'result':result})
        out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print(case['id'],label,flush=True)
report['completed']=True
out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
