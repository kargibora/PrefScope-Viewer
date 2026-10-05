#!/usr/bin/env python3
"""Smoke-test the built standalone viewer, including a nested static export and rejected artifacts.

Run after npm run build with Playwright installed. APPROVED_VIEWER_DATA optionally
points to a real v2 export; the known local review export is used when present. Synthetic
v1/v2 fixtures always run, and no dataset is copied into the repository or build output.
"""
from functools import partial
from hashlib import sha256
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import json
import os
import re
import shutil
import subprocess
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
APPROVED = Path(os.environ.get('APPROVED_VIEWER_DATA', str(
    ROOT.parent / 'PrefScope-reporting-public/local-data/viewer-recovery/presentation-modern-redesign/design-v2/app/data/viewer-data.json'
)))
ROUTES = ('prompts', 'answers', 'map', 'models', 'dataset')


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def manifest(folder, data):
    build = json.loads((folder / 'viewer-build.json').read_text())
    files = [dict(path=path.relative_to(folder).as_posix(), size_bytes=path.stat().st_size,
                  sha256=sha256(path.read_bytes()).hexdigest())
             for path in sorted(folder.rglob('*')) if path.is_file() and path.name != 'viewer-bundle.json']
    build_hash = next(item['sha256'] for item in files if item['path'] == 'viewer-build.json')
    return dict(schema='prefscope.viewer_bundle', schema_version=1,
                producer=dict(package='prefscope', version='0.3.1'),
                viewer=dict(package=build['package'], version=build['version'], build_sha256=build_hash,
                            build=dict(path='viewer-build.json', schema=build['schema'], schema_version=build['schema_version'],
                                       supported_data_schemas=build['supported_data_schemas'])),
                data=dict(path='data/viewer-data.json', schema=data['schema'], schema_version=data['schema_version']), files=files)


def export(folder, data_bytes):
    shutil.copytree(DIST, folder)
    (folder / 'data').mkdir()
    (folder / 'data/viewer-data.json').write_bytes(data_bytes)
    (folder / 'viewer-bundle.json').write_text(json.dumps(manifest(folder, json.loads(data_bytes))))


def synthetic(name):
    return subprocess.check_output(['node', '--input-type=module', '-e',
        f"import {{ {name} }} from './tests/modern-fixture.mjs'; process.stdout.write(JSON.stringify({name}()));"], cwd=ROOT)


def state(page):
    return page.evaluate("history.state?.values ?? JSON.parse(new URLSearchParams(location.hash.split('?')[1] || '').get('s') || '{}')")


