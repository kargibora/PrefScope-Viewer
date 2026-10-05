#!/usr/bin/env python3
"""Difference-lens ownership checks against a production bundle.

Run npm run build:bundle, then:
  uv run --with playwright python tests/modern-difference-smoke.py
All exports and HTTP serving are temporary. Synthetic models are explicitly named.
"""
from functools import partial
from hashlib import sha256
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import json
import re
import shutil
import subprocess
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
COUNT = 52


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def table(rows):
    columns = list(rows[0])
    return dict(index=list(range(len(rows))), index_names=[None], column_names=[None],
                columns=columns, data=[[row[key] for key in columns] for row in rows])


def fixture(mixed=False, orientation='a_minus_b'):
    options = json.dumps(dict(mixed=mixed, orientation=orientation))
    data = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        "import {differenceFixture} from './tests/difference-fixture.mjs'; "
        f"console.log(JSON.stringify(differenceFixture({options})));"], cwd=ROOT))
    data['row_ids'] = [f'synthetic-battle-{row:02d}' for row in range(COUNT)]
    data['row_metadata'] = dict(
        prompt=[f'Synthetic shared prompt {row}.' for row in range(COUNT)],
        prompt_id=[f'synthetic-prompt-{row}' for row in range(COUNT)],
        response_a=[f'  A-{row:02d} **original** <literal> & café\n' + 'Full A response.\n' * 300 + f'A-END-{row:02d}  ' for row in range(COUNT)],
        response_b=[f'  B-{row:02d} **original** <literal> & café\n' + 'Full B response.\n' * 300 + f'B-END-{row:02d}  ' for row in range(COUNT)],
        model_a=[f'synthetic/model-{row:02d}' for row in range(COUNT)],
        model_b=[f'synthetic/model-{(row + 1) % COUNT:02d}' for row in range(COUNT)])
    # No preference column: a signed feature is never a fabricated winner label.
    for source, view in data['views'].items():
        view['values'] = ([[row + 1 if row % 2 == 0 else -row - 1, 0 if row % 3 == 0 else 2 if row % 3 == 1 else -2]
                           for row in range(COUNT)] if source == 'difference_vectors'
                          else [[1 if source == 'z_a' else 0, 0 if source == 'z_a' else 3] for row in range(COUNT)])
    data['prompt']['row_ids'] = data['row_ids'][:]
    for view in data['prompt']['views'].values():
        view['values'] = [[1, 0] for _ in range(COUNT)]
    source = 'difference_vectors'
    view = data['views'][source]
    metadata = dict(projection_id='pair', method='umap', basis='full_feature_activations', preprocessing='none',
                    space='main', feature_space_id=None, feature_ids=data['feature_ids'], views=[source],
                    view_descriptors=[dict(view=source, **{key: value for key, value in view.items() if key != 'values'})],
                    row_order='row_major_view_order', n_rows=COUNT, n_features=2, n_points=COUNT,
                    n_zero_rows=0, parameters={}, versions={}, input_hash='synthetic-difference-map')
    points = [dict(projection_id='pair', space='main', row_id=row_id, view=source,
                   x=row, y=(row * 7) % 13, zero_vector=False) for row, row_id in enumerate(data['row_ids'])]
    data['tables'] = dict(example_umap_meta=table([metadata]), example_umap_points=table(points))
    return data


def export(folder, data):
    shutil.copytree(ROOT / 'dist', folder)
    (folder / 'data').mkdir(exist_ok=True)
    (folder / 'data/viewer-data.json').write_text(json.dumps(data))
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


def state(page):
    return page.evaluate('history.state.values')


def choose(page, key):
    if state(page)['answerKeys'][0] != key:
        page.locator(f'[data-focus-concept="{key}"]').first.click()
    assert state(page)['answerKeys'][0] == key


