"""Optional formant TTS; no neural weights or noncommercial MMS dependency."""
import hashlib,json,os,subprocess,sys,wave
from pathlib import Path

def synthesize(root,job):
    locale=job.get('locale','am')
    if locale not in ('am','om'):return {'ok':False,'code':'TTS_LOCALE_UNSUPPORTED'}
    text=str(job.get('text','')).strip()
    if not text:return {'ok':False,'code':'EMPTY_TEXT'}
    runtime=root/'app/bin/espeak-ng'
    profile=json.loads((root/'model_registry/espeak-ng-profile.json').read_text())
    # Verify executable, shared libraries and language data before execution.
    for item in profile['files']:
        path=runtime/item['path']
        if not path.is_file():return {'ok':False,'code':'ESPEAK_RUNTIME_MISSING'}
        if path.stat().st_size!=item['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:
            return {'ok':False,'code':'ESPEAK_RUNTIME_HASH_MISMATCH'}
    # The pinned executable is Linux x86_64. Validate inputs and artifacts on
    # every host, then report unsupported execution rather than failing import.
    if not sys.platform.startswith('linux'):return {'ok':False,'code':'TTS_RUNTIME_PLATFORM_UNSUPPORTED'}
    import resource
    output=Path(job['path']);output.parent.mkdir(parents=True,exist_ok=True)
    lib=runtime/'usr/lib/x86_64-linux-gnu'
    before=resource.getrusage(resource.RUSAGE_CHILDREN)
    run=subprocess.run([str(runtime/'usr/bin/espeak-ng'),'--path='+str(lib),'-v',locale,'-s','145','-w',str(output),'--stdin'],input=text[:1200],text=True,capture_output=True,timeout=30,env={**os.environ,'LD_LIBRARY_PATH':str(lib)})
    after=resource.getrusage(resource.RUSAGE_CHILDREN)
    if run.returncode or not output.is_file():return {'ok':False,'code':'TTS_RENDER_FAILED'}
    with wave.open(str(output),'rb') as audio:
        rate=audio.getframerate();seconds=audio.getnframes()/rate
    return {'ok':True,'code':'SYNTHESIZED','path':str(output),'bytes':output.stat().st_size,'sample_rate':rate,'seconds':seconds,'engine':profile['engine'],'license':profile['license'],'scope':'FORMANT_TTS_EXPERIMENTAL_NOT_ACCEPTED','child_peak_rss_kib_process_lifetime':after.ru_maxrss,'child_cpu_seconds':round(after.ru_utime+after.ru_stime-before.ru_utime-before.ru_stime,4)}