def short_link_checks(browser, url):
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.goto(url + '#prompts', wait_until='networkidle')
    page.locator('.browse-all[data-overlay="query"]').click()
    page.locator('[data-select-concept="prompt:12:positive"]').click()
    page.locator('[data-reader-sort="prompt"]').select_option('strongest')
    selected = state(page)
    prompt_text = page.locator('.prompt-evidence .owner-text').inner_text()
    link = page.url
    assert len(link) - len(url) < 190, link
    compact = json.loads(page.evaluate("new URLSearchParams(location.hash.split('?')[1]).get('s')"))
    assert compact['promptKeys'] == ['prompt:12:positive']
    assert compact['promptRow'] >= 0 and compact['promptSort'] == 'strongest'
    assert 'answerKeys' not in compact and 'promptCursor' not in compact and 'overlay' not in compact
    assert page.evaluate('history.state.values.promptCursor') == selected['promptCursor']

    shared = browser.new_page()
    shared.goto(link, wait_until='networkidle')
    assert state(shared)['promptKeys'] == selected['promptKeys']
    assert state(shared)['promptRow'] == compact['promptRow']
    assert shared.locator('.prompt-evidence .owner-text').inner_text() == prompt_text
    expect(shared.locator('[data-reader-sort="prompt"]')).to_have_value('strongest')
    shared.close()

    from urllib.parse import quote
    scope = page.evaluate("new URLSearchParams(location.hash.split('?')[1]).get('d')")
    legacy = url + '#prompts?d=' + scope + '&s=' + quote(json.dumps({**selected, 'promptSort': 'weakest'}, separators=(',', ':')))
    shared = browser.new_page()
    shared.goto(legacy, wait_until='networkidle')
    assert state(shared)['promptKeys'] == selected['promptKeys']
    assert state(shared)['promptCursor'] == selected['promptCursor']
    expect(shared.locator('[data-reader-sort="prompt"]')).to_have_value('weakest')
    shared.close()

    shared = browser.new_page()
    shared.goto(url + '#prompts', wait_until='networkidle')
    default_tag = shared.locator('.reader-eyebrow .mono').inner_text()
    shared.goto(link.replace('d=' + scope, 'd=wrong'), wait_until='networkidle')
    assert shared.locator('.reader-eyebrow .mono').inner_text() == default_tag
    shared.close()

    page.locator('.prompt-evidence [data-drawer^="source:"]').click()
    expect(page.locator('.drawer .record-meta')).to_be_visible()
    drawer_link = page.url
    shared = browser.new_page()
    shared.goto(drawer_link, wait_until='networkidle')
    expect(shared.locator('.drawer .record-meta')).to_be_visible()
    shared.locator('.overlay-head button[data-close-overlay]').click()
    expect(shared.locator('.drawer')).to_have_count(0)
    assert shared.url.startswith(url + '#prompts')
    shared.close()

    page.locator('.drawer [data-focus-concept^="answer:"]').first.click()
    expect(page.locator('.answer-route')).to_be_visible()
    answer_key = state(page)['answerKeys'][0]
    page.go_back(wait_until='networkidle')
    expect(page.locator('.drawer .record-meta')).to_be_visible()
    page.go_forward(wait_until='networkidle')
    expect(page.locator('.answer-route')).to_be_visible()
    assert state(page)['answerKeys'][0] == answer_key
    page.go_back(wait_until='networkidle')
    expect(page.locator('.drawer .record-meta')).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.locator('.drawer')).to_have_count(0)
    assert state(page)['promptCursor'] == selected['promptCursor']
    expect(page.locator('[data-reader-sort="prompt"]')).to_have_value('strongest')
    page.close()


def navigate(page, route, selected=None):
    page.locator(f'.workspace-nav [data-nav="{route}"]').click()
    expect(page.locator(f'.workspace-nav [data-nav="{selected or route}"]')).to_have_attribute('aria-current', 'page')
    page.wait_for_timeout(80)
    assert 'Could not load dataset.' not in page.locator('#app').inner_text()
    assert page.locator('#app').evaluate('e=>e.scrollWidth<=e.clientWidth')


def rejection(browser, url, message):
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.goto(url, wait_until='networkidle')
    expect(page.locator('.route-state')).to_contain_text('Could not load dataset.')
    assert page.locator('body').get_attribute('data-engine-source') != 'shared'
    if message:
        expect(page.locator('.route-state')).to_contain_text(message)
    assert page.locator('.prompt-route,.answer-route,.map-route').count() == 0
    page.close()


