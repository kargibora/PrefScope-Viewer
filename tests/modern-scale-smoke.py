#!/usr/bin/env python3
"""Reproducible 3,000-response / 2,048-concept / 106-model browser smoke test; no timing thresholds.

Run after npm run build:bundle:
    uv run --with playwright python tests/modern-scale-smoke.py
The synthetic dataset and valid export exist only in a temporary directory.
"""
from functools import partial
from hashlib import sha256
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from time import perf_counter
import json
import shutil
import subprocess
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
ROWS, FEATURES, MODELS = 3000, 2048, 106


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def synthetic_data():
    data = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        "import {genericFixture} from './tests/modern-fixture.mjs'; console.log(JSON.stringify(genericFixture()));"], cwd=ROOT))
    labels = {i: f'Synthetic named {i:04d}' if i % 16 == 0 or i == FEATURES - 1 else None for i in range(FEATURES)}
    names = {i: label or f'Unnamed concept {i + 1}' for i, label in labels.items()}
    counts = [0] * FEATURES
    values = []
    for row in range(ROWS):
        active = {0, row % (FEATURES - 1), (row * 37 + 17) % (FEATURES - 1)}
        if row == ROWS - 1:
            active.add(FEATURES - 1)
        vector = [0] * FEATURES
        for feature in active:
            vector[feature] = 1 + row % 7
            counts[feature] += 1
        values.append(vector)
    data.update(row_ids=[f'synthetic-scale-{i:04d}' for i in range(ROWS)], feature_ids=list(range(FEATURES)),
                provenance={'title': f'Synthetic scalability test — {ROWS} rows, {FEATURES} concepts, {MODELS} models'},
                row_metadata={'model': [f'synthetic/model-{i % MODELS:02d}' for i in range(ROWS)],
                              'response': [f'Synthetic scale answer {i}.' for i in range(ROWS)]})
    data['views']['response']['values'] = values
    data['catalog'] = dict(feature_space=data['feature_space'], provenance={'feature_space_status': 'unbound'}, column_sources={},
                           table=dict(index=list(range(FEATURES)), index_names=[None], column_names=[None],
                                      columns=['feature_id', 'name', 'description'],
                                      data=[[i, labels[i], f'Synthetic explanation for feature {i}.' if labels[i] else None] for i in range(FEATURES)]))
    return data, labels, names, counts


def paired_data(data):
    count = ROWS // 2
    view = data['views']['response']
    return {**data, 'schema_version': 2,
        'row_ids': [f'synthetic-paired-scale-{i:04d}' for i in range(count)],
        'provenance': {'title': f'Synthetic paired scale — {count} battles, {ROWS} answers, {MODELS} models'},
        'views': {
            'left_vectors': {**view, 'role': 'response_a', 'orientation': 'absolute_a', 'values': view['values'][::2]},
            'right_vectors': {**view, 'role': 'response_b', 'orientation': 'absolute_b', 'values': view['values'][1::2]}},
        'row_metadata': {
            'prompt': [f'Synthetic paired prompt {i}.' for i in range(count)],
            'response_a': data['row_metadata']['response'][::2],
            'response_b': data['row_metadata']['response'][1::2],
            'model_a': [f'synthetic/model-{i % MODELS:02d}' for i in range(count)],
            'model_b': [f'synthetic/model-{(i + 1) % MODELS:02d}' for i in range(count)]}}


def owned_vectors(data, model, opponent=None):
    metadata = data['row_metadata']
    if 'model' in metadata:
        return [vector for owner, vector in zip(metadata['model'], data['views']['response']['values']) if owner == model]
    result = []
    for row, (a, b) in enumerate(zip(metadata['model_a'], metadata['model_b'])):
        if opponent is not None and {a, b} != {model, opponent}:
            continue
        for owner, source in [(a, 'left_vectors'), (b, 'right_vectors')]:
            if owner == model:
                result.append(data['views'][source]['values'][row])
    return result


