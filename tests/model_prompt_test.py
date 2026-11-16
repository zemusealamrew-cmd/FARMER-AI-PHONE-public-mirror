"""Context assembly mechanics only; actual native inference has separate receipts."""
import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app/src'))
from model_prompt import bound_chat,render_chat


class ContextBudget(unittest.TestCase):
    def test_short_history_keeps_exact_prompt(self):
        messages=[{'role':'system','content':'safety'},{'role':'user','content':'ሰላም።'}]
        prompt,usage=bound_chat(messages,len,10,500)
        self.assertEqual(prompt,render_chat(messages))
        self.assertEqual(usage['context_messages_dropped'],0)
        self.assertIn('user\nሰላም።<|im_end|>\n',prompt)

    def test_old_pair_removed_but_current_question_and_rules_survive(self):
        messages=[{'role':'system','content':'safety'},
                  {'role':'user','content':'old '*100},
                  {'role':'assistant','content':'old reply'},
                  {'role':'user','content':'Maqaan koo eenyu?'}]
        original=[dict(m) for m in messages]
        prompt,usage=bound_chat(messages,len,10,300)
        self.assertNotIn('old',prompt)
        self.assertIn('safety',prompt)
        self.assertIn('Maqaan koo eenyu?',prompt)
        self.assertEqual(usage['context_messages_dropped'],2)
        self.assertEqual(messages,original)
        self.assertLessEqual(usage['prompt_tokens']+10+4,300)

    def test_oversized_current_question_fails_without_silent_truncation(self):
        with self.assertRaisesRegex(ValueError,'MODEL_CONTEXT_TOO_LONG'):
            bound_chat([{'role':'system','content':'safety'},
                        {'role':'user','content':'x'*1000}],len,10,300)

    def test_unanswered_user_history_drops_only_oldest(self):
        messages=[{'role':'system','content':'safety'},
                  {'role':'user','content':'old '*100},
                  {'role':'user','content':'Maqaan koo Caalaa dha.'},
                  {'role':'user','content':'Maqaan koo eenyu?'}]
        prompt,usage=bound_chat(messages,len,10,350)
        self.assertEqual(usage['context_messages_dropped'],1)
        self.assertIn('Caalaa',prompt)


if __name__=='__main__':unittest.main()
