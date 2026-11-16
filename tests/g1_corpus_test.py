"""Adversarial checks for the offline corpus boundary, not language quality tests."""
import hashlib,json,shutil,subprocess,sys,tempfile,unittest
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[1]/'tools/prepare-g1-corpus.py'

class CorpusBoundary(unittest.TestCase):
    def run_fixture(self,rows,tamper=False):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        root=Path(directory.name);(root/'tools').mkdir();(root/'evidence').mkdir()
        self.fixture_root=root
        folder=root/'app/.tmp/g1-licensed-data';folder.mkdir(parents=True)
        shutil.copyfile(SOURCE,root/'tools/prepare-g1-corpus.py')
        raw=''.join(json.dumps(r)+'\n' for r in rows).encode()
        (folder/'source-records.jsonl').write_bytes(raw+(b' ' if tamper else b''))
        (root/'evidence/g1-licensed-data-acquisition-2026-11-08.json').write_text(json.dumps({'source_records_sha256':hashlib.sha256(raw).hexdigest()}))
        process=subprocess.run([sys.executable,str(root/'tools/prepare-g1-corpus.py')],capture_output=True,text=True)
        report=root/'evidence/g1-licensed-corpus-splits-2026-11-08.json'
        return process,json.loads(report.read_text()) if report.exists() else None

    def rows(self):
        return [dict(source='fixture',source_id=f'{l}{i}',locale=l,group=f'{l}-author-{i}',input=f'{l} question {i}',target=f'{l} answer {i}',license='Apache-2.0',source_url='fixture') for l in ('am','om') for i in range(3)]

    def test_group_disjoint_and_duplicate_quarantined(self):
        rows=self.rows();rows.append(rows[0]|{'source_id':'duplicate','group':'other-author'})
        p,r=self.run_fixture(rows)
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertEqual(r['kept'],6)
        self.assertEqual(len(r['quarantined']),1)
        partitions={name:{x['group'] for x in r['index'] if x['split']==name} for name in r['counts']}
        self.assertFalse(partitions['train_candidate']&partitions['evaluation_candidate'])
        self.assertFalse(r['training_ready'])

    def test_source_tampering_rejected(self):
        p,r=self.run_fixture(self.rows(),tamper=True)
        self.assertNotEqual(p.returncode,0);self.assertIn('SOURCE_HASH_MISMATCH',p.stderr);self.assertIsNone(r)

    def test_split_hashes_match_actual_bytes(self):
        p,r=self.run_fixture(self.rows())
        self.assertEqual(p.returncode,0,p.stderr)
        for name,expected in r['split_hashes'].items():
            actual=(self.fixture_root/'app/.tmp/g1-licensed-data'/f'{name}.jsonl').read_bytes()
            self.assertEqual(hashlib.sha256(actual).hexdigest(),expected)

    def test_restrictive_license_rejected(self):
        rows=self.rows();rows[0]['license']='CC-BY-NC-4.0'
        p,r=self.run_fixture(rows)
        self.assertNotEqual(p.returncode,0);self.assertIn('LICENSE_NOT_ALLOWED',p.stderr);self.assertIsNone(r)

    def test_near_duplicate_across_splits_blocks_preparation(self):
        rows=self.rows()
        for row in rows:row['target']=' '.join('unique'+str(i) for i in range(150))
        p,r=self.run_fixture(rows)
        self.assertNotEqual(p.returncode,0);self.assertTrue(r['cross_split_near_duplicates']);self.assertFalse(r['training_ready'])

if __name__=='__main__':unittest.main()