def compare_models(page, base, kind, data, names):
    start = perf_counter()
    page.goto(f'{base}/{kind}/index.html#models', wait_until='networkidle')
    expect(page.locator('body')).to_have_attribute('data-engine-source', 'shared')
    if not page.locator('[data-duel-first]').count():
        page.locator('[data-model-mode="duel"]').click()
    expect(page.locator('[data-duel-first] option')).to_have_count(MODELS)
    assert saved(page)['modelMode'] == 'duel'
    expect(page.locator('#context-strip')).to_be_hidden()
    first, last = 'synthetic/model-00', f'synthetic/model-{MODELS - 1:02d}'
    page.locator('[data-duel-first]').select_option(first)
    selected = perf_counter()
    page.locator('[data-duel-second]').select_option(last)
    expect(page.locator('[data-duel-second]')).to_have_value(last)
    print(f'{kind}: Models load + choose model {MODELS - 1}: {(perf_counter()-start)*1000:.1f} ms; last-model selection {(perf_counter()-selected)*1000:.1f} ms', flush=True)
    expect(page.locator('[data-duel-source]')).to_have_value('answer')
    expect(page.locator('[data-duel-source] option[value="pair"], [data-duel-source] option[value="prompt"]')).to_have_count(0)
    expect(page.locator('.response-preference')).to_have_count(0)
    rows = page.locator('[data-duel-concept]')
    expect(rows).to_have_count(40)
    assert keys(rows, 'data-duel-concept') == [f'answer:{i}' for i in range(40)]
    vectors = [owned_vectors(data, model) for model in (first, last)]
    active = [[sum(vector[feature] > 0 for vector in owned) for feature in range(FEATURES)] for owned in vectors]

    def check_metrics(feature, counts, totals):
        row = page.locator(f'[data-duel-concept="answer:{feature}"]')
        for side, count, total in zip(('first', 'second'), counts, totals):
            cell = row.locator(f'.duel-value.duel-{side}')
            expect(cell.locator('strong')).to_have_text(f'{count / total * 100:.1f}%' if total else '—')
            expect(cell.locator('small')).to_have_text(f'{count} / {total}')

    check_metrics(0, [counts[0] for counts in active], list(map(len, vectors)))
    ordering = sorted(range(FEATURES), key=lambda feature: (-active[0][feature] / len(vectors[0]), names[feature].casefold()))
    start = perf_counter()
    page.locator('[data-duel-sort="first"]').click()
    assert keys(rows, 'data-duel-concept') == [f'answer:{i}' for i in ordering[:40]]
    print(f'{kind}: sort {FEATURES} concepts {(perf_counter()-start)*1000:.1f} ms; rendered rows {rows.count()}', flush=True)
    varied = next(feature for feature in ordering if feature and active[0][feature])
    check_metrics(varied, [counts[varied] for counts in active], list(map(len, vectors)))
    start = perf_counter()
    page.locator('[data-duel-page="next"]').click()
    assert keys(rows, 'data-duel-concept') == [f'answer:{i}' for i in ordering[40:80]]
    print(f'{kind}: comparison page 2 {(perf_counter()-start)*1000:.1f} ms', flush=True)
    page.locator('[data-duel-sort="first"]').click()
    ascending = sorted(range(FEATURES), key=lambda feature: (active[0][feature] / len(vectors[0]), names[feature].casefold()))
    assert keys(rows, 'data-duel-concept') == [f'answer:{i}' for i in ascending[:40]]
    page.locator('[data-duel-sort="first"]').click()
    assert keys(rows, 'data-duel-concept') == [f'answer:{i}' for i in range(40)]

    if kind == 'paired':
        # Missing probabilities and labels are not invented from activation values.
        expect(page.locator('.duel-scoreline .duel-first > strong')).to_have_text('—')
        expect(page.locator('.duel-scoreline .duel-second > strong')).to_have_text('—')
        expect(page.locator('.duel-score-center')).to_contain_text('Winner labels not supplied')
        start = perf_counter()
        page.locator('[data-duel-scope]').select_option('headToHead')
        direct = [owned_vectors(data, model, opponent) for model, opponent in [(first, last), (last, first)]]
        assert 0 < len(direct[0]) < len(vectors[0])
        for feature in (0, 1):
            check_metrics(feature, [sum(vector[feature] > 0 for vector in owned) for owned in direct], list(map(len, direct)))
        print(f'paired: direct cohort {len(direct[0])} battles vs {len(vectors[0])}/{len(vectors[1])} all responses, switch {(perf_counter()-start)*1000:.1f} ms', flush=True)
        page.locator('[data-duel-battles]').click()
        drawer = page.locator('.battle-evidence-drawer')
        expect(drawer.locator('.response-card')).to_have_count(2)
        expect(drawer).to_contain_text('Outcome not supplied')
        cursor = saved(page)['duelBattleCursor']['row_id']
        row = data['row_ids'].index(cursor)
        assert data['row_metadata']['model_a'][row] == last and data['row_metadata']['model_b'][row] == first
        for side in ('a', 'b'):
            expect(drawer.locator(f'.owner-{side} .owner-text')).to_have_text(data['row_metadata'][f'response_{side}'][row])
            expect(drawer.locator(f'.owner-{side}')).to_contain_text(data['row_metadata'][f'model_{side}'][row])
        page.keyboard.press('Escape')
        page.locator('[data-duel-scope]').select_option('all')
        for width, height in [(1440, 900), (1024, 600)]:
            page.set_viewport_size({'width': width, 'height': height})
            page.locator('#app').evaluate('e=>e.scrollTop=0')
            page.evaluate('window.scrollTo(0, 0)')
            assert page.locator('#app').evaluate('e=>e.scrollWidth<=e.clientWidth')
            controls = [page.locator(f'[{attribute}]').bounding_box() for attribute in
                        ('data-duel-source', 'data-duel-metric', 'data-duel-scope')]
            for left, right in zip(controls, controls[1:]):
                assert left['x'] + left['width'] <= right['x'] + 1, (width, controls)
            page.screenshot(path=f'/tmp/arena-individual-scale-{width}.png')
    else:
        expect(page.locator('.duel-battles')).to_contain_text('No direct battles')
        expect(page.locator('.duel-scoreline, [data-duel-battles]')).to_have_count(0)


