"""G1-only offline inference worker. JSON lines; no network or remote Python code.
MMS TTS requires explicit non-commercial research opt-in. Not a release approval.
"""
import os
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', TOKENIZERS_PARALLELISM='false')
import sys,json,time,re,wave,gc
# Windows pipe stdio follows the ANSI code page (cp1252 here) when the Node
# parent spawns this worker: Amharic/Oromo job data then arrives mojibaked and
# non-ANSI results raise UnicodeEncodeError at the final print. Force UTF-8 on
# the JSON-lines protocol streams so the worker behaves the same as on Linux.
for _stream,_errors in ((sys.stdin,'replace'),(sys.stdout,'strict'),(sys.stderr,'backslashreplace')):
    try:_stream.reconfigure(encoding='utf-8',errors=_errors)
    except (AttributeError,ValueError):pass
from runtime_metrics import process_usage,child_usage
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
MODELS=ROOT/'app/models'
loaded={}
verified=set()
PROFILE=json.loads((ROOT/'model_registry/offline-g1-profile.json').read_text())
DEFAULT_RUNTIME_SOURCE='model_registry/offline-g1-profile.json'
def runtime_profile():
    # Default: the pinned Linux b12189 runtime recorded in the shipped registry.
    # Research seam: an explicitly supplied manifest may describe another host
    # runtime (e.g. the Windows b12189 build used for validation). A manifest is
    # still verified file-by-file against its recorded sha256; it never relaxes
    # the default checks and it is recorded in the worker result.
    runtime=dict(PROFILE['native_runtime']);source=DEFAULT_RUNTIME_SOURCE
    manifest_path=os.environ.get('G1_LLAMA_RUNTIME_MANIFEST')
    if manifest_path:
        manifest=json.loads(Path(manifest_path).read_text(encoding='utf-8'))
        missing=[key for key in ('executable_sha256','tokenizer_binary','tokenizer_sha256') if not manifest.get(key)]
        if missing:raise ValueError('RUNTIME_MANIFEST_INCOMPLETE: '+','.join(missing))
        runtime.update(executable_sha256=manifest['executable_sha256'],tokenizer_binary=manifest['tokenizer_binary'],
                       tokenizer_sha256=manifest['tokenizer_sha256'],local_binary=manifest.get('local_binary',runtime['local_binary']))
        source=str(Path(manifest_path).resolve())
    return runtime,source
def verify_model(folder):
    import hashlib
    match=next(m for m in PROFILE['models'] if (MODELS/m['local_directory']).resolve()==folder.resolve())
    for item in match['files']:
        path=folder/item['path']
        if str(path) in verified:continue
        if not path.is_file() or path.stat().st_size!=item['bytes']:raise ValueError('MODEL_FILE_MISSING_OR_SIZE_MISMATCH: '+item['path'])
        if item['sha256']:
            digest=hashlib.sha256()
            with path.open('rb') as source:
                while chunk:=source.read(8*1024*1024):digest.update(chunk)
            if digest.hexdigest()!=item['sha256']:raise ValueError('MODEL_HASH_MISMATCH: '+item['path'])
        verified.add(str(path))

def deny_network():
    # Kernel-enforced denial for IPv4/IPv6 socket creation in this worker and children.
    # The parent HTTP server remains loopback-only; inference cannot contact a provider.
    if not sys.platform.startswith('linux'):return 'OFFLINE_ENV_ONLY_NOT_OS_ISOLATED'
    import ctypes,ctypes.util
    lib=ctypes.CDLL(ctypes.util.find_library('seccomp'),use_errno=True)
    class Compare(ctypes.Structure):
        _fields_=[('arg',ctypes.c_uint),('op',ctypes.c_uint),('a',ctypes.c_uint64),('b',ctypes.c_uint64)]
    lib.seccomp_init.argtypes=[ctypes.c_uint32];lib.seccomp_init.restype=ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p];lib.seccomp_syscall_resolve_name.restype=ctypes.c_int
    lib.seccomp_rule_add_array.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,ctypes.c_uint,ctypes.POINTER(Compare)]
    lib.seccomp_load.argtypes=[ctypes.c_void_p];lib.seccomp_release.argtypes=[ctypes.c_void_p]
    context=lib.seccomp_init(0x7fff0000)
    if not context:raise RuntimeError('NETWORK_ISOLATION_UNAVAILABLE')
    try:
        for family in (2,10):
            condition=Compare(0,4,family,0)
            if lib.seccomp_rule_add_array(context,0x00050001,lib.seccomp_syscall_resolve_name(b'socket'),1,ctypes.byref(condition))!=0:raise RuntimeError('NETWORK_ISOLATION_RULE_FAILED')
        if lib.seccomp_load(context)!=0:raise RuntimeError('NETWORK_ISOLATION_LOAD_FAILED')
    finally:lib.seccomp_release(context)
    import socket
    for family in (socket.AF_INET,socket.AF_INET6):
        try:
            probe=socket.socket(family,socket.SOCK_STREAM)
        except PermissionError:continue
        probe.close();raise RuntimeError('NETWORK_ISOLATION_SELF_TEST_FAILED')
    return 'SECCOMP_IPV4_IPV6_DENIED_SELF_TESTED'

