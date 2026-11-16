"""Regression tests for the proven Windows dialogue decoding defects.

Recorded baseline evidence:
  evidence/g1-windows-authorized-am-dialogue-2026-11-09.json  (greedy Qwen3-4B:
    echoes the user sentence then repeats one token to the token budget; the
    product generation guard returns MODEL_OUTPUT_REPETITIVE)
  evidence/g1-windows-authorized-om-dialogue-2026-11-09.json  (greedy kkenna 0.5B:
    invents numbered price ranges)

These tests pin the product decoder fix and the opt-in Windows runtime seam.
They do not load either model.
"""
import json, os, subprocess, sys, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = (ROOT/'app/src/offline_models.py').read_text(encoding='utf-8')


def am_branch_source():
    return SRC.split("if kind=='dialogue' and not (locale=='om'", 1)[1].split("if kind=='dialogue':", 1)[0]


def om_branch_source():
    # line-anchored: "elif kind=='dialogue':" in load() also contains the substring
    return SRC.split("\n    if kind=='dialogue':", 1)[1].split("if kind=='tts':", 1)[0]


class DialogueDecodingFix(unittest.TestCase):
    def test_am_dialogue_uses_documented_non_thinking_sampling(self):
        branch = am_branch_source()
        self.assertNotIn("'--temp','0'", branch, 'greedy decoding is the proven repetition defect')
        for flag, value in (('--temp', '0.5'), ('--top-p', '0.8'), ('--top-k', '20'), ('--min-p', '0')):
            self.assertIn(f"'{flag}','{value}'", branch)

    def test_am_dialogue_bounds_kv_and_compute_buffers(self):
        branch = am_branch_source()
        self.assertIn("'-c',str(context_size)", branch)
        self.assertIn("context_size=2048", branch, 'a 1024 window overflowed on turn 4 (LLAMA_FAILED)')
        self.assertIn("'-b','64','-ub','64'", branch)
        # prompt budget must be computed against the same context size the decoder uses
        self.assertIn("context_size=context_size", branch)

    def test_om_dialogue_samples_instead_of_greedy(self):
        branch = om_branch_source()
        self.assertNotIn('do_sample=False', branch, 'greedy decoding is the proven repetition defect')
        self.assertIn('do_sample=True', branch)
        self.assertIn('repetition_penalty=1.05', branch)

    def test_om_dialogue_reserves_context_and_drops_oldest_history(self):
        branch = om_branch_source()
        code = '\n'.join(line for line in branch.split('\n') if not line.strip().startswith('#'))
        # the proven defect: right-side truncation cut the assistant generation marker
        self.assertNotIn('truncation=True', code)
        self.assertIn("inputs=tokenizer(prompt,return_tensors='pt')", code)
        self.assertIn('budget=1024-max_new-8', branch)
        self.assertIn("del retained[1]", branch)
        self.assertIn("MODEL_CONTEXT_TOO_LONG", branch)
        self.assertIn("'context_messages_dropped':dropped", branch)

    def test_qwen3_nonthinking_prefill_is_kept(self):
        sys.path.insert(0, str(ROOT/'app/src'))
        from model_prompt import render_chat
        prompt = render_chat([{'role': 'system', 'content': 's'}, {'role': 'user', 'content': 'u'}])
        self.assertTrue(prompt.endswith('<|im_start|>assistant\n<think>\n\n</think>\n\n'))

    def test_runtime_manifest_is_opt_in_and_default_pin_untouched(self):
        self.assertIn('G1_LLAMA_RUNTIME_MANIFEST', SRC)
        self.assertIn("DEFAULT_RUNTIME_SOURCE='model_registry/offline-g1-profile.json'", SRC)
        # default behaviour: the shipped profile still pins the Linux b12189 runtime
        profile = json.loads((ROOT/'model_registry/offline-g1-profile.json').read_text(encoding='utf-8'))
        self.assertEqual(profile['native_runtime']['executable_sha256'],
                         '7119bef261611b26f326f7c4da4dc3fdeb7bb28e2faf1ec392bda7b21215ef52')
        self.assertTrue(profile['native_runtime']['local_binary'].startswith('app/bin/llama-cpp/'))
        self.assertIn("!=runtime['executable_sha256']", SRC)


class RuntimeManifestWorker(unittest.TestCase):
    def test_incomplete_manifest_is_rejected_before_any_inference(self):
        manifest = Path(os.environ.get('TEMP', str(ROOT/'.tmp')))/'g1-dialogue-bad-manifest.json'
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps({'executable_sha256': '0'*64}), encoding='utf-8')
        env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8',
               'G1_LLAMA_RUNTIME_MANIFEST': str(manifest),
               'G1_LLAMA_BIN': str(ROOT/'app/models/Qwen3-4B-Q4_K_M.gguf')}
        job = {'kind': 'dialogue', 'locale': 'am', 'messages': [{'role': 'user', 'content': 'ሰላም'}], 'max_tokens': 8}
        run = subprocess.run([sys.executable, str(ROOT/'app/src/offline_models.py')], input=json.dumps(job)+'\n',
                             capture_output=True, text=True, encoding='utf-8', errors='replace', env=env,
                             timeout=120, cwd=str(ROOT))
        result = json.loads(run.stdout.strip().splitlines()[-1])
        self.assertFalse(result['ok'])
        self.assertEqual(result['code'], 'OFFLINE_MODEL_FAILED')
        self.assertIn('RUNTIME_MANIFEST_INCOMPLETE', result['detail'])


if __name__ == '__main__':
    unittest.main()