def assert_pair_reader(page, data, root='.difference-reader'):
    reader = page.locator(root)
    expect(reader.locator('[data-reading-mode], .response-preference')).to_have_count(0)
    assert state(page).get('answerCursor'), {'state': state(page), 'reader': reader.inner_text()[:900]}
    row_id = state(page)['answerCursor']['row_id']
    row = data['row_ids'].index(row_id)
    for side in ('a', 'b'):
        card = reader.locator(f'.response-card.owner-{side}')
        expect(card).to_be_visible()
        expect(card.locator('.owner-text')).to_contain_text(f'{side.upper()}-END-{row:02d}')
        expect(card.locator('.owner-text strong')).to_have_text('original')
        card.locator('[data-drawer^="source:"]').click()
        source = page.locator('#overlay-root .source-text')
        expect(source).to_have_count(2)
        assert source.nth(0).text_content() == data['row_metadata']['prompt'][row]
        assert source.nth(1).text_content() == data['row_metadata'][f'response_{side}'][row]
        page.keyboard.press('Escape')
        expect(page.locator('#overlay-root .drawer')).to_have_count(0)
        expect(card).to_contain_text(data['row_metadata'][f'model_{side}'][row])
        expect(card.locator('.pa-activation-profile')).to_have_count(0)
    expect(reader.locator('.response-preference')).to_have_count(0)
    key = state(page)['answerKeys'][0]
    orientation = data['views']['difference_vectors']['orientation']
    greater = 'a' if (orientation == 'a_minus_b') == key.endswith(':positive') else 'b'
    badge = reader.locator('.concept-direction-badge')
    expect(badge).to_have_count(1)
    expect(badge).to_have_attribute('data-concept-direction', greater)
    expect(reader.locator(f'.owner-{greater}')).to_have_class(re.compile(r'concept-pronounced'))