ISOLATION=deny_network()


def load(kind,locale=None):
    import torch
    torch.set_num_threads(2)
    key=(kind,locale)
    if key in loaded:return loaded[key]
    # Keep one large model in memory at a time on the 8-GiB G1 laptop.
    if kind in ('asr','dialogue'):
        for previous in list(loaded):
            if previous[0] in ('asr','dialogue'):del loaded[previous]
        gc.collect()
    if kind=='asr':
        from transformers import AutoProcessor,AutoModelForCTC
        folder=MODELS/'badrex--Ethio-ASR-multilingual-600M'
        verify_model(folder)
        value=(AutoProcessor.from_pretrained(folder,local_files_only=True,trust_remote_code=False),AutoModelForCTC.from_pretrained(folder,local_files_only=True,trust_remote_code=False,use_safetensors=True).eval())
    elif kind=='dialogue':
        from transformers import AutoTokenizer,AutoModelForCausalLM,AutoConfig
        folder=MODELS/'kkenna--afaan-oromo-qwen-0.5b-sft'
        verify_model(folder)
        raw_config=json.loads((folder/'config.json').read_text())
        config=AutoConfig.from_pretrained(folder,local_files_only=True,trust_remote_code=False,rope_theta=raw_config.get('rope_parameters',{}).get('rope_theta',1000000.0))
        # Empty extra_special_tokens was exported as a list by newer Unsloth;
        # Transformers 4 expects an empty mapping. Do not modify the verified files.
        from tokenizers import Tokenizer
        tokenizer_data=json.loads((folder/'tokenizer.json').read_text())
        # This export double-escaped the Qwen2 Unicode pre-tokenizer regex.
        # Normalize only regex escapes in memory; vocabulary, merges and weights stay intact.
        for part in tokenizer_data.get('pre_tokenizer',{}).get('pretokenizers',[]):
            if isinstance(part.get('pattern'),dict) and 'Regex' in part['pattern']:
                part['pattern']['Regex']=part['pattern']['Regex'].replace('\\\\','\\')
        backend=Tokenizer.from_str(json.dumps(tokenizer_data))
        tokenizer=AutoTokenizer.from_pretrained(folder,local_files_only=True,trust_remote_code=False,extra_special_tokens={},tokenizer_object=backend,fix_mistral_regex=False)
        tokenizer.chat_template=tokenizer.chat_template.replace('\\\\n','\\n')
        value=(tokenizer,AutoModelForCausalLM.from_pretrained(folder,config=config,local_files_only=True,trust_remote_code=False,use_safetensors=True,dtype=torch.bfloat16).eval())
    elif kind=='tts':
        if os.environ.get('G1_NONCOMMERCIAL_RESEARCH')!='1':raise ValueError('TTS_NONCOMMERCIAL_OPT_IN_REQUIRED')
        from transformers import VitsModel,AutoTokenizer
        folder=MODELS/('facebook--mms-tts-amh' if locale=='am' else 'facebook--mms-tts-orm')
        verify_model(folder)
        value=(AutoTokenizer.from_pretrained(folder,local_files_only=True,trust_remote_code=False),VitsModel.from_pretrained(folder,local_files_only=True,use_safetensors=True).eval())
    elif kind=='vad':
        from silero_vad import load_silero_vad
        import importlib.resources,hashlib
        vad_file=importlib.resources.files('silero_vad.data').joinpath('silero_vad.onnx')
        if hashlib.sha256(vad_file.read_bytes()).hexdigest()!=PROFILE['vad']['sha256']:raise ValueError('VAD_HASH_MISMATCH')
        import onnxruntime
        onnxruntime.disable_telemetry_events()
        value=load_silero_vad(onnx=True)
    else:raise ValueError('UNKNOWN_COMPONENT')
    loaded[key]=value
    return value

