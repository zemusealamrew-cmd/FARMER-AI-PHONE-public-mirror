"""Explicit online preparation with bounded parallel HTTP ranges and final hashes.

Uses the existing pinned profile, never a latest revision or remote Python code.
Native runtime and author-demo speech fixtures remain explicit preparation options.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHUNK = 4 * 1024 * 1024


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        while block := source.read(8 * 1024 * 1024):
            result.update(block)
    return result.hexdigest()


def download(model, item, workers):
    path = ROOT / 'app/models' / model['local_directory'] / item['path']
    path.parent.mkdir(parents=True, exist_ok=True)
    expected = item['bytes']
    if path.is_file():
        actual = digest(path)
        if path.stat().st_size == expected and (not item['sha256'] or actual == item['sha256']):
            return {'model': model['id'], 'file': item['path'], 'bytes': expected, 'sha256': actual, 'cached': True}
        raise ValueError('EXISTING_MODEL_MISMATCH: ' + str(path))
    url = f"https://huggingface.co/{model['id']}/resolve/{model['revision']}/{item['path']}"
    partial = Path(str(path) + '.partial')
    state = Path(str(path) + '.ranges.json')
    if state.exists():
        progress = json.loads(state.read_text())
        if progress['url'] != url or progress['bytes'] != expected or not partial.exists():
            raise ValueError('RANGE_STATE_MISMATCH')
    else:
        # A previous sequential preparer leaves a contiguous prefix. The final
        # whole-file hash still verifies it; unverified bytes are never promoted.
        prefix = partial.stat().st_size if partial.exists() else 0
        if prefix > expected:
            raise ValueError('PARTIAL_FILE_TOO_LARGE')
        progress = {'url': url, 'bytes': expected, 'prefix': prefix, 'completed': []}
        state.write_text(json.dumps(progress))
    if not partial.exists():
        partial.touch()
    with partial.open('r+b') as target:
        target.truncate(expected)
    # Older preparation runs used 32-MiB ranges. Expand only fully completed
    # ranges into the new grid; interrupted ranges are downloaded again.
    prior_chunk = progress.get('chunk_bytes', 32 * 1024 * 1024)
    if prior_chunk != CHUNK:
        progress['completed'] = [piece for start in progress['completed']
                                 for piece in range(start, min(start + prior_chunk, expected), CHUNK)]
    progress['chunk_bytes'] = CHUNK
    state.write_text(json.dumps(progress))
    lock = threading.Lock()
    ranges = [(start, min(start + CHUNK, expected) - 1)
              for start in range(progress['prefix'], expected, CHUNK)
              if start not in progress['completed']]

    def part(bounds):
        start, end = bounds
        for attempt in range(3):
            try:
                request_started = time.monotonic()
                request = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end}'})
                with urllib.request.urlopen(request, timeout=120) as source, partial.open('r+b') as target:
                    wanted = f'bytes {start}-{end}/{expected}'
                    if source.status != 206 or source.headers.get('Content-Range') != wanted:
                        raise ValueError('HTTP_RANGE_NOT_HONORED')
                    target.seek(start)
                    remaining = end - start + 1
                    while remaining:
                        if time.monotonic() - request_started > 300:
                            raise TimeoutError('HTTP_RANGE_DEADLINE_EXCEEDED')
                        # read1 avoids waiting for a whole MiB before checking
                        # the total request deadline on a stalled connection.
                        data = source.read1(min(64 * 1024, remaining))
                        if not data:
                            raise ValueError('HTTP_RANGE_TRUNCATED')
                        target.write(data)
                        remaining -= len(data)
                    if source.read(1):
                        raise ValueError('HTTP_RANGE_OVERSIZED')
                    target.flush()
                with lock:
                    progress['completed'].append(start)
                    temporary = Path(str(state) + '.tmp')
                    temporary.write_text(json.dumps(progress))
                    os.replace(temporary, state)
                return
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)

    # Small files need not support ranges; use one ordinary bounded download.
    if expected < CHUNK and progress['prefix'] == 0 and not progress['completed']:
        with urllib.request.urlopen(url, timeout=120) as source, partial.open('wb') as target:
            while block := source.read(1024 * 1024):
                target.write(block)
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(part, ranges))
    actual = digest(partial)
    if partial.stat().st_size != expected or (item['sha256'] and actual != item['sha256']):
        raise ValueError('MODEL_HASH_OR_SIZE_MISMATCH: ' + str(path))
    os.replace(partial, path)
    state.unlink(missing_ok=True)
    return {'model': model['id'], 'revision': model['revision'], 'file': item['path'],
            'bytes': expected, 'sha256': actual, 'pinned_hash_verified': bool(item['sha256']), 'cached': False}



import tarfile
args=argparse.ArgumentParser();args.add_argument('--profile',default='model_registry/offline-g1-profile.json');args.add_argument('--noncommercial-research',action='store_true');args.add_argument('--install-native-runtime',action='store_true');args.add_argument('--speech-examples',action='store_true');args.add_argument('--workers',type=int,default=1,choices=range(1,33));args.add_argument('--parallel-models',type=int,default=1,choices=(1,2,3));options=args.parse_args()

profile=json.loads((ROOT/options.profile).read_text())
if any(m['license']=='cc-by-nc-4.0' for m in profile['models']) and not options.noncommercial_research:raise SystemExit('MMS requires --noncommercial-research; no release approval.')
report=[]
def prepare_model(model):
    for item in model['files']:
        result=download(model,item,options.workers)
        report.append(result)
with concurrent.futures.ThreadPoolExecutor(max_workers=options.parallel_models) as pool:
    list(pool.map(prepare_model,profile['models']))
if options.install_native_runtime:
    runtime=profile['native_runtime'];archive=ROOT/'app/.tmp/llama-cpu.tar.gz';archive.parent.mkdir(parents=True,exist_ok=True)
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest()!=runtime['sha256']:
        urllib.request.urlretrieve(runtime['url'],archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=runtime['sha256']:raise SystemExit('RUNTIME ARCHIVE HASH MISMATCH')
    destination=ROOT/'app/bin/llama-cpp';destination.mkdir(parents=True,exist_ok=True)
    with tarfile.open(archive) as source:source.extractall(destination,filter='data')
    if hashlib.sha256((ROOT/runtime['local_binary']).read_bytes()).hexdigest()!=runtime['executable_sha256']:raise SystemExit('RUNTIME EXECUTABLE HASH MISMATCH')
    if hashlib.sha256((ROOT/runtime['tokenizer_binary']).read_bytes()).hexdigest()!=runtime['tokenizer_sha256']:raise SystemExit('TOKENIZER EXECUTABLE HASH MISMATCH')
if options.speech_examples:
    fixtures=json.loads((ROOT/'model_registry/g1-speech-fixtures.json').read_text())
    for fixture in fixtures['fixtures']:
        destination=ROOT/fixture['local_path'];destination.parent.mkdir(parents=True,exist_ok=True)
        urllib.request.urlretrieve(fixture['url'],destination)
print(json.dumps({'scope':profile['scope'],'files':report},indent=2))
