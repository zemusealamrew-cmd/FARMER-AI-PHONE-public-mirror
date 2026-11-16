"""Bound local ChatML context using the model's actual tokenizer."""
import json
import subprocess


def render_chat(messages):
    return ''.join('<|im_start|>'+m['role']+'\n'+m['content']+'<|im_end|>\n' for m in messages)+'<|im_start|>assistant\n<think>\n\n</think>\n\n'


def bound_chat(messages, count_tokens, max_new_tokens, context_size=2048):
    # Never truncate the current question or safety/source instructions. Remove
    # oldest history instead, including its assistant reply if present.
    retained=list(messages)
    dropped=0
    budget=context_size-max_new_tokens-4
    while True:
        prompt=render_chat(retained)
        count=count_tokens(prompt)
        if count<=budget:
            return prompt, {'prompt_tokens':count,'prompt_token_budget':budget,
                            'context_messages_dropped':dropped}
        if len(retained)<=2:
            raise ValueError('MODEL_CONTEXT_TOO_LONG')
        del retained[1]
        dropped+=1
        while len(retained)>2 and retained[1]['role']=='assistant':
            del retained[1]
            dropped+=1


def native_token_count(binary, model, prompt):
    run=subprocess.run([str(binary),'-m',str(model),'--stdin','--ids','--offline',
                        '--log-verbosity','0'],input=prompt,capture_output=True,
                       text=True,encoding='utf-8',timeout=30)
    if run.returncode:
        raise RuntimeError('DIALOGUE_TOKENIZATION_FAILED')
    tokens=json.loads(run.stdout)
    if not isinstance(tokens,list) or not all(isinstance(t,int) for t in tokens):
        raise RuntimeError('DIALOGUE_TOKENIZATION_INVALID')
    return len(tokens)