def export(folder, data):
    shutil.copytree(DIST, folder)
    (folder / 'data').mkdir()
    (folder / 'data/viewer-data.json').write_text(json.dumps(data, separators=(',', ':')))
    build = json.loads((folder / 'viewer-build.json').read_text())
    files = [dict(path=p.relative_to(folder).as_posix(), size_bytes=p.stat().st_size,
                  sha256=sha256(p.read_bytes()).hexdigest()) for p in folder.rglob('*') if p.is_file()]
    bundle = dict(schema='prefscope.viewer_bundle', schema_version=1,
                  producer=dict(package='prefscope', version='0.3.1'),
                  viewer=dict(package=build['package'], version=build['version'],
                              build=dict(path='viewer-build.json', schema=build['schema'], schema_version=build['schema_version'],
                                         supported_data_schemas=build['supported_data_schemas']),
                              build_sha256=next(x['sha256'] for x in files if x['path'] == 'viewer-build.json')),
                  data=dict(path='data/viewer-data.json', schema=data['schema'], schema_version=data['schema_version']), files=files)
    (folder / 'viewer-bundle.json').write_text(json.dumps(bundle))


def keys(locator, attribute):
    return locator.evaluate_all('(nodes,attribute)=>nodes.map(e=>e.getAttribute(attribute))', attribute)


def saved(page):
    return page.evaluate('history.state.values')


