"""Compare actual conversation prompts with the publisher's local Jinja template."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
from jinja2 import Environment
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'app/src'))
from model_prompt import render_chat
parser=argparse.ArgumentParser();parser.add_argument('template');parser.add_argument('comparison');parser.add_argument('output');parser.add_argument('--label',required=True)
options=parser.parse_args()
template=Path(options.template).read_text()
comparison=json.loads(Path(options.comparison).read_text())
results=[]
for row in comparison['results']:
    if row['label']!=options.label:continue
    if row['context_usage']['context_messages_dropped']:raise ValueError('PRUNED_CONTEXT_NEEDS_SEPARATE_VERIFICATION')
    actual=row['actual_messages']
    official=Environment().from_string(template).render(messages=actual,enable_thinking=False,add_generation_prompt=True)
    digest=hashlib.sha256(official.encode()).hexdigest()
    results.append({'case':row['case'],'turn':row['turn'],'matches_builder':official==render_chat(actual),'matches_recorded_native_prompt':digest==row['prompt_sha256']})
report={'scope':'prompt-format verification, not semantic quality acceptance','template_sha256':hashlib.sha256(template.encode()).hexdigest(),'results':results}
Path(options.output).write_text(json.dumps(report,indent=2)+'\n')
if not results or not all(r['matches_builder'] and r['matches_recorded_native_prompt'] for r in results):raise SystemExit(1)
print(json.dumps({'checked':len(results),'all_match':True}))
