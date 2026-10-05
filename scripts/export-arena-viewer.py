#!/usr/bin/env python3
"""Package a deterministic, model-covering Arena sample; never infer answer codes.

Run with the reporting project's environment, which provides prefscope, pandas
and numpy. Input files are read-only; the standard exporter refuses overwrite.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pandas as pd

from prefscope.api.feature_catalog import FeatureCatalog
from prefscope.core.features import FeatureBatch
from prefscope.viewer_export import export_viewer_bundle

ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def sample_indices(panel, size):
    """Retain the first occurrence of each real model, then hash-sample battles."""
    if size <= 0:
        raise ValueError('rows must be positive')
    required, seen = set(), set()
    for index, row in enumerate(panel[['model_a', 'model_b']].itertuples(index=False)):
        owners = set(row)
        if owners - seen:
            required.add(index)
            seen.update(owners)
    if size < len(required):
        raise ValueError(f'rows must be at least {len(required)} to retain model coverage')
    remaining = sorted((i for i in range(len(panel)) if i not in required),
                       key=lambda i: hashlib.sha256(panel.iloc[i].battle_id.encode()).digest())
    return sorted(required | set(remaining[:max(0, size - len(required))]))



def verify_alignment(panel, codes, cohort, manifest):
    actual = sha256(cohort / 'panel.parquet')
    recorded = manifest['encoding_provenance']['panel_sha256']
    result = {'actual_panel_sha256': actual, 'manifest_panel_sha256': recorded}
    if actual == recorded:
        return dict(result, method='manifest panel hash'), []
    # If panel bytes differ from the encoding manifest, require
    # exact ID, text, owner, preference and numeric matches to the encoding inputs.
    root = cohort.parent
    paths = [root / 'codes' / source / 'meta.parquet' for source in ['response', 'prompt']]
    paths += [root / 'codes/response/z_diff.npy', root / 'codes/prompt/z_prompt.npy',
              root / 'extension_10k/codes.npz', root / 'extension_10k/panel.parquet']
    if not all(path.is_file() for path in paths):
        raise ValueError('panel alignment hash differs and encoded ID anchors are unavailable')
    split = manifest['original_shared']
    columns = ['battle_id', 'group_id', 'prompt', 'completion_a', 'completion_b', 'model_a', 'model_b', 'human_y_a']
    for source, name in [('response', 'z_diff'), ('prompt', 'z_prompt')]:
        meta = pd.read_parquet(root / 'codes' / source / 'meta.parquet').rename(columns={'human_pref': 'human_y_a'})
        if not meta[columns].reset_index(drop=True).equals(panel.iloc[:split][columns].reset_index(drop=True)):
            raise ValueError(f'{source} original encoding row alignment differs')
        if not np.array_equal(np.load(root / 'codes' / source / f'{name}.npy'), codes[name][:split]):
            raise ValueError(f'{source} original encoded values differ')
    with np.load(root / 'extension_10k/codes.npz', allow_pickle=False) as extension:
        positions = pd.Index(extension['battle_id']).get_indexer(panel.battle_id.iloc[split:])
        if (positions < 0).any():
            raise ValueError('extension encoding IDs do not cover the combined panel')
        for name in codes:
            if not np.array_equal(extension[name][positions], codes[name][split:]):
                raise ValueError(f'{name} extension encoded row alignment differs')
        if not np.array_equal(extension['human_pref'][positions], panel.human_y_a.iloc[split:]):
            raise ValueError('extension encoded human preferences differ')
    extension_panel = pd.read_parquet(root / 'extension_10k/panel.parquet').set_index('battle_id', drop=False)
    aligned = extension_panel.loc[panel.battle_id.iloc[split:], columns].reset_index(drop=True)
    if not aligned.equals(panel.iloc[split:][columns].reset_index(drop=True)):
        raise ValueError('extension source text/model row alignment differs')
    return dict(result, method='exact original and extension encoding ID/text/owner/preference/value matches'), paths


def export_arena(paper, viewer_dist, out, rows=2000):
    paper = Path(paper).resolve()
    cohort = paper / 'data/arena140k_modern/combined_20k'
    manifest = json.loads((paper / 'artifact_manifest.json').read_text())
    alignment = json.loads((cohort / 'manifest.json').read_text())
    panel_path = cohort / 'panel.parquet'
    panel = pd.read_parquet(panel_path)
    if len(panel) != alignment['total'] or not panel.battle_id.is_unique:
        raise ValueError('panel must have the declared number of unique battle IDs')
    for column in ['battle_id', 'group_id', 'prompt', 'completion_a', 'completion_b', 'model_a', 'model_b']:
        if not panel[column].map(lambda value: isinstance(value, str) and bool(value)).all():
            raise ValueError(f'{column} must contain nonempty strings')
    if not panel.human_y_a.isin([0, .5, 1]).all():
        raise ValueError('human preferences must retain canonical A scores 0, 0.5, or 1')
    indices = sample_indices(panel, rows)
    selected = panel.iloc[indices]
    ids = tuple(selected.battle_id)
    codes = {}
    for name, width in [('z_diff', 32), ('z_prompt', 256)]:
        values = np.load(cohort / f'{name}.npy', mmap_mode='r', allow_pickle=False)
        if values.shape != (len(panel), width) or not np.isfinite(values).all():
            raise ValueError(f'{name} has incompatible rows, width, or nonfinite values')
        codes[name] = values
    verified, anchors = verify_alignment(panel, codes, cohort, alignment)
    codes = {name: values[indices] for name, values in codes.items()}
    prompt_names_path = (paper / manifest['prompt_names_source']).resolve()
    difference_names_path = paper / 'paper/derived/m32_feature_names.csv'
    if 'paper/derived/m32_feature_names.csv' not in manifest['feature_names']:
        raise ValueError('difference labels are not declared by the artifact manifest')
    prompt_labels = pd.read_csv(prompt_names_path, keep_default_na=False)
    if (set(prompt_labels.feature_space_id) != {manifest['prompt_names_feature_space']}
            or not prompt_labels.feature_id.between(0, 255).all()
            or not prompt_labels.pole.isin(['positive', 'negative']).all()
            or prompt_labels.duplicated(['feature_id', 'pole']).any()):
        raise ValueError('prompt labels have incompatible coordinate/pole identities')
    prompt_labels = prompt_labels.rename(columns={'concept_name': 'name'})
    difference_labels = pd.read_csv(difference_names_path, keep_default_na=False)
    catalog = FeatureCatalog(difference_labels[['feature_id', 'concept', 'status']].rename(columns={'concept': 'name'}),
                             provenance={'source': 'paper/derived/m32_feature_names.csv'})
    sources = {os.path.relpath(path, paper): sha256(path)
               for path in [panel_path, cohort / 'z_diff.npy', cohort / 'z_prompt.npy',
                            cohort / 'manifest.json', difference_names_path, prompt_names_path, *anchors]}
    provenance = {
        'title': f'Arena · {len(selected):,} battles · signed A−B contrasts',
        'source': 'lmarena-140k', 'source_sha256': sources,
        'selection': {'method': 'first occurrence per generating model, then SHA-256 battle-ID order; output in source row order',
                      'source_rows': len(panel), 'selected_rows': len(selected),
                      'generating_models': len(set(selected.model_a) | set(selected.model_b)),
                      'source_row_indices': indices},
        'preference_source': 'recorded human_y_a: 1=A, 0=B, 0.5=tie; not a judge score',
        'outcome_semantics': 'recorded_human_choice',
        'representation_model': 'Qwen/Qwen3-Embedding-8B',
        'comparison_semantics': 'signed A-minus-B response difference; not individual-answer concept presence',
        'encoding_provenance': alignment['encoding_provenance'],
        'alignment_verification': verified,
    }
    metadata = {column: tuple(selected[column]) for column in selected.columns
                if column not in {'completion_a', 'completion_b'}}
    metadata.update(prompt_id=tuple(selected.group_id), response_a=tuple(selected.completion_a),
                    response_b=tuple(selected.completion_b), preference_probability=tuple(selected.human_y_a),
                    judge=tuple('Human' for _ in ids),
                    winner=tuple({1: 'a', 0: 'b', .5: 'tie'}[value] for value in selected.human_y_a))
    features = FeatureBatch(row_ids=ids, arrays={'z_diff': codes['z_diff']},
                            roles={'z_diff': 'response_difference'}, orientations={'z_diff': 'a_minus_b'},
                            metadata=metadata, activation_polarity='signed', code_semantics='axis', provenance=provenance)
    prompt = FeatureBatch(row_ids=ids, arrays={'z_prompt': codes['z_prompt']},
                          roles={'z_prompt': 'prompt'}, orientations={'z_prompt': 'prompt'},
                          activation_polarity='signed', code_semantics='axis',
                          provenance={'source_sha256': sources, 'declared_prompt_feature_space': manifest['prompt_names_feature_space']})
    return export_viewer_bundle(features, out, viewer_dist=viewer_dist, catalog=catalog,
                                prompt_features=prompt, tables={'prompt_pole_labels': prompt_labels})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--paper', type=Path, default=ROOT.parent / 'prefscope-evaluator-agreement')
    parser.add_argument('--viewer-dist', type=Path, default=ROOT / 'dist')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--rows', type=int, default=2000)
    args = parser.parse_args()
    print(export_arena(args.paper, args.viewer_dist, args.out, args.rows))


if __name__ == '__main__':
    main()
