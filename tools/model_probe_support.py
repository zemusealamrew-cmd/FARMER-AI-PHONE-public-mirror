"""Local model-owned prompt formats and explicit research decoding profiles."""
import hashlib
from pathlib import Path
import sys
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'app/src'))
from model_prompt import render_chat


def render_messages(profile,messages,bos_override=None):
    template=profile.get('chat_template')
    if not template:return render_chat(messages)
    source=(root/template['path']).read_bytes()
    if hashlib.sha256(source).hexdigest()!=template['sha256']:raise ValueError('CHAT_TEMPLATE_HASH_MISMATCH')
    from jinja2.sandbox import ImmutableSandboxedEnvironment
    environment=ImmutableSandboxedEnvironment(trim_blocks=True,lstrip_blocks=True)
    def fail(message):raise ValueError(message)
    environment.globals['raise_exception']=fail
    return environment.from_string(source.decode()).render(messages=messages,
        bos_token=template['bos_token'] if bos_override is None else bos_override,
        eos_token=template['eos_token'],enable_thinking=False,add_generation_prompt=True,tools=None)


def sampling_arguments(name):
    profiles={
        'legacy-greedy':['--temp','0','--seed','0'],
        'qwen35-instruct':['--temp','0.7','--top-p','0.8','--top-k','20','--min-p','0','--presence-penalty','1.5','--repeat-penalty','1.0','--seed','0'],
        'gemma4-instruct':['--temp','1.0','--top-p','0.95','--top-k','64','--min-p','0','--presence-penalty','0','--repeat-penalty','1.0','--seed','0'],
    }
    return profiles[name]