def smoke(browser, base, name, data):
    page = browser.new_page(viewport=dict(width=1440, height=900))
    page.set_default_timeout(10_000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(f'{base}/{name}/index.html#answers', wait_until='networkidle')
    expect(page.locator('body')).to_have_attribute('data-engine-source', 'shared')
    pair = page.locator('[data-answer-lens="pair"]')
    if pair.count():
        pair.click()
    page.locator('[data-reader-sort]').select_option('dataset')
    expect(page.locator('.difference-reader')).to_be_visible()
    choose(page, 'pair:3:positive')
    assert_pair_reader(page, data)
    before = state(page)['answerCursor']
    page.reload(wait_until='networkidle')
    expect(page.locator('.difference-reader')).to_be_visible()
    assert state(page)['answerLens'] == 'pair' and state(page)['answerCursor'] == before
    assert_pair_reader(page, data)
    expect(page.locator('.pair-activation-section')).to_have_count(1)
    expect(page.locator('.population-count')).to_contain_text('26 / 52')
    expect(page.locator('.population-count')).to_contain_text(re.compile('battle', re.I))
    assert state(page)['answerCursor']['source'] == json.dumps(['main', 'difference_vectors'], separators=(',', ':'))
    choose(page, 'pair:3:negative')
    assert_pair_reader(page, data)
    row = data['row_ids'].index(state(page)['answerCursor']['row_id'])
    assert data['views']['difference_vectors']['values'][row][0] < 0
    expect(page.locator('.population-count')).to_contain_text('26 / 52')
    page.locator('[data-activation-pick="quartile:3"]').click()
    expect(page.locator('#context-strip [data-clear-activation]')).to_be_visible()
    row = data['row_ids'].index(state(page)['answerCursor']['row_id'])
    assert abs(data['views']['difference_vectors']['values'][row][0]) >= 39
    page.locator('#context-strip [data-clear-activation]').click()
    # Scope is participant membership, not the fixed A or B response position.
    page.locator('#answer-model-trigger').click()
    expect(page.locator('#answer-model-menu header')).to_contain_text('52')
    page.locator('#answer-model-search').fill('synthetic/model-01')
    page.locator('[data-answer-scope="model:synthetic/model-01"]').click()
    expect(page.locator('.population-count')).to_contain_text('1 / 2')
    row = data['row_ids'].index(state(page)['answerCursor']['row_id'])
    assert row == 1, 'Negative member should be the battle where model-01 occupies A'
    choose(page, 'pair:3:positive')
    row = data['row_ids'].index(state(page)['answerCursor']['row_id'])
    assert row == 0, 'Positive member should be the battle where model-01 occupies B'
    assert_pair_reader(page, data)
    if name == 'no-map':
        page.locator('[data-overlay="relationships"]').first.click()
        page.locator('[data-rel-minimum]').fill('0')
        page.locator('[data-rel-minimum]').press('Tab')
        page.locator('[data-rel-check="prompt:12:positive"]').click()
        page.locator('[data-apply-relationships]').click()
        expect(page.locator('[data-remove-relationship="prompt:12:positive"]')).to_be_visible()
        assert_pair_reader(page, data)
        page.locator('[data-remove-relationship="prompt:12:positive"]').click()
    if name == 'mixed':
        page.locator('[data-answer-lens="answer"]').click()
        expect(page.locator('.difference-reader')).to_have_count(0)
        assert state(page)['answerKeys'][0].startswith('answer:')
        expect(page.locator('.response-card')).to_have_count(1)
        page.locator('[data-answer-lens="pair"]').click()
        assert state(page)['answerKeys'][0].startswith('pair:')
        assert_pair_reader(page, data)
    else:
        individual = page.locator('[data-answer-lens="answer"]')
        assert not individual.count() or individual.is_disabled(), 'Unavailable individual vectors must not be fabricated'
    page.locator('#app').evaluate('e=>e.scrollTop=0')
    page.screenshot(path=f'/tmp/difference-{name}-1440.png')
    page.set_viewport_size(dict(width=1024, height=600))
    expect(page.locator('.difference-reader .owner-a')).to_be_visible()
    expect(page.locator('.difference-reader .owner-b')).to_be_visible()
    assert page.locator('#app').evaluate('e=>e.scrollWidth<=e.clientWidth'), 'Reader horizontally overflows'
    boxes = [page.locator(f'.difference-reader .owner-{side} .owner-text').bounding_box() for side in ('a', 'b')]
    assert boxes[1]['x'] >= boxes[0]['x'] + boxes[0]['width'], 'Both responses must remain side by side at 1024px'
    assert all(box['y'] < 600 and box['width'] >= 250 for box in boxes), boxes
    page.screenshot(path=f'/tmp/difference-{name}-1024.png')
    if name != 'no-map':
        page.goto(f'{base}/{name}/index.html#map', wait_until='networkidle')
        expect(page.locator('#map-canvas')).to_be_visible()
        expect(page.locator('[data-map-space="pair"]')).to_have_attribute('aria-pressed', 'true')
        page.locator('.map-panel-tabs [data-map-panel="examples"]').click()
        assert state(page)['mapSpace'] == 'pair'
        page.locator('[data-map-record]').first.click()
        page.locator('[data-overlay="sample"]').click()
        dialog = page.locator('.map-sample-dialog')
        expect(dialog).to_contain_text(re.compile('A-END-\\d+'))
        expect(dialog).to_contain_text(re.compile('B-END-\\d+'))
        expect(dialog.locator('.overlay-head h2')).to_have_text('Response pair')
        page.keyboard.press('Escape')
        page.locator('[data-open-map-observation]').click()
        expect(page.locator('.difference-reader')).to_be_visible()
        assert state(page)['answerCursor']['source'] == json.dumps(['main', 'difference_vectors'], separators=(',', ':'))
        assert_pair_reader(page, data)
        page.goto(f'{base}/{name}/index.html#map', wait_until='networkidle')
        page.locator('[data-map-panel="concepts"]').click()
        page.locator('[data-map-concept="pair:7:positive"]').click()
        page.locator('.map-panel-tabs [data-map-panel="examples"]').click()
        page.locator('[data-map-population-select]').select_option('all')
        page.locator('[data-map-sort]').select_option('dataset')
        page.locator('[data-map-record="0"]').click()
        page.locator('[data-overlay="sample"]').click()
        expect(page.locator('.map-sample-dialog .concept-direction-badge')).to_have_count(0)
        expect(page.locator('.map-sample-dialog')).to_contain_text('Inactive')
        page.keyboard.press('Escape')
    page.goto(f'{base}/{name}/index.html#dataset', wait_until='networkidle')
    page.locator('[data-dataset-mode="concepts"]').click()
    page.locator('[data-dataset-source="pair"]').click()
    expect(page.locator('[data-measurement^="pair:"]')).to_have_count(4)
    expect(page.locator('#dataset-body')).to_contain_text(re.compile('battle|pairs', re.I))
    page.locator('[data-measurement="pair:3:positive"]').click()
    page.locator('#overlay-root [data-focus-concept="pair:3:positive"]').click()
    expect(page.locator('.difference-reader')).to_be_visible()
    assert_pair_reader(page, data)
    if name != 'mixed':
        models(page, base, name, data)
    assert not errors, errors
    page.close()
    print(f'{name}: source ownership, signed filters, model membership, lens/cursor persistence, dataset and available-map checks passed.')


def sort_header(page, kind, key):
    return page.locator(f'button[data-{kind}-sort="{key}"]').locator('xpath=ancestor::*[@role="columnheader"][1]')


def models(page, base, name, data, scored=False):
    page.goto(f'{base}/{name}/index.html#models', wait_until='networkidle')
    expect(page.locator('[data-comparison-model]')).to_have_count(52)
    expect(page.locator('.route-head .kicker')).to_have_count(0)
    expect(page.locator('#context-strip')).not_to_be_visible()
    model = lambda number: page.locator(f'[data-comparison-model="synthetic/model-{number:02d}"]')
    metric = lambda number: model(number).locator('.profile-stat').first.locator('strong') if model(number).locator('.profile-stat').count() else model(number).locator('.comparison-value strong')
    expect(page.locator('[data-battle-sort="support"]')).to_contain_text('Battles')
    default_order = page.locator('[data-comparison-model]').evaluate_all('(es)=>es.map(e=>e.dataset.comparisonModel)')
    expect(page.locator('select[data-battle-sort]')).to_have_count(0)
    if scored:
        page.locator('[data-battle-sort="metric"]').click()
        expect(metric(0)).to_have_text('75.0%')
        expect(metric(1)).to_have_text('25.0%')
        expect(metric(2)).to_have_text('100.0%')
        expect(page.locator('[data-comparison-model]').first).to_have_attribute('data-comparison-model', 'synthetic/model-02')
        page.locator('[data-battle-metric]').select_option('meanPreference')
        expect(metric(0)).to_have_text('75.0%')
        expect(metric(1)).to_have_text('25.0%')
        page.locator('[data-battle-sort="metric"]').click()
        page.locator('[data-battle-sort="metric"]').click()
    else:
        expect(page.locator('.comparison-notice')).to_have_count(0)
        expect(page.locator('.comparison-missing')).to_have_count(52)
        expect(page.locator('.comparison-outcomes small')).to_have_count(0)
        expect(model(0).locator('.comparison-support b')).to_have_text('2')
        expect(model(0).locator('.comparison-support small')).to_have_count(0)
        page.locator('[data-battle-metric]').select_option('meanPreference')
        expect(page.locator('.comparison-missing')).to_have_count(52)
        expect(model(0).locator('.comparison-support b')).to_have_text('2')
        expect(model(0).locator('.comparison-support small')).to_have_count(0)
    page.locator('[data-battle-tab="concepts"]').click()
    page.locator('[data-battle-concept]').select_option('pair:3:positive')
    normal = data['views']['difference_vectors']['orientation'] == 'a_minus_b'
    expect(metric(0)).to_have_text('100.0%' if normal else '0.0%')
    expect(metric(1)).to_have_text('0.0%' if normal else '100.0%')
    expect(model(0).locator('.profile-stat').first.locator('small')).to_have_text('2 / 2' if normal else '0 / 2')
    expect(model(0).locator('.profile-stat').first.locator('small')).to_contain_text('/ 2')
    page.locator('[data-battle-sort="share"]').click()
    expect(sort_header(page, 'battle', 'share')).to_have_attribute('aria-sort', 'descending')
    expect(page.locator('[data-comparison-model]').first).to_have_attribute('data-comparison-model', 'synthetic/model-00' if normal else 'synthetic/model-01')
    page.locator('[data-battle-sort="meanGap"]').click()
    expect(sort_header(page, 'battle', 'meanGap')).to_have_attribute('aria-sort', 'descending')
    expect(page.locator('[data-comparison-model]').first).to_have_attribute('data-comparison-model', 'synthetic/model-50' if normal else 'synthetic/model-51')
    page.reload(wait_until='networkidle')
    expect(sort_header(page, 'battle', 'meanGap')).to_have_attribute('aria-sort', 'descending')
    expect(page.locator('[data-comparison-model]').first).to_have_attribute('data-comparison-model', 'synthetic/model-50' if normal else 'synthetic/model-51')
    page.locator('[data-battle-sort="meanGap"]').click()
    expect(sort_header(page, 'battle', 'meanGap')).to_have_attribute('aria-sort', 'ascending')
    expect(page.locator('[data-comparison-model]').first).to_have_attribute('data-comparison-model', 'synthetic/model-51' if normal else 'synthetic/model-50')
    page.locator('[data-battle-sort="meanGap"]').click()
    expect(sort_header(page, 'battle', 'meanGap')).to_have_attribute('aria-sort', 'none')
    assert page.locator('[data-comparison-model]').evaluate_all('(es)=>es.map(e=>e.dataset.comparisonModel)') == default_order
    page.locator('[data-battle-sort="share"]').click()
    page.locator('[data-battle-model-search]').fill('synthetic/model-01')
    expect(page.locator('[data-comparison-model]')).to_have_count(1)
    page.locator('[data-battle-model-search]').fill('')
    page.locator('[data-battle-concept]').select_option('pair:3:negative')
    expect(metric(0)).to_have_text('0.0%' if normal else '100.0%')
    page.locator('[data-battle-concept]').select_option('pair:3:positive')
    # One of model-01's two feature-7 gaps is zero: concept examples omit it,
    # while performance examples retain the recorded battle.
    page.locator('[data-battle-concept]').select_option('pair:7:positive')
    model(1).locator('[data-profile-evidence]').click()
    drawer = page.locator('.battle-evidence-drawer')
    expect(drawer.locator('[data-profile-group="equal"]')).to_have_count(0)
    expect(drawer.locator('[data-profile-group="all"]')).to_have_attribute('aria-pressed', 'true')
    expect(drawer.locator('.battle-evidence-toolbar')).to_contain_text('1 of 1')
    expect(drawer).to_contain_text('A-END-01')
    expect(drawer).not_to_contain_text('A-END-00')
    expect(drawer.locator('[data-profile-evidence-page="next"]')).to_be_disabled()
    page.keyboard.press('Escape')
    page.locator('[data-battle-tab="performance"]').click()
    model(1).locator('[data-battle-evidence]').click()
    expect(drawer.locator('.battle-evidence-toolbar')).to_contain_text('1 of 2')
    expect(drawer).to_contain_text('A-END-00')
    drawer.locator('[data-battle-evidence-page="next"]').click()
    expect(drawer).to_contain_text('A-END-01')
    page.keyboard.press('Escape')
    page.locator('[data-battle-tab="concepts"]').click()
    page.locator('[data-battle-concept]').select_option('pair:3:positive')
    page.locator('[data-battle-opponent]').select_option('synthetic/model-01')
    page.locator('[data-battle-minimum]').fill('1')
    page.locator('[data-battle-minimum]').press('Tab')
    expect(page.locator('[data-comparison-model]')).to_have_count(2)
    expect(model(0).locator('.profile-stat').first.locator('small')).to_contain_text('/ 1')
    expect(model(2).locator('.profile-stat').first.locator('small')).to_contain_text('/ 1')
    model(0).locator('[data-profile-evidence]').click()
    drawer = page.locator('.battle-evidence-drawer')
    expect(drawer).to_be_visible()
    group = 'more' if normal else 'less'
    page.locator(f'[data-profile-group="{group}"]').click()
    expect(drawer.locator('.response-card')).to_have_count(2)
    expect(drawer).to_contain_text('A-END-00')
    expect(drawer).to_contain_text('B-END-00')
    expect(drawer.locator('.concept-direction-badge')).to_have_count(1)
    expect(drawer.locator('.concept-direction-badge')).to_have_attribute('data-concept-direction', 'a' if normal else 'b')
    expect(drawer.locator('[data-reading-mode], .response-preference')).to_have_count(0)
    page.keyboard.press('Escape')
    expect(drawer).to_have_count(0)


def missing_sort(page, base):
    page.goto(f'{base}/missing-sort/index.html#models', wait_until='networkidle')
    rows = page.locator('[data-comparison-model]')
    expect(rows).to_have_count(52)
    source_order = rows.evaluate_all('(es)=>es.map(e=>e.dataset.comparisonModel)')
    for direction in ('descending', 'ascending'):
        page.locator('[data-battle-sort="metric"]').click()
        expect(sort_header(page, 'battle', 'metric')).to_have_attribute('aria-sort', direction)
        expect(rows.last).to_have_attribute('data-comparison-model', 'synthetic/model-51')
        expect(rows.last.locator('.comparison-missing')).to_have_text('Not supplied')
        assert rows.first.get_attribute('data-comparison-model') != 'synthetic/model-51'
    page.reload(wait_until='networkidle')
    expect(sort_header(page, 'battle', 'metric')).to_have_attribute('aria-sort', 'ascending')
    expect(rows.last).to_have_attribute('data-comparison-model', 'synthetic/model-51')
    page.locator('[data-battle-sort="metric"]').click()
    expect(sort_header(page, 'battle', 'metric')).to_have_attribute('aria-sort', 'none')
    assert rows.evaluate_all('(es)=>es.map(e=>e.dataset.comparisonModel)') == source_order
    for direction, expected in [('ascending', sorted(source_order)), ('descending', sorted(source_order, reverse=True)), ('none', source_order)]:
        page.locator('[data-battle-sort="name"]').click()
        expect(sort_header(page, 'battle', 'name')).to_have_attribute('aria-sort', direction)
        assert rows.evaluate_all('(es)=>es.map(e=>e.dataset.comparisonModel)') == expected


def compare_models(page, base, name, mixed=True):
    page.goto(f'{base}/{name}/index.html#models', wait_until='networkidle')
    page.locator('[data-model-mode="duel"]').click()
    expect(page.locator('[data-duel-first] option')).to_have_count(52)
    page.locator('[data-duel-first]').select_option('synthetic/model-00')
    page.locator('[data-duel-second]').select_option('synthetic/model-01')

    def values(key, first, second, support_first, support_second):
        row = page.locator(f'[data-duel-concept="{key}"]')
        expect(row.locator('.duel-value.duel-first strong')).to_have_text(first)
        expect(row.locator('.duel-value.duel-second strong')).to_have_text(second)
        expect(row.locator('.duel-value.duel-first small')).to_have_text(support_first)
        expect(row.locator('.duel-value.duel-second small')).to_have_text(support_second)

    if mixed:
        for source, key in [('prompt', 'prompt:12:positive'), ('answer', 'answer:3')]:
            page.locator('[data-duel-source]').select_option(source)
            page.locator('[data-duel-scope]').select_option('all')
            values(key, '50.0%', '50.0%', '1 / 2', '1 / 2')
            page.locator('[data-duel-scope]').select_option('headToHead')
            values(key, '100.0%', '100.0%' if source == 'prompt' else '0.0%', '1 / 1', '1 / 1' if source == 'prompt' else '0 / 1')
    else:
        expect(page.locator('[data-duel-source] option[value="answer"]')).to_have_count(0)
    page.locator('[data-duel-source]').select_option('pair')
    page.locator('[data-duel-scope]').select_option('all')
    values('pair:3:positive', '100.0%', '0.0%', '2 / 2', '0 / 2')
    expect(page.locator('select[data-duel-sort]')).to_have_count(0)
    rows = page.locator('[data-duel-concept]')
    source_order = rows.evaluate_all('(es)=>es.map(e=>e.dataset.duelConcept)')
    for direction, first_key in [('descending', 'pair:3:positive'), ('ascending', 'pair:3:negative')]:
        page.locator('[data-duel-sort="first"]').click()
        expect(sort_header(page, 'duel', 'first')).to_have_attribute('aria-sort', direction)
        expect(rows.first).to_have_attribute('data-duel-concept', first_key)
        ordered = rows.evaluate_all('(es)=>es.map(e=>e.dataset.duelConcept)')
        assert set(ordered[-2:]) == {'pair:7:positive', 'pair:7:negative'}, 'Missing shares must remain last in both directions'
    page.reload(wait_until='networkidle')
    expect(sort_header(page, 'duel', 'first')).to_have_attribute('aria-sort', 'ascending')
    expect(rows.first).to_have_attribute('data-duel-concept', 'pair:3:negative')
    page.locator('[data-duel-sort="first"]').click()
    expect(sort_header(page, 'duel', 'first')).to_have_attribute('aria-sort', 'none')
    assert rows.evaluate_all('(es)=>es.map(e=>e.dataset.duelConcept)') == source_order
    for direction in ('ascending', 'descending', 'none'):
        page.locator('[data-duel-sort="name"]').click()
        expect(sort_header(page, 'duel', 'name')).to_have_attribute('aria-sort', direction)
        if direction != 'none':
            expect(rows.first).to_have_attribute('data-duel-concept', re.compile('pair:3:' if direction == 'ascending' else 'pair:7:'))
    assert rows.evaluate_all('(es)=>es.map(e=>e.dataset.duelConcept)') == source_order
    for key in ('second', 'gap'):
        for direction in ('descending', 'ascending', 'none'):
            page.locator(f'[data-duel-sort="{key}"]').click()
            expect(sort_header(page, 'duel', key)).to_have_attribute('aria-sort', direction)
        assert rows.evaluate_all('(es)=>es.map(e=>e.dataset.duelConcept)') == source_order
    expect(page.locator('.duel-population-note')).to_contain_text('more strongly')
    page.locator('[data-duel-scope]').select_option('headToHead')
    values('pair:3:positive', '100.0%', '0.0%', '1 / 1', '0 / 1')
    page.locator('[data-duel-battles]').click()
    drawer = page.locator('.battle-evidence-drawer')
    expect(drawer).to_contain_text('A-END-00')
    expect(drawer).to_contain_text('B-END-00')
    expect(drawer.locator('[data-duel-battle-page="next"]')).to_be_disabled()
    page.keyboard.press('Escape')
    page.locator('[data-duel-second]').select_option('synthetic/model-02')
    expect(page.locator('.duel-battles')).to_contain_text('No direct battles')
    expect(page.locator('[data-duel-battles]')).to_have_count(0)
    values('pair:3:positive', '—', '—', '0 / 0', '0 / 0')
    page.locator('[data-duel-scope]').select_option('all')
    values('pair:3:positive', '100.0%', '100.0%', '2 / 2', '2 / 2')
    # The same selected model now owns B, proving direct evidence is not fixed to A.
    page.locator('[data-duel-second]').select_option('synthetic/model-51')
    page.locator('[data-duel-scope]').select_option('headToHead')
    page.reload(wait_until='networkidle')
    expect(page.locator('[data-duel-first]')).to_have_value('synthetic/model-00')
    expect(page.locator('[data-duel-second]')).to_have_value('synthetic/model-51')
    expect(page.locator('[data-duel-scope]')).to_have_value('headToHead')
    expect(page.locator('[data-duel-source]')).to_have_value('pair')
    page.locator('[data-duel-battles]').click()
    expect(drawer.locator('.owner-a')).to_contain_text('synthetic/model-51')
    expect(drawer.locator('.owner-b')).to_contain_text('synthetic/model-00')
    expect(drawer).to_contain_text('A-END-51')
    expect(drawer).to_contain_text('B-END-51')
    page.keyboard.press('Escape')
    for width, height in [(1440, 900), (1024, 600)]:
        page.set_viewport_size(dict(width=width, height=height))
        page.locator('#app').evaluate('e=>e.scrollTop=0')
        assert page.locator('#app').evaluate('e=>e.scrollWidth<=e.clientWidth'), 'Model comparison horizontally overflows'
        page.screenshot(path=f'/tmp/models-two-model-{name}-{width}.png')
    print(f'{name}: two-model source populations, cohort scopes, no direct battles, exact ownership and URL persistence passed.')


if __name__ == '__main__':
    with TemporaryDirectory(prefix='prefscope-difference-') as temp, sync_playwright() as playwright:
        fixtures = {'difference': fixture(), 'reversed': fixture(orientation='b_minus_a'), 'mixed': fixture(mixed=True)}
        fixtures['no-map'] = fixture()
        fixtures['no-map']['tables'] = {}
        scored = fixture()
        scored['row_metadata']['winner'] = ['a' if row % 2 == 0 else 'b' for row in range(COUNT)]
        scored['row_metadata']['preference_probability'] = [1 if row % 2 == 0 else 0 for row in range(COUNT)]
        scored['row_metadata']['winner'][0] = 'tie'
        scored['row_metadata']['preference_probability'][0] = 0.5
        export(Path(temp) / 'scored', scored)
        missing = json.loads(json.dumps(scored))
        for field in ('winner', 'preference_probability'):
            missing['row_metadata'][field][50:] = [None, None]
        export(Path(temp) / 'missing-sort', missing)
        compared = fixture(mixed=True)
        for view in compared['prompt']['views'].values():
            view['values'] = [[row + 1 if row % 2 == 0 else -row - 1, 0] for row in range(COUNT)]
        export(Path(temp) / 'compared', compared)
        for name, data in fixtures.items():
            export(Path(temp) / name, data)
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=temp))
        Thread(target=server.serve_forever, daemon=True).start()
        browser = playwright.chromium.launch()
        try:
            for name, data in fixtures.items():
                smoke(browser, f'http://127.0.0.1:{server.server_port}', name, data)
            page = browser.new_page(viewport=dict(width=1440, height=900))
            comparison_errors = []
            page.on('pageerror', lambda error: comparison_errors.append(str(error)))
            models(page, f'http://127.0.0.1:{server.server_port}', 'scored', scored, scored=True)
            missing_sort(page, f'http://127.0.0.1:{server.server_port}')
            compare_models(page, f'http://127.0.0.1:{server.server_port}', 'compared')
            compare_models(page, f'http://127.0.0.1:{server.server_port}', 'difference', mixed=False)
            assert not comparison_errors, comparison_errors
            page.close()
            print('Scored52-model ranking, ties, probabilities, relative concepts and opponent evidence passed.')
        finally:
            browser.close()
            server.shutdown()