def dataset_checks(page, rich=False):
    def fits():
        assert page.locator('#app').evaluate('e=>e.scrollWidth<=e.clientWidth')
        assert page.locator('.dataset-route').evaluate('e=>e.scrollWidth<=e.clientWidth')

    def no_hashes(selector):
        assert not re.search(r'sha256:|\b[a-f0-9]{64}\b', page.locator(selector).inner_text(), re.I)

    page.click('[data-dataset-mode="overview"]')
    assert page.locator('.dataset-metric').count() == 4
    assert page.locator('.dataset-coverage').count() == 2
    assert page.locator('.dataset-model-row').count() >= 2
    no_hashes('#dataset-body')
    page.set_viewport_size({'width': 1024, 'height': 700})
    fits()
    page.click('[data-dataset-mode="concepts"]')
    fits()
    search = page.locator('[data-dataset-query]')
    query = page.locator('.dataset-table-row [data-measurement]').first.inner_text()[:3]
    search.focus()
    for char in query:
        page.keyboard.type(char)
        assert page.evaluate("document.activeElement.matches('[data-dataset-query]')")
    expect(search).to_have_value(query)
    assert page.evaluate('document.activeElement.selectionStart') == len(query)
    assert page.locator('.dataset-table-row').count() > 0
    search.fill('')
    if rich:
        assert page.locator('.dataset-table-row').count() == 25
        first = page.locator('.dataset-table-row [data-measurement]').first.get_attribute('data-measurement')
        page.click('[data-dataset-page="next"]')
        assert page.locator('.dataset-table-row [data-measurement]').first.get_attribute('data-measurement') != first
        expect(page.locator('.grid-footer')).to_contain_text('26–50')
        page.click('[data-dataset-page="prev"]')
        assert page.locator('.dataset-table-row [data-measurement]').first.get_attribute('data-measurement') == first
    trigger = page.locator('.dataset-table-row [data-measurement]').first
    key = trigger.get_attribute('data-measurement')
    trigger.click()
    expect(page.locator('.dataset-measurement')).to_be_visible()
    no_hashes('.drawer')
    page.locator('.drawer [data-focus-concept]').click()
    source = 'answer' if key.startswith('answer:') else 'prompt'
    assert state(page)[source + 'Keys'][0] == key
    assert page.locator('.' + source + '-route').count() == 1
    page.set_viewport_size({'width': 1440, 'height': 900})
    navigate(page, 'dataset')
    expect(page.locator('[aria-label="Dataset sections"] button')).to_have_text(['Summary', 'Concepts'])
    expect(page.locator('[data-dataset-mode="checks"], [data-check]')).to_have_count(0)
    # Saved links to the removed notes page open the useful concept catalog.
    from urllib.parse import quote
    scope = page.evaluate('history.state.scope')
    previous = quote(json.dumps({'datasetMode': 'checks'}))
    page.goto(page.url.split('#')[0] + f'#dataset?d={scope}&s={previous}', wait_until='networkidle')
    expect(page.locator('[data-dataset-mode="concepts"]')).to_have_attribute('aria-current', 'page')
    expect(page.locator('.dataset-table-row')).not_to_have_count(0)
    no_hashes('#dataset-body')


def legacy_models(page, mode='distributions'):
    """Old saved analysis links remain supported alongside the unified Models UI."""
    from urllib.parse import quote
    expect(page.locator('body')).to_have_attribute('data-engine-source', 'shared')
    if not page.evaluate('history.state?.scope'):
        page.locator('[data-model-mode="profile"]').click()
    scope = page.evaluate('history.state.scope')
    values = quote(json.dumps({'modelMode': mode}, separators=(',', ':')))
    page.goto(page.url.split('#')[0] + f'#models?d={scope}&s={values}', wait_until='networkidle')


