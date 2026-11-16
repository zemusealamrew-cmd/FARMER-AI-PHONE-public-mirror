"""Opt-in research prompt hashes around an unmodified, actual inference worker.

No generated result is replaced. Raw text/audio is never written to this trace.
Set G1_PROMPT_TRACE_PATH only for consented diagnostic inputs.
"""
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
import time

original = sys.stdin
trace_path = os.environ.get('G1_PROMPT_TRACE_PATH')


class TraceInput:
    def __iter__(self):
        return self

    def __next__(self):
        line = next(original)
        if trace_path:
            try:
                job = json.loads(line)
            except json.JSONDecodeError:
                return line
            if job.get('kind') == 'dialogue':
                record = {'at_ns': time.monotonic_ns(), 'kind': 'dialogue',
                          'locale': job.get('locale'),
                          'messages': [{'role': m['role'], 'content_sha256': hashlib.sha256(m['content'].encode()).hexdigest()}
                                       for m in job['messages']]}
                destination = Path(trace_path)
                destination.parent.mkdir(parents=True, exist_ok=True)
                with destination.open('a') as output:
                    output.write(json.dumps(record) + '\n')
        return line

    def __getattr__(self, name):
        return getattr(original, name)


sys.stdin = TraceInput()
worker = sys.argv[1]
sys.argv = sys.argv[1:]
sys.path.insert(0, str(Path(worker).resolve().parent))
runpy.run_path(worker, run_name='__main__')
