"""OFFLINE research corpus partitioning; never trains or changes the product.

Publish hashes/IDs only. Keep licensed text and reviewer queues in ignored storage.
"""
import collections,hashlib,json,re,sys,unicodedata
from pathlib import Path
root=Path(__file__).resolve().parents[1]
folder=root/'app/.tmp/g1-licensed-data'
raw=(folder/'source-records.jsonl').read_bytes()
receipt=json.loads((root/'evidence/g1-licensed-data-acquisition-2026-11-08.json').read_text())
def sha(b):return hashlib.sha256(b).hexdigest()
if sha(raw)!=receipt['source_records_sha256']:raise ValueError('SOURCE_HASH_MISMATCH')
def norm(s):return ' '.join(re.findall(r'\w+',unicodedata.normalize('NFKC',s).casefold()))
rows=[json.loads(s) for s in raw.decode().splitlines()]
seen={};kept=[];quarantine=[]
for row in rows:
    # No NC/ND/unknown license is silently promoted into this candidate corpus.
    if row['license'] not in ('Apache-2.0','CC-BY-SA-4.0'):raise ValueError('LICENSE_NOT_ALLOWED')
    text=row['input']+'\n'+row['target']
    reason=None
    if row.get('quarantine'):reason='SOURCE_RIGHTS_NOTICE_REQUIRES_REVIEW'
    elif not row['target'].strip() or len(text)>20000:reason='EMPTY_OR_OVERSIZED'
    key=sha(norm(row['input'] or row['target']).encode())
    if key in seen:reason='DUPLICATE_NORMALIZED_INPUT_OR_DOCUMENT'
    if reason:quarantine.append({'source_id':row['source_id'],'reason':reason});continue
    seen[key]=row;row['content_sha256']=sha(text.encode());kept.append(row)
split={};group_counts={}
for locale in ('am','om'):
    groups=sorted({r['group'] for r in kept if r['locale']==locale},key=lambda s:sha(('g1-data-v1:'+s).encode()))
    group_counts[locale]=len(groups)
    # Group by annotator/page, not arbitrary individual sentences. Insufficient
    # independent groups remain explicit rather than fabricating a holdout.
    for i,g in enumerate(groups):split[g]=('evaluation_candidate' if i==0 else 'development' if i==1 else 'train_candidate') if len(groups)>=3 else 'train_candidate'
outputs={name:[] for name in ('train_candidate','development','evaluation_candidate')}
index=[]
for row in kept:
    name=split[row['group']];outputs[name].append(row)
    index.append({k:row[k] for k in ('source','source_id','locale','group','license','source_url','content_sha256') }|{'split':name})
hashes={}
for name,items in outputs.items():
    text=''.join(json.dumps(r,ensure_ascii=False,sort_keys=True)+'\n' for r in items)
    (folder/(name+'.jsonl')).write_bytes(text.encode());hashes[name]=sha(text.encode())
assert not ({r['group'] for r in outputs['train_candidate']} & {r['group'] for r in outputs['evaluation_candidate']})
assert not ({r['content_sha256'] for r in outputs['train_candidate']} & {r['content_sha256'] for r in outputs['evaluation_candidate']})
# Detect near-identical cross-split documents with >=85% 5-word-shingle Jaccard.
def shingles(row):
    words=norm(row['input']+' '+row['target']).split()
    return {tuple(words[i:i+5]) for i in range(max(0,len(words)-4))}
near=[];prepared=[(r,shingles(r)) for r in kept]
for i,(a,x) in enumerate(prepared):
    if not x:continue
    for b,y in prepared[i+1:]:
        if split[a['group']]==split[b['group']] or a['locale']!=b['locale'] or not y:continue
        if min(len(x),len(y))/max(len(x),len(y))<.85:continue
        overlap=len(x&y)/len(x|y)
        if overlap>=.85:near.append({'a':a['source_id'],'b':b['source_id'],'jaccard':overlap})
review=[{'source_id':r['source_id'],'locale':r['locale'],'split':split[r['group']],
    'text':r['input']+'\n'+r['target'],'reviewer':None,'native_language':None,
    'rights_notices_checked':None,'language_fluency':None,'factual_safety':None,
    'instruction_suitability':None,'multi_turn_suitability':None,'approved_for_training':None} for r in kept]
(folder/'human-review.json').write_text(json.dumps(review,ensure_ascii=False,indent=2)+'\n')
report={'source_sha256':sha(raw),'source_rows':len(rows),'kept':len(kept),'quarantined':quarantine,
    'groups_per_locale':group_counts,'split_hashes':hashes,
    'counts':{name:dict(collections.Counter(r['locale'] for r in items)) for name,items in outputs.items()},
    'index':index,'cross_split_near_duplicates':near,'exact_content_and_group_overlap':0,
    'evaluation_role':'Reserved candidate holdout; not independent validated acceptance data; do not train on it.',
    'training_ready':False,'training_performed':False,'human_review_completed':False,
    'limitations':['Exact and 5-word-shingle checks cannot exclude semantic paraphrase or upstream model pretraining contamination.',
        'Aya original instructions and Oromo encyclopedia prose are different tasks, not paired dialogue supervision.',
        'Human review, conversation-specific data and a validated trainable model/tooling configuration remain required.'],
    'gates':'G1 HOLD; G2/G3 NOT AUTHORIZED; G4 NO-GO'}
(root/'evidence/g1-licensed-corpus-splits-2026-11-08.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k not in ('index','quarantined')},ensure_ascii=False))
if near:raise SystemExit('CROSS_SPLIT_NEAR_DUPLICATES_REQUIRE_REVIEW')