def models_checks(page):
    def type_keeps_focus(selector, text):
        page.locator(selector).focus()
        for char in text:
            page.keyboard.type(char, delay=40)
            assert page.evaluate('(selector)=>document.activeElement.matches(selector)', selector), selector
        expect(page.locator(selector)).to_have_value(text)

    def close_evidence():
        page.keyboard.press('Escape')
        expect(page.locator('.model-evidence-drawer')).to_have_count(0)

    def number(text):
        return float(text.replace('−', '-').replace('%', '').replace(' pp', ''))

    positive = page.locator('.plot-point.positive').count()
    negative = page.locator('.plot-point.negative').count()
    assert positive > 0 and negative > 0
    assert page.locator('.plot-point.positive').first.evaluate('e=>getComputedStyle(e).fill') != page.locator('.plot-point.negative').first.evaluate('e=>getComputedStyle(e).fill')
    for direction, count in [('positive', positive), ('negative', negative)]:
        page.click(f'[data-preference-direction="{direction}"]')
        assert page.locator('.plot-point').count() == count
        assert page.locator(f'.plot-point:not(.{direction})').count() == 0
    page.click('[data-preference-direction="all"]')
    name = page.locator('.plot-point title').first.text_content().split(' · ')[0]
    type_keeps_focus('[data-model-search]', name)
    assert page.locator('.plot-point').count() == 1
    assert page.locator('#preference-plot svg').evaluate("e=>!/(NaN|Infinity)/.test(e.outerHTML)")
    assert page.locator('.plot-point').evaluate("e=>['cx','cy','r'].every(a=>Number.isFinite(Number(e.getAttribute(a))))")
    point = page.locator('.plot-point')
    point.focus()
    page.keyboard.press('Enter')
    expect(page.locator('.preference-tooltip')).to_be_visible()
    page.locator('.preference-tooltip [data-model-row]').click()
    expect(page.locator('.model-evidence-drawer')).to_be_visible()
    for group, label in [('higher', 'Higher activation than opponent'), ('lower', 'Lower activation than opponent')]:
        page.click(f'[data-evidence-group="{group}"]')
        expect(page.locator('.evidence-example-meta')).to_contain_text(label)
    page.click('[data-evidence-group="all"]')
    first = state(page)['modelEvidenceCursor']
    page.click('[data-evidence-page="next"]')
    assert state(page)['modelEvidenceCursor'] != first
    page.click('[data-evidence-page="prev"]')
    assert state(page)['modelEvidenceCursor'] == first
    type_keeps_focus('[data-evidence-search]', page.locator('.overlay-footer code').inner_text()[:4])
    page.locator('[data-evidence-search]').fill('')
    page.click('[data-evidence-side="b"]')
    assert state(page)['modelSide'] == 'b'
    expect(page.locator('.evidence-source')).to_contain_text('z_b')
    before = state(page)['modelEvidenceCursor']
    page.reload(wait_until='networkidle')
    expect(page.locator('.model-evidence-drawer')).to_be_visible()
    assert state(page)['modelEvidenceCursor'] == before
    close_evidence()
    page.locator('[data-model-search]').fill('')
    page.click('[data-model-mode="compare"]')
    page.click('[data-compare-metric="answer"]')
    page.click('[data-compare-sort="name"]')
    names = page.locator('.comparison-identity h2').all_text_contents()
    headers = page.locator('.matrix-head').inner_text()
    assert all(name in headers for name in names) and 'First model' not in headers and 'Second model' not in headers
    row = page.locator('.matrix-row').first
    key = row.get_attribute('data-model-row')
    before = [number(text) for text in row.locator('.comparison-value b,.comparison-gap>b').all_text_contents()]
    page.click('[data-swap]')
    row = page.locator(f'.matrix-row[data-model-row="{key}"]')
    after = [number(text) for text in row.locator('.comparison-value b,.comparison-gap>b').all_text_contents()]
    assert after == [before[1], before[0], -before[2]], (before, after)
    assert page.locator('.comparison-identity h2').all_text_contents() == names[::-1]
    page.set_viewport_size({'width': 1024, 'height': 700})
    assert page.locator('#app').evaluate('e=>e.scrollWidth<=e.clientWidth')
    row.click()
    expect(page.locator('[data-evidence-side="b"]')).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('.evidence-example-meta')).to_contain_text('Active answer concept')
    expect(page.locator('.evidence-activation summary')).to_contain_text('Concept strength')
    page.set_viewport_size({'width': 1024, 'height': 600})
    page.wait_for_timeout(100)
    answer = page.locator('.evidence-answer-text').first.bounding_box()
    footer = page.locator('.model-evidence-drawer .overlay-footer').bounding_box()
    assert answer['y'] + 46 < footer['y'], 'First answer line must fit above the footer'
    page.set_viewport_size({'width': 1024, 'height': 700})
    assert page.locator('.model-evidence-drawer').evaluate('e=>e.scrollWidth<=e.clientWidth')
    close_evidence()
    page.click('[data-compare-metric="prompt"]')
    page.locator('.matrix-row').first.click()
    expect(page.locator('.evidence-example-meta')).to_contain_text('Active prompt concept')
    expect(page.locator('.evidence-activation summary')).to_contain_text('Prompt concept strength')
    expect(page.locator('.evidence-prompt-source')).to_contain_text('z_prompt')
    close_evidence()
    page.set_viewport_size({'width': 1440, 'height': 900})


