"""Run with PrefScope-reporting-public/.venv/bin/python -m unittest discover -s tests -p test_arena_viewer_export.py."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

try:
    import numpy as np
    import pandas as pd
    import prefscope
    AVAILABLE = True
except ModuleNotFoundError:
    AVAILABLE = False

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('arena_export', ROOT / 'scripts/export-arena-viewer.py')
arena = importlib.util.module_from_spec(spec)
if AVAILABLE:
    spec.loader.exec_module(arena)


@unittest.skipUnless(AVAILABLE, 'requires reporting-project environment (prefscope, pandas, numpy)')
class ArenaExportTest(unittest.TestCase):
    def test_real_contract_sample_alignment_labels_and_no_answer_codes(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); paper = base / 'paper'; cohort = paper / 'data/arena140k_modern/combined_20k'
            cohort.mkdir(parents=True); (paper / 'paper/derived').mkdir(parents=True)
            panel = pd.DataFrame(dict(battle_id=['x', 'y', 'z', 'w'], group_id=['p', 'p', 'q', 'r'],
                                     prompt=['Prompt']*4, completion_a=['<think>exact</think> A']*4, completion_b=['B']*4,
                                     model_a=['m1', 'm1', 'm2', 'rare'], model_b=['m2']*4,
                                     human_y_a=[0., .5, 1., .5]))
            panel.to_parquet(cohort / 'panel.parquet', index=False)
            diff = np.zeros((4,32), dtype=np.float32); diff[:,0] = [-3, 0, 2, 4]
            prompt = np.zeros((4,256), dtype=np.float32); prompt[:,0] = [2, -2, 1, -1]
            np.save(cohort / 'z_diff.npy', diff); np.save(cohort / 'z_prompt.npy', prompt)
            (cohort / 'manifest.json').write_text(json.dumps({'total':4, 'original_shared':2, 'encoding_provenance': {'panel_sha256':arena.sha256(cohort / 'panel.parquet')}}))
            pd.DataFrame({'feature_id':[0], 'concept':['More detail'], 'status':['candidate']}).to_csv(paper / 'paper/derived/m32_feature_names.csv', index=False)
            pd.DataFrame({'feature_space_id':['sha256:test']*2, 'feature_id':[0,0], 'pole':['positive','negative'],
                          'concept_name':['Positive name','Negative name'], 'reason':['Positive reason','Negative reason'], 'naming_status':['proposed','mixed']}).to_csv(paper / 'names.csv', index=False)
            (paper / 'artifact_manifest.json').write_text(json.dumps({'prompt_names_source':'names.csv', 'prompt_names_feature_space':'sha256:test', 'feature_names':['paper/derived/m32_feature_names.csv']}))
            dist = base / 'dist'; dist.mkdir(); (dist / 'index.html').write_text('<!doctype html><title>fixture</title>')
            (dist / 'viewer-build.json').write_text(json.dumps({'schema':'prefscope.viewer_build','schema_version':1,'package':'@prefscope/viewer','version':'0.1.0','supported_data_schemas':[{'schema':'prefscope.viewer_data','versions':[1,2]}]}))
            indices = arena.sample_indices(panel, 3)
            self.assertEqual(indices, arena.sample_indices(panel, 3)); self.assertIn(3,indices)
            out = arena.export_arena(paper, dist, base / 'export', 3)
            data = json.loads((out / 'data/viewer-data.json').read_text())
            self.assertEqual(data['row_ids'], panel.iloc[indices].battle_id.tolist())
            self.assertEqual(data['views']['z_diff']['values'], diff[indices].tolist())
            self.assertEqual(data['prompt']['views']['z_prompt']['values'], prompt[indices].tolist())
            self.assertEqual(set(data['views']), {'z_diff'})
            self.assertEqual(data['views']['z_diff']['role'], 'response_difference')
            self.assertEqual(data['views']['z_diff']['orientation'], 'a_minus_b')
            self.assertEqual(data['row_metadata']['preference_probability'], panel.iloc[indices].human_y_a.tolist())
            self.assertEqual(data['row_metadata']['response_a'], panel.iloc[indices].completion_a.tolist())
            self.assertEqual(data['row_metadata']['response_b'], panel.iloc[indices].completion_b.tolist())
            self.assertNotIn('completion_a', data['row_metadata'])
            self.assertNotIn('completion_b', data['row_metadata'])
            self.assertEqual(data['row_metadata']['winner'], [{0:'b', .5:'tie', 1:'a'}[v] for v in panel.iloc[indices].human_y_a])
            full = arena.export_arena(paper, dist, base / 'full', 4)
            full_data = json.loads((full / 'data/viewer-data.json').read_text())
            self.assertEqual(full_data['row_metadata']['winner'], ['b','tie','a','tie'])
            self.assertEqual(set(data['row_metadata']['model_a']+data['row_metadata']['model_b']), {'m1','m2','rare'})
            self.assertNotIn('map_projections', data['tables'])
            self.assertIn('Negative reason', str(data['tables']['prompt_pole_labels']))
            bundle = json.loads((out / 'viewer-bundle.json').read_text())
            for entry in bundle['files']:
                self.assertEqual(arena.sha256(out / entry['path']), entry['sha256'])
            with self.assertRaises(FileExistsError): arena.export_arena(paper,dist,out,3)
            self.assertEqual(data['row_metadata']['judge'], ['Human']*3)
            self.assertEqual(data['provenance']['outcome_semantics'], 'recorded_human_choice')
            # A changed serialization hash is accepted only with exact independent
            # encoding metadata and raw-value anchors, never shape checks alone.
            for source, name, matrix in [('response','z_diff',diff),('prompt','z_prompt',prompt)]:
                folder = cohort.parent / 'codes' / source; folder.mkdir(parents=True)
                panel.iloc[:2].rename(columns={'human_y_a':'human_pref'}).to_parquet(folder / 'meta.parquet', index=False)
                np.save(folder / f'{name}.npy', matrix[:2])
            extension = cohort.parent / 'extension_10k'; extension.mkdir()
            panel.iloc[2:].to_parquet(extension / 'panel.parquet', index=False)
            np.savez(extension / 'codes.npz', battle_id=panel.battle_id.iloc[2:].to_numpy(dtype=str),
                     human_pref=panel.human_y_a.iloc[2:].to_numpy(), z_diff=diff[2:], z_prompt=prompt[2:])
            stale = json.loads((cohort / 'manifest.json').read_text())
            stale['encoding_provenance']['panel_sha256'] = '0'*64
            (cohort / 'manifest.json').write_text(json.dumps(stale))
            verified = arena.export_arena(paper, dist, base / 'verified', 3)
            verified_data = json.loads((verified / 'data/viewer-data.json').read_text())
            self.assertIn('exact original', verified_data['provenance']['alignment_verification']['method'])
            wrong = diff.copy(); wrong[[0,1]] = wrong[[1,0]]; np.save(cohort / 'z_diff.npy',wrong)
            with self.assertRaisesRegex(ValueError,'encoded values differ'): arena.export_arena(paper,dist,base / 'wrong',3)
            np.save(cohort / 'z_diff.npy',diff)
            panel.loc[0,'completion_a']='changed';panel.to_parquet(cohort / 'panel.parquet',index=False)
            with self.assertRaisesRegex(ValueError,'alignment'): arena.export_arena(paper,dist,base / 'bad',3)
            self.assertFalse((base / 'bad').exists())


if __name__ == '__main__': unittest.main()
