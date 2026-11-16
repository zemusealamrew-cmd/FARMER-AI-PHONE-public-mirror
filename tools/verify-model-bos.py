"""Check native BOS insertion against the publisher's canonical prompt tokens."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from model_probe_support import render_messages
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('profile');parser.add_argument('cases');parser.add_argument('output');options=parser.parse_args()
profile=json.loads((root/options.profile).read_text());spec=profile['models'][0]
weights=root/'app/models'/spec['local_directory']/spec['files'][0]['path']
tokenizer=root/profile['native_runtime']['tokenizer_binary']
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        while block:=f.read(8*1024*1024):h.update(block)
    return h.hexdigest()
assert sha(weights)==spec['files'][0]['sha256'];assert sha(tokenizer)==profile['native_runtime']['tokenizer_sha256']
def tokens(prompt,no_bos=False):
    command=[str(tokenizer),'-m',str(weights),'--stdin','--ids','--offline','--log-verbosity','0']
    if no_bos:command.append('--no-bos')
    return json.loads(subprocess.check_output(command,input=prompt.encode()))
rows=[]
for case in json.loads((root/options.cases).read_text()):
    messages=case['messages'] if 'messages' in case else [{'role':'system','content':case['system']},*({'role':'user','content':t} for t in case['turns'])]
    official=render_messages(profile,messages,bos_override='<bos>')
    adapted=render_messages(profile,messages)
    expected=tokens(official,True);actual=tokens(adapted)
    rows.append({'case':case['id'],'exact_token_sequence_match':expected==actual,'tokens':len(actual),'first_token_ids':actual[:12],'official_token_sequence_sha256':hashlib.sha256(json.dumps(expected).encode()).hexdigest(),'native_token_sequence_sha256':hashlib.sha256(json.dumps(actual).encode()).hexdigest()})
report={'scope':'publisher template plus native BOS equivalence; not language quality acceptance','model_sha256':spec['files'][0]['sha256'],'template_sha256':profile['chat_template']['sha256'],'results':rows}
(root/options.output).write_text(json.dumps(report,indent=2)+'\n')
if not rows or not all(r['exact_token_sequence_match'] for r in rows):raise SystemExit('BOS_OR_TEMPLATE_MISMATCH')
print(json.dumps({'cases':len(rows),'all_match':True}))