def inspect(browser, url, rich=False, has_prompt=True):
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors, failed = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('response', lambda response: failed.append((response.status, response.url))
            if response.status >= 400 and response.url.startswith(url.split('/nested/')[0]) else None)
    page.goto(url, wait_until='networkidle')
    expect(page.locator('body')).to_have_attribute('data-engine-source', 'shared')
    for route in ROUTES:
        navigate(page, route, "answers" if route == "prompts" and not has_prompt else route)
        if route in ('prompts', 'answers'):
            source = 'prompt' if route == 'prompts' and has_prompt else 'answer'
            sort = page.locator(f'[data-reader-sort="{source}"]')
            sort.select_option('strongest')
            expect(sort).to_have_value('strongest')
            assert state(page)[f'{source}Sort'] == 'strongest'
            cursor = state(page)[f'{source}Cursor']
            page.reload(wait_until='networkidle')
            expect(page.locator(f'[data-reader-sort="{source}"]')).to_have_value('strongest')
            assert state(page)[f'{source}Cursor'] == cursor
            page.locator(f'[data-reader-sort="{source}"]').select_option('weakest')
            expect(page.locator(f'[data-reader-sort="{source}"]')).to_have_value('weakest')
            page.locator(f'[data-reader-sort="{source}"]').select_option('dataset')
            original_count = page.locator('.context-count').inner_text()
            bar = page.locator('.hist-choice[aria-disabled="false"]').first
            count = int(re.search(r'· (\d+)', bar.get_attribute('aria-label')).group(1))
            bar.focus()
            page.keyboard.press('Enter')
            expect(page.locator('.context-count')).to_have_text(f'{count} matching {source}s')
            expect(page.locator('.hist-choice[aria-pressed="true"]')).to_have_count(1)
            selection = state(page)[f'{source}Activation']
            page.reload(wait_until='networkidle')
            assert state(page)[f'{source}Activation'] == selection
            expect(page.locator('.context-count')).to_have_text(f'{count} matching {source}s')
            page.locator('#context-strip [data-clear-activation]').click()
            expect(page.locator('.context-count')).to_have_text(original_count)
            quartile = page.locator('.quantile-options button:not(:disabled)').last
            count = int(quartile.get_attribute('title').split()[0])
            quartile.click()
            expect(page.locator('.context-count')).to_have_text(f'{count} matching {source}s')
            expect(page.locator('.quantile-options [aria-pressed="true"]')).to_have_count(1)
            page.locator('#context-strip [data-clear-activation]').click()
            expect(page.locator('.context-count')).to_have_text(original_count)

        if rich and route in ('prompts', 'answers'):
            expect(page.locator('.context-count')).to_have_text('362 matching prompts' if route == 'prompts' else '329 matching answers')
            assert page.locator('.distribution-plot .hist-bar').count() == 8
        if rich and route == 'map':
            assert page.locator('#map-canvas').is_visible()
        if rich and route == 'models':
            expect(page.locator('.model-workspaces')).to_be_visible()
            legacy_models(page)
            assert page.locator('.profile-row').count() > 0
            page.click('[data-model-mode="preference"]')
            assert page.locator('.plot-point').count() == 126
            models_checks(page)
        if route == 'dataset':
            dataset_checks(page, rich)
    if rich:
        page.goto(url, wait_until='networkidle')
        navigate(page, 'answers')
        page.click('[data-page="answer:next"]')
        saved = state(page)['answerCursor']
        before = page.url
        page.reload(wait_until='networkidle')
        assert page.url == before and state(page)['answerCursor'] == saved
        page.click('.reader-heading [data-overlay="relationships"]')
        expect(page.locator('.relationships-sheet')).to_be_visible()
        page.locator('[data-rel-check]').first.click()
        page.click('[data-apply-relationships]')
        assert state(page)['relationshipFilter']['checked']
        assert int(page.locator('.context-count').inner_text().split()[0].replace(',', '')) < 329
        # Review-only URL fixtures must not alter a production build, even on localhost.
        page.goto(url + '?rail-fixture=zero-active#answers', wait_until='networkidle')
        expect(page.locator('.population-count')).to_contain_text('329 / 1,500')
    assert not errors, errors
    assert not failed, failed
    page.close()


