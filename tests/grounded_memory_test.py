"""Structural provenance only; real language quality has separate native receipts."""
import json,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'research'))
from grounded_memory import parse_state,answer_messages

class Grounding(unittest.TestCase):
    def setUp(self):
        self.turns=['My name is Example.','I now own 11 sheep.','How many do I own?']
        self.state={'name':'Example','name_turn':1,'owner':'current_user','entity':'sheep','quantity':11,'quantity_turn':2,'quote':self.turns[1]}
    def test_original_entity_and_question_survive(self):
        state=parse_state(json.dumps(self.state),self.turns)
        messages=answer_messages(state,self.turns,'om')
        self.assertEqual(messages[-1]['content'],self.turns[-1]);self.assertIn('11 sheep',messages[1]['content'])
        self.assertNotIn('latest_question_english',json.dumps(messages))
    def test_unanchored_translated_entity_rejected(self):
        with self.assertRaisesRegex(ValueError,'ENTITY_NOT_IN_QUOTE'):parse_state(json.dumps(self.state|{'entity':'degrees'}),self.turns)
    def test_other_owner_not_promoted_to_current_user(self):
        with self.assertRaisesRegex(ValueError,'OWNER_UNRESOLVED'):parse_state(json.dumps(self.state|{'owner':'neighbour'}),self.turns)
    def test_invented_source_quote_rejected(self):
        with self.assertRaisesRegex(ValueError,'QUOTE_NOT_IN_SOURCE'):parse_state(json.dumps(self.state|{'quote':'I own 99 sheep.'}),self.turns)
    def test_legacy_entity_free_schema_rejected(self):
        with self.assertRaisesRegex(ValueError,'STATE_SCHEMA'):parse_state(json.dumps({'name':'Example','current_count':11,'latest_question_english':'Question'}),self.turns)
    def test_boolean_quantity_is_not_an_integer_count(self):
        with self.assertRaisesRegex(ValueError,'QUANTITY_INVALID'):parse_state(json.dumps(self.state|{'quantity':True}),self.turns)
if __name__=='__main__':unittest.main()