def read_audio(path):
    import soundfile as sf,numpy as np
    audio,sr=sf.read(path,dtype='float32')
    if audio.ndim!=1 or sr!=16000:raise ValueError('AUDIO_FORMAT_UNSUPPORTED')
    if not np.isfinite(audio).all():raise ValueError('AUDIO_FORMAT_INVALID')
    return audio

def handle(job):
    if job['kind']=='tts' and os.environ.get('G1_TTS_ENGINE')=='espeak-ng':
        from espeak_tts import synthesize
        return synthesize(ROOT,job)
    import torch,numpy as np
    kind=job['kind'];locale=job.get('locale','am')
    if locale not in ('am','om'):return {'ok':False,'code':'ASR_LOCALE_UNSUPPORTED'}
    if kind in ('vad','asr'):
        audio=read_audio(job['path'])
        if len(audio)<4800:return {'ok':False,'code':'AUDIO_TOO_SHORT','text':None}
        if not np.any(audio):return {'ok':False,'code':'SILENT_CAPTURE','text':None}
        from silero_vad import get_speech_timestamps
        spans=get_speech_timestamps(torch.from_numpy(audio),load('vad'),sampling_rate=16000,threshold=0.5,min_speech_duration_ms=150,min_silence_duration_ms=100)
        seconds=sum(s['end']-s['start'] for s in spans)/16000
        if not spans:return {'ok':False,'code':'NON_SPEECH_CAPTURE','text':None,'vad':{'engine':'silero-vad-6.2.3-onnx','speech_seconds':0}}
        if kind=='vad':return {'ok':True,'code':'SPEECH_PRESENT','speech_seconds':seconds}
        processor,model=load('asr')
        values=processor(audio,sampling_rate=16000,return_tensors='pt')
        with torch.inference_mode():logits=model(**values).logits
        raw=processor.batch_decode(logits.argmax(-1))[0]
        tag=re.match(r'^\s*\[(AMH|ORM|TIR|SID|WAL)\]',raw)
        detected={'AMH':'am','ORM':'om','TIR':'ti','SID':'sid','WAL':'wal'}.get(tag[1]) if tag else None
        text=re.sub(r'\[[^\]]*\]','',raw).strip()
        if detected and detected!=locale:return {'ok':False,'code':'ASR_LANGUAGE_MISMATCH','text':None,'detected_locale':detected}
        if not any(c.isalnum() for c in text):return {'ok':False,'code':'NO_VALID_UTTERANCE','text':None}
        return {'ok':True,'code':'TRANSCRIBED','text':text,'locale':locale,'detected_locale':detected,'engine':'Ethio-ASR-multilingual-600M','vad':{'engine':'silero-vad-6.2.3-onnx','speech_seconds':seconds}}
    if kind=='dialogue' and not (locale=='om' and os.environ.get('G1_OM_DIALOGUE_MODEL')=='kkenna'):
        import subprocess
        # Release ASR before starting the larger quantized CPU model.
        for previous in list(loaded):
            if previous[0] in ('asr','dialogue'):del loaded[previous]
        gc.collect()
        model=MODELS/'Qwen3-4B-Q4_K_M.gguf'
        runtime,runtime_source=runtime_profile()
        binary=Path(os.environ.get('G1_LLAMA_BIN',str(ROOT/runtime['local_binary'])))
        if not binary.is_file() or not model.is_file():return {'ok':False,'code':'DIALOGUE_MODEL_MISSING','text':None}
        verify_model(MODELS)
        import hashlib
        if hashlib.sha256(binary.read_bytes()).hexdigest()!=runtime['executable_sha256']:raise ValueError('RUNTIME_HASH_MISMATCH')
        from model_prompt import bound_chat,native_token_count
        tokenizer_binary=Path(runtime['tokenizer_binary'])
        if not tokenizer_binary.is_absolute():tokenizer_binary=ROOT/tokenizer_binary
        if not tokenizer_binary.is_file():return {'ok':False,'code':'DIALOGUE_TOKENIZER_MISSING','text':None}
        if hashlib.sha256(tokenizer_binary.read_bytes()).hexdigest()!=runtime['tokenizer_sha256']:raise ValueError('TOKENIZER_RUNTIME_HASH_MISMATCH')
        messages=job['messages']
        max_new_tokens=min(int(job.get('max_tokens',96)),192)
        # Qwen3 documents that greedy decoding is known to loop; the recorded
        # Windows baseline echoed the user then repeated one token to the whole
        # budget and the generation guard rejected it. Use the documented
        # non-thinking sampling. -c is the pinned profile window (2048): at 1024 a
        # 4-turn conversation overflowed and llama exited non-zero (LLAMA_FAILED),
        # so a 1024 window silently breaks multi-turn dialogue. -b/-ub only bound the
        # prompt-processing/compute buffers, not the KV window.
        context_size=2048
        # temp 0.5 chosen by the focused correction-matrix: with the correction-facts block it
        # stated the corrected value and no stale value in turn 3; a product multi-turn replay at
        # 0.3 collapsed into repeating its previous reply, so 0.5 keeps turn-to-turn variety.
        # Repeat-penalty experiments (2026-11-10) removed the degenerate token loops but produced
        # garbled text that the generation guard cannot reject, so the penalty was NOT kept in
        # production. The remaining loop/quality limit is a model-capability issue.
        sampling=['--temp','0.5','--top-p','0.8','--top-k','20','--min-p','0','--seed','42']
        decoding={'temperature':0.5,'top_p':0.8,'top_k':20,'min_p':0,'seed':42,'context_size':context_size,'batch':64,'ubatch':64}
        context_started=time.monotonic()
        try:prompt,context_usage=bound_chat(messages,lambda text:native_token_count(tokenizer_binary,model,text),max_new_tokens,context_size=context_size)
        except ValueError as error:
            if str(error)=='MODEL_CONTEXT_TOO_LONG':return {'ok':False,'code':'MODEL_CONTEXT_TOO_LONG','text':None}
            raise
        context_usage['context_prepare_ms']=round((time.monotonic()-context_started)*1000)
        child_before=child_usage()
        run=subprocess.run([str(binary),'-m',str(model),'-p',prompt,'-n',str(max_new_tokens),'-c',str(context_size),'-b','64','-ub','64','-t','2','--no-context-shift','--no-conversation','--no-display-prompt','--no-warmup','--no-perf','--simple-io',*sampling,'--offline','--log-verbosity','0','--log-colors','off','--no-log-prefix','--no-log-timestamps'],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=150)
        if run.returncode:return {'ok':False,'code':'LLAMA_INFERENCE_FAILED','text':None,'detail':run.stderr[-400:]}
        text=run.stdout.replace('[end of text]','').split('<|im_end|>')[0].split('<|im_start|>')[0].strip().rstrip('\ufffd')
        if '\ufffd' in text:return {'ok':False,'code':'MODEL_OUTPUT_ENCODING_INVALID','text':None}
        child_after=child_usage()
        child_cpu=None if child_after['cpu_seconds'] is None else round(child_after['cpu_seconds']-child_before['cpu_seconds'],3)
        return {'ok':bool(text),'code':'GENERATED' if text else 'EMPTY_GENERATION','text':text,'engine':'llama.cpp-b12189/Qwen3-4B-Q4_K_M','decoding':decoding,**context_usage,'peak_child_rss_kib':child_after['peak_rss_kib'],'child_cpu_seconds':child_cpu,'runtime_manifest_source':runtime_source,'runtime_executable_sha256':runtime['executable_sha256'],'runtime_tokenizer_sha256':runtime['tokenizer_sha256']}
    if kind=='dialogue':
        tokenizer,model=load(kind,locale)
        messages=job['messages']
        # Reserve room for the reply and drop the OLDEST history from the left.
        # The previous code truncated from the right (truncation=True,max_length=1024),
        # which cut the final '<|im_start|>assistant' generation marker and produced
        # English/garbage prefixes at turn 5 (evidence/g1-windows-oromo-quality-reverify-2026-11-09.json).
        max_new=min(int(job.get('max_tokens',100)),192)
        budget=1024-max_new-8
        retained=list(messages);dropped=0
        while True:
            prompt=tokenizer.apply_chat_template(retained,tokenize=False,add_generation_prompt=True,enable_thinking=False)
            if len(tokenizer(prompt,add_special_tokens=False)['input_ids'])<=budget:break
            if len(retained)<=2:
                return {'ok':False,'code':'MODEL_CONTEXT_TOO_LONG','text':None}
            del retained[1];dropped+=1
            while len(retained)>2 and retained[1]['role']=='assistant':
                del retained[1];dropped+=1
        context_usage={'prompt_tokens':len(tokenizer(prompt,add_special_tokens=False)['input_ids']),'prompt_token_budget':budget,'context_messages_dropped':dropped}
        inputs=tokenizer(prompt,return_tensors='pt')
        torch.manual_seed(0)
        # The pinned synthetic-corpus 0.5B loops and invents numbered price
        # lists under greedy decoding (recorded baseline). Sample instead of
        # taking the argmax; the repetition penalty suppresses the fixed-loop
        # token runs. This does not turn the 0.5B into a capable assistant.
        decoding={'do_sample':True,'temperature':0.7,'top_p':0.8,'top_k':20,'repetition_penalty':1.05,'seed':0,'max_length':1024}
        with torch.inference_mode():output=model.generate(**inputs,max_new_tokens=max_new,do_sample=True,temperature=0.7,top_p=0.8,top_k=20,repetition_penalty=1.05,use_cache=True,pad_token_id=tokenizer.eos_token_id,eos_token_id=[tokenizer.eos_token_id,tokenizer.convert_tokens_to_ids('<|im_end|>')])
        text=tokenizer.decode(output[0,inputs['input_ids'].shape[1]:],skip_special_tokens=True).strip()
        return {'ok':bool(text),'code':'GENERATED' if text else 'EMPTY_GENERATION','text':text,'engine':'kkenna/afaan-oromo-qwen-0.5b-sft','decoding':decoding,**context_usage,'generated_tokens':len(output[0])-inputs['input_ids'].shape[1]}
    if kind=='tts':
        tokenizer,model=load(kind,locale)
        torch.manual_seed(0)
        inputs=tokenizer(job['text'][:1200],return_tensors='pt')
        if not inputs['input_ids'].numel():return {'ok':False,'code':'TTS_EMPTY_TOKENS'}
        with torch.inference_mode():audio=model(**inputs).waveform[0].cpu().numpy()
        import soundfile as sf
        path=Path(job['path']);path.parent.mkdir(parents=True,exist_ok=True)
        sf.write(path,audio,model.config.sampling_rate,subtype='PCM_16')
        return {'ok':True,'code':'SYNTHESIZED','path':str(path),'bytes':path.stat().st_size,'sample_rate':model.config.sampling_rate,'seconds':len(audio)/model.config.sampling_rate,'peak':float(np.abs(audio).max()),'engine':'MMS-VITS','license':'CC-BY-NC-4.0','scope':'NONCOMMERCIAL_G1_RESEARCH_ONLY'}
    raise ValueError('UNKNOWN_JOB')

for line in sys.stdin:
    started=time.monotonic();before=process_usage()
    try:
        job=json.loads(line)
        # Third-party informational stdout must not corrupt the JSON protocol.
        original=sys.stdout;sys.stdout=sys.stderr
        try:result=handle(job)
        finally:sys.stdout=original
    except Exception as e:
        result={'ok':False,'code':'OFFLINE_MODEL_FAILED','detail':type(e).__name__+': '+str(e),'text':None}
    after=process_usage()
    result.update(network_isolation=ISOLATION,verified_local_artifacts=len(verified),latency_ms=round((time.monotonic()-started)*1000),peak_rss_kib=after['peak_rss_kib'],cpu_seconds=round(after['cpu_seconds']-before['cpu_seconds'],3),resource_scope=after['metric_source'])
    print(json.dumps(result,ensure_ascii=False),flush=True)