assert (DIST / 'index.html').is_file(), 'Run npm run build:bundle first.'
with TemporaryDirectory(prefix='prefscope-scale-') as temporary:
    folder = Path(temporary)
    data, labels, names, counts = synthetic_data()
    export(folder / 'viewer', data)
    paired = paired_data(data)
    export(folder / 'paired', paired)
    ThreadingHTTPServer.request_queue_size = 128
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(folder)))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            start = perf_counter()
            page.goto(f'http://127.0.0.1:{server.server_port}/viewer/index.html#answers', wait_until='networkidle')
            expect(page.locator('body')).to_have_attribute('data-engine-source', 'shared')
            expect(page.locator('.context-count')).to_have_text(f'{ROWS:,} matching answers')
            print(f'Synthetic {ROWS}×{FEATURES}, {MODELS} models: ready {(perf_counter()-start)*1000:.1f} ms', flush=True)
            page.click('#answer-model-trigger')
            expect(page.locator('[data-answer-scope^="model:"]')).to_have_count(MODELS)
            page.keyboard.press('Escape')

            # The last feature is deliberately rare and below the first catalog page.
            start = perf_counter()
            page.fill('#concept-search', '#2047')
            result = page.locator('.concept-result')
            expect(result).to_have_count(1)
            expect(result).to_have_attribute('data-focus-concept', 'answer:2047')
            print(f'Sidebar last-feature search {(perf_counter()-start)*1000:.1f} ms', flush=True)
            result.click()
            expect(page.locator('.context-count')).to_have_text(f'{counts[-1]} matching answers')
            expect(page.locator('.reader-heading h1')).to_have_text(names[FEATURES - 1])
            expect(page.locator('.response-card .owner-text')).to_have_text(f'Synthetic scale answer {ROWS - 1}.')
            assert saved(page)['answerCursor']['row_id'] == data['row_ids'][-1]

            # Sort/filter outcomes are compared to the generated data, not DOM position alone.
            page.fill('#concept-search', '')
            for order, ordering in [('id', lambda i: i), ('name', lambda i: names[i].casefold()),
                                    ('count', lambda i: (-counts[i], names[i].casefold()))]:
                page.select_option('[data-concept-order]', order)
                expected = sorted(range(FEATURES - 1), key=ordering)[:8]
                assert keys(page.locator('.concept-result'), 'data-focus-concept') == [f'answer:{i}' for i in expected]
            page.select_option('[data-concept-order]', 'id')
            page.click('[data-concept-naming="named"]')
            named = sorted(i for i in range(FEATURES - 1) if labels[i])[:8]
            assert keys(page.locator('.concept-result'), 'data-focus-concept') == [f'answer:{i}' for i in named]
            assert all('Unnamed concept' not in text for text in page.locator('.concept-result').all_text_contents())
            page.click('[data-concept-naming="all"]')
            assert any('Unnamed concept' in text for text in page.locator('.concept-result').all_text_contents())

            start = perf_counter()
            page.click('.browse-all')
            expect(page.locator('.query-row')).to_have_count(60)
            first = keys(page.locator('.query-row'), 'data-select-concept')
            ordering = sorted(range(FEATURES), key=lambda i: (-counts[i], names[i].casefold()))
            assert first == [f'answer:{i}' for i in ordering[:60]]
            assert 'answer:2047' not in first
            print(f'Browse all open {(perf_counter()-start)*1000:.1f} ms; rendered rows {len(first)}', flush=True)
            page.locator('[data-catalog-page="query:next"]').focus()
            page.keyboard.press('Enter')
            second = keys(page.locator('.query-row'), 'data-select-concept')
            assert len(second) <= 60 and second == [f'answer:{i}' for i in ordering[60:120]]
            page.select_option('#query-sort', 'name')
            assert keys(page.locator('.query-row'), 'data-select-concept') == [f'answer:{i}' for i in sorted(range(FEATURES), key=lambda i: names[i].casefold())[:60]]
            page.fill('#query-input', '#2047')
            expect(page.locator('.query-row')).to_have_count(1)
            expect(page.locator('.query-row')).to_have_attribute('data-select-concept', 'answer:2047')
            page.locator('.query-row').click()
            expect(page.locator('#overlay-root [role="dialog"]')).to_have_count(0)
            assert saved(page)['answerKeys'] == ['answer:2047']
            expect(page.locator('.response-card .owner-text')).to_have_text(f'Synthetic scale answer {ROWS - 1}.')
            assert page.locator('#app').evaluate('e=>e.scrollWidth<=e.clientWidth')
            base = f'http://127.0.0.1:{server.server_port}'
            compare_models(page, base, 'viewer', data, names)
            compare_models(page, base, 'paired', paired, names)
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        thread.join()
print(f'Scale smoke passed: {MODELS} models, {FEATURES} concepts; 3000 generic answers and 1500 paired battles/3000 answers. Exact catalog navigation, model cohort metrics, missing preferences, sorting and bounded pagination. Synthetic nonnegative activations only; larger real cohorts are not covered.')