assert (DIST / 'index.html').is_file(), 'Run npm run build first.'
build = json.loads((DIST / 'viewer-build.json').read_text())
assert build['supported_data_schemas'] == [{'schema': 'prefscope.viewer_data', 'versions': [1, 2]}]
assert not (DIST / 'data').exists() and not (DIST / 'viewer-bundle.json').exists(), 'The standalone build must contain no dataset.'
assert not (DIST / 'dataset').exists(), 'Do not retain a legacy dataset.'
assert list((DIST / 'assets').glob('*.js')) and list((DIST / 'assets').glob('*.css'))
for path in DIST.rglob('*'):
    if path.is_file():
        assert b'evil.invalid' not in path.read_bytes(), path
if 'APPROVED_VIEWER_DATA' in os.environ:
    assert APPROVED.is_file(), f'APPROVED_VIEWER_DATA does not exist: {APPROVED}'

with TemporaryDirectory(prefix='prefscope-modern-smoke-') as temporary:
    root = Path(temporary)
    empty = root / 'nested/empty'
    shutil.copytree(DIST, empty)
    generic, paired = root / 'nested/v1', root / 'nested/v2'
    export(generic, synthetic('genericFixture'))
    export(paired, synthetic('pairedFixture'))
    fixed_data = json.loads(synthetic('pairedFixture'))
    explanation = 'Supplied explanation with <b>literal markup</b> & evidence.'
    fixed_data['catalog'] = dict(feature_space=fixed_data['feature_space'], provenance={}, column_sources={},
        table=dict(columns=['feature_id', 'name', 'description'], index=[0, 1],
                   data=[[3, 'First concept', None], [7, 'Second concept', explanation]]))
    fixed_data['row_metadata']['model_a'] = ['synthetic/one'] * 3
    fixed_data['row_metadata']['model_b'] = ['synthetic/two'] * 3
    fixed = root / 'nested/fixed-pair'
    export(fixed, json.dumps(fixed_data).encode())
    scoreless_data = json.loads(json.dumps(fixed_data))
    scoreless_data['row_metadata'].pop('preference_probability', None)
    scoreless = root / 'nested/fixed-pair-no-scores'
    export(scoreless, json.dumps(scoreless_data).encode())
    single_data = json.loads(synthetic('pairedFixture'))
    single_data['views'].pop('z_b')
    for field in ('model_b', 'response_b', 'preference_probability'):
        single_data['row_metadata'].pop(field)
    single_data['row_metadata']['model_a'] = ['synthetic/one'] * 3
    single_data['row_metadata']['prompt'][1] = single_data['row_metadata']['prompt'][0]
    single = root / 'nested/single-model'
    export(single, json.dumps(single_data).encode())
    b_only_data = json.loads(synthetic('pairedFixture'))
    b_only_data['row_metadata']['model_a'] = ['synthetic/one', 'synthetic/three', 'synthetic/one']
    b_only_data['row_metadata']['model_b'] = ['synthetic/two'] * 3
    b_only_data['row_metadata']['preference_probability'] = [0, 1, 1]
    b_only = root / 'nested/b-only-model'
    export(b_only, json.dumps(b_only_data).encode())
    fixed_data.pop('prompt')
    fixed_data['row_metadata']['preference_probability'] = [0, 1, 1]
    answer_only = root / 'nested/fixed-pair-without-prompt-concepts'
    export(answer_only, json.dumps(fixed_data).encode())
    many_data = json.loads(synthetic('genericFixture'))
    owners = [f'synthetic/model-{i:02d}-with-a-long-release-name' for i in range(1, 21) for _ in range(i)]
    many_data['row_ids'] = [f'model-row-{i}' for i in range(len(owners))]
    many_data['views']['response']['values'] = [[1, i % 2] for i in range(len(owners))]
    many_data['row_metadata'] = {'model': owners, 'response': ['Synthetic answer.'] * len(owners)}
    many = root / 'nested/models-20'
    export(many, json.dumps(many_data).encode())
    approved = root / 'nested/approved'
    if APPROVED.is_file():
        export(approved, APPROVED.read_bytes())
    ThreadingHTTPServer.request_queue_size = 128
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(root)))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            inspect(browser, base + '/nested/v1/index.html', has_prompt=False)
            inspect(browser, base + '/nested/v2/index.html')
            short_link_checks(browser, base + '/nested/v2/index.html')
            single_page = browser.new_page(viewport={'width': 1440, 'height': 600})
            single_page.goto(base + '/nested/single-model/index.html#prompts', wait_until='networkidle')
            expect(single_page.locator('.context-count')).to_have_text('2 matching prompt records')
            expect(single_page.locator('.distribution-plot table.sr-only thead th').last).to_have_text('Prompt records')
            expect(single_page.locator('[data-model-mode="compare"]')).to_have_count(0)
            single_page.locator('[data-reader-sort="prompt"]').select_option('strongest')
            scope = single_page.evaluate('history.state.scope')
            single_page.goto(base + '/nested/single-model/index.html#models', wait_until='networkidle')
            expect(single_page.locator('[data-profile-concept]')).not_to_have_count(0)
            expect(single_page.locator('.solo-profile')).to_be_visible()
            expect(single_page.locator('[data-profile-opponent]')).to_have_count(0)
            expect(single_page.locator('[data-model-mode="preference"], [data-model-mode="compare"]')).to_have_count(0)
            expect(single_page.locator('[data-model-side]')).to_have_count(0)
            from urllib.parse import quote
            invalid_mode = quote(json.dumps({'modelMode': 'preference'}, separators=(',', ':')))
            single_page.goto(base + f'/nested/single-model/index.html#models?d={scope}&s={invalid_mode}', wait_until='networkidle')
            expect(single_page.locator('.profile-row')).not_to_have_count(0)
            assert state(single_page)['modelMode'] == 'distributions'
            single_page.goto(base + '/nested/single-model/index.html#dataset', wait_until='networkidle')
            expect(single_page.locator('.dataset-metric').first).to_contain_text('2')
            expect(single_page.locator('.dataset-metric').first).to_contain_text('distinct prompts')
            expect(single_page.locator('.dataset-coverage.prompt')).to_contain_text('per prompt record')
            single_page.close()
            scoreless_page = browser.new_page()
            scoreless_page.goto(base + '/nested/fixed-pair-no-scores/index.html#models', wait_until='networkidle')
            expect(scoreless_page.locator('[data-model-mode="preference"]')).to_have_count(0)
            scoreless_page.locator('[data-model-mode="duel"]').click()
            expect(scoreless_page.locator('[data-compare-metric="prompt"]')).to_have_count(0)
            expect(scoreless_page.locator('[data-duel-source] option[value="answer"]')).to_have_count(1)
            scoreless_page.close()
            b_only_page = browser.new_page()
            b_only_page.goto(base + '/nested/b-only-model/index.html#models', wait_until='networkidle')
            expect(b_only_page.locator('.model-workspaces')).to_be_visible()
            legacy_models(b_only_page)
            expect(b_only_page.locator('.profile-row')).not_to_have_count(0)
            expect(b_only_page.locator('[data-model-mode="preference"]')).to_have_count(1)
            expect(b_only_page.locator('[data-model-mode="compare"]')).to_have_count(0)
            b_only_page.locator('[data-model-mode="preference"]').click()
            expect(b_only_page.locator('.plot-point')).not_to_have_count(0)
            b_only_page.close()
            if APPROVED.is_file():
                inspect(browser, base + '/nested/approved/index.html', rich=True)
                map_page = browser.new_page()
                map_page.goto(base + '/nested/approved/index.html#map', wait_until='networkidle')
                map_page.locator('.map-panel-tabs [data-map-panel="examples"]').click()
                search = map_page.locator('.map-search')
                expect(search).to_have_attribute('placeholder', 'Search example text…')
                expect(search).to_have_attribute('aria-label', 'Search example text')
                map_page.select_option('[data-map-population-select]', 'all')
                record_id = json.loads(APPROVED.read_bytes())['row_ids'][0]
                search.fill(record_id)
                expect(map_page.locator('#map-status')).to_contain_text('1 matching records')
                map_page.close()
            else:
                print('Optional approved export absent; synthetic v1/v2 coverage still runs.')
            fixed_page = browser.new_page(viewport={'width': 1440, 'height': 900})
            fixed_page.goto(base + '/nested/fixed-pair/index.html#models', wait_until='networkidle')
            legacy_models(fixed_page)
            fixed_page.locator('[data-model-row="answer:7"]').click()
            expect(fixed_page.locator('.model-evidence-drawer')).to_be_visible()
            details = fixed_page.locator('.evidence-intro .concept-explanation')
            assert details.get_attribute('open') is None
            details.locator('summary').focus()
            fixed_page.keyboard.press('Enter')
            expect(details.locator('p')).to_be_visible()
            expect(details.locator('p')).to_have_text(explanation)
            assert details.locator('b').count() == 0
            fixed_page.keyboard.press('Enter')
            assert details.get_attribute('open') is None
            expect(fixed_page.locator('.evidence-score strong')).to_have_text('Not supplied')
            expect(fixed_page.locator('.evidence-source')).to_contain_text('synthetic-2')
            fixed_page.goto(base + '/nested/fixed-pair-without-prompt-concepts/index.html#models', wait_until='networkidle')
            legacy_models(fixed_page)
            fixed_page.click('[data-model-mode="preference"]')
            expect(fixed_page.locator('.plot-point')).to_have_count(2)
            assert fixed_page.locator('.plot-point.positive').count() == 1 and fixed_page.locator('.plot-point.negative').count() == 1
            fixed_page.close()
            page = browser.new_page(viewport={'width': 1024, 'height': 700})
            page.goto(base + '/nested/models-20/index.html#dataset', wait_until='networkidle')
            expect(page.locator('.dataset-model-row')).to_have_count(20)
            counts = dict(zip(page.locator('.dataset-model-name').all_text_contents(),
                              map(int, page.locator('.dataset-model-row>strong').all_text_contents())))
            assert counts == {f'synthetic/model-{i:02d}-with-a-long-release-name': i for i in range(1, 21)}
            expect(page.locator('.dataset-metric').filter(has=page.get_by_role('heading', name='Models', exact=True)).locator('strong')).to_have_text('20')
            listing = page.locator('.dataset-model-list')
            assert listing.evaluate('e=>e.scrollHeight>e.clientHeight&&e.scrollWidth<=e.clientWidth')
            listing.evaluate('e=>e.scrollTop=e.scrollHeight')
            assert listing.evaluate('e=>e.scrollTop>0')
            assert page.locator('#app').evaluate('e=>e.scrollWidth<=e.clientWidth')
            page.close()
            rejection(browser, base + '/nested/empty/index.html', None)
            for relative, message in [('data/viewer-data.json', 'viewer-data.json'), ('viewer-build.json', 'viewer-build.json')]:
                target = paired / relative
                original = target.read_bytes()
                target.write_bytes(original + b' ')
                rejection(browser, base + '/nested/v2/index.html', message)
                target.write_bytes(original)
            # A self-consistent replacement manifest/build must still match the compiled viewer.
            other_build = json.loads((paired / 'viewer-build.json').read_text())
            other_build['version'] = '999.0.0'
            (paired / 'viewer-build.json').write_text(json.dumps(other_build))
            (paired / 'viewer-bundle.json').write_text(json.dumps(manifest(paired, json.loads((paired / 'data/viewer-data.json').read_bytes()))))
            rejection(browser, base + '/nested/v2/index.html', 'executing Viewer version')
            browser.close()
    finally:
        server.shutdown()
        thread.join()
print('Modern production build: nested v1/v2 exports, all routes, state, integrity rejection, and dataset-free output passed.')
