"""Fresh-worker CPU/wall and sampled Linux process-tree RSS/PSS measurement.
Input is a local JSON job; never downloads or retains audio content in evidence.
Usage: model-venv/bin/python tools/measure-offline-job.py job.json evidence.json
"""
import hashlib,json,os,platform,resource,signal,subprocess,sys,time
from pathlib import Path
root=Path(__file__).resolve().parents[1]
job=json.loads(Path(sys.argv[1]).read_text())
before=resource.getrusage(resource.RUSAGE_CHILDREN);start=time.monotonic()
process=subprocess.Popen([sys.executable,str(root/'app/src/offline_models.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,start_new_session=True)
process.stdin.write(json.dumps(job)+'\n');process.stdin.close()
peak_rss=peak_pss=peak_count=samples=0
def tree(pid):
    # Some managed kernels omit /proc/PID/task/PID/children. Enumerate PPid
    # instead; silently returning only the worker would undercount native LLMs.
    parents={}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():continue
        try:
            parent=next(line.split()[1] for line in (entry/'status').read_text().splitlines() if line.startswith('PPid:'))
            parents.setdefault(int(parent),[]).append(int(entry.name))
        except (OSError,ValueError,StopIteration):pass
    result=[pid];pending=[pid]
    while pending:
        children=parents.get(pending.pop(),[]);result+=children;pending+=children
    return result
try:
    while process.poll() is None:
        if time.monotonic()-start>240:raise TimeoutError('MEASUREMENT_TIMEOUT')
        rss=pss=0;pids=tree(process.pid)
        for pid in pids:
            try:
                fields={line.split(':',1)[0]:line.split(':',1)[1].strip().split()[0] for line in Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines() if ':' in line}
                rss+=int(fields.get('Rss',0));pss+=int(fields.get('Pss',0))
            except (OSError,ValueError):pass
        peak_rss=max(peak_rss,rss);peak_pss=max(peak_pss,pss);peak_count=max(peak_count,len(pids));samples+=1
        time.sleep(.02)
    output=process.stdout.read()
finally:
    if process.poll() is None:os.killpg(process.pid,signal.SIGKILL);process.wait()
after=resource.getrusage(resource.RUSAGE_CHILDREN)
report={'date':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'host':platform.platform(),'scope':'fresh managed Linux CPU worker; not owner laptop or phone acceptance','job_kind':job['kind'],'locale':job.get('locale'),'returncode':process.returncode,'wall_seconds':round(time.monotonic()-start,3),'tree_cpu_seconds':round(after.ru_utime+after.ru_stime-before.ru_utime-before.ru_stime,3),'sampled_tree_peak_rss_kib':peak_rss,'sampled_tree_peak_pss_kib':peak_pss,'peak_process_count':peak_count,'samples':samples,'sampling_interval_ms':20,'limitations':['Sampling may miss transient peaks','RSS sums double-count shared pages; PSS apportions them','Other host activity can affect wall time'],'result':json.loads(output)}
report['worker_sha256']=hashlib.sha256((root/'app/src/offline_models.py').read_bytes()).hexdigest()
report['job_sha256']=hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest()
report['cpu_quota']=Path('/sys/fs/cgroup/cpu.max').read_text().strip()
memory_limit=Path('/sys/fs/cgroup/memory.max').read_text().strip()
report['memory_limit_bytes']=None if memory_limit=='max' else int(memory_limit)
report['memory_limit_kind']='UNBOUNDED_CGROUP' if memory_limit=='max' else 'CGROUP_BYTE_LIMIT'
report['host_memory_total_bytes']=int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemTotal:')))*1024
Path(sys.argv[2]).write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
print(json.dumps({key:value for key,value in report.items() if key!='result'}))
