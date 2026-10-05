#!/usr/bin/env python3
"""Unified Models workflows against deterministic, current-schema exports.

Run npm run build:bundle, then:
  uv run --with playwright python tests/modern-models-smoke.py
Fixtures reuse the difference smoke exporter; no runtime or export is modified.
"""
from functools import partial
from http.server import ThreadingHTTPServer
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import json
import subprocess
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
spec = spec_from_file_location('models_fixture_helpers', ROOT / 'tests/modern-difference-smoke.py')
helpers = module_from_spec(spec)
spec.loader.exec_module(helpers)
MODEL = 'synthetic/model-00'


def fixtures():
    result = {}
    for name in ('mixed', 'individual', 'difference', 'missing'):
        data = helpers.fixture(mixed=name != 'difference')
        data['tables'] = {}
        if name in ('individual', 'missing'):
            del data['views']['difference_vectors']
        data['prompt']['views']['z_prompt']['values'] = [[1 if row % 2 == 0 else -1, 0] for row in range(52)]
        if name != 'missing':
            data['row_metadata']['preference_probability'] = [.5] * 52
            data['row_metadata']['preference_probability'][0] = .8
            data['row_metadata']['preference_probability'][51] = .6
        if name == 'individual':
            data['row_metadata']['winner'] = [None] * 52
            data['row_metadata']['winner'][0] = 'a'
            data['row_metadata']['winner'][51] = 'tie'
        result[name] = data
    generic = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        "import {genericFixture} from './tests/modern-fixture.mjs'; console.log(JSON.stringify(genericFixture()));"], cwd=ROOT))
    generic['feature_ids'] = list(range(45))
    generic['views']['response']['values'] = [[int(feature % 2 == row % 2) for feature in range(45)] for row in range(3)]
    result['generic'] = generic
    return result


def open_models(page, base, name):
    page.goto(f'{base}/{name}/index.html#models', wait_until='networkidle')
    expect(page.locator('body')).to_have_attribute('data-engine-source', 'shared')
    expect(page.locator('.model-workspaces')).to_be_visible()
    expect(page.locator('.overview-tabs')).to_have_count(0)
    if name != 'generic':
        expect(page.locator('.model-workspaces [data-battle-tab="performance"]')).to_have_text('Performance')
        expect(page.locator('.model-workspaces [data-battle-tab="concepts"]')).to_have_text('Concept breakdown')
    expect(page.locator('.model-workspaces [data-model-mode="profile"]')).to_be_visible()
    expect(page.locator('.model-workspaces [data-model-mode="duel"]')).to_be_visible()


def profile(page, model=MODEL):
    page.locator('.model-workspaces [data-model-mode="profile"]').click()
    page.locator('[data-profile-model]').select_option(model)
    expect(page.locator('[data-model-view="profile"]')).to_have_attribute('aria-current', 'page')


def row(page, key):
    return page.locator(f'[data-profile-concept="{key}"]')


def metric(record, column, text):
    expect(record.locator('.profile-stat').nth(column).locator('strong')).to_have_text(text)


def evidence(page, key, marker):
    page.locator(f'[data-profile-evidence="{key}"]').click()
    drawer = page.locator('#overlay-root [role="dialog"]')
    expect(drawer).to_be_visible()
    expect(drawer).to_contain_text(marker)
    expect(drawer.locator('[data-reading-mode], .response-preference')).to_have_count(0)
    return drawer


def smoke(page, base, name):
    open_models(page, base, name)
    profile(page)
    expect(page.locator('[data-profile-model] option')).to_have_count(52)
    expect(page.locator('[data-profile-source] option[value="prompt"]')).to_have_count(1)
    expect(page.locator('[data-profile-source] option[value="answer"]')).to_have_count(0 if name == 'difference' else 1)
    expect(page.locator('[data-profile-source] option[value="pair"]')).to_have_count(1 if name in ('mixed', 'difference') else 0)
    page.locator('[data-profile-source]').select_option('prompt')
    prompt_row = row(page, 'prompt:12:positive')
    expect(prompt_row).to_be_visible()
    score = '100.0%' if name == 'individual' else '—' if name == 'missing' else '80.0%'
    uplift = '+25.0 pp' if name == 'individual' else '—' if name == 'missing' else '+20.0 pp'
    metric(prompt_row, 0, '50.0%')
    metric(prompt_row, 1, score)
    metric(prompt_row, 2, uplift)
    expect(prompt_row.locator('.profile-stat').nth(0)).to_contain_text('1 / 2')
    expect(page.locator('.profile-table-head')).to_contain_text('Win score' if name == 'individual' else 'Mean preference')
    drawer = evidence(page, 'prompt:12:positive', 'A-END-00')
    page.keyboard.press('Escape')
    expect(drawer).to_have_count(0)
    source = 'pair' if name == 'difference' else 'answer'
    key = 'pair:3:positive' if source == 'pair' else 'answer:3'
    page.locator('[data-profile-source]').select_option(source)
    answer_row = row(page, key)
    expect(answer_row).to_be_visible()
    metric(answer_row, 0, '100.0%' if source == 'pair' else '50.0%')
    if source == 'pair':
        assert float(answer_row.locator('.profile-stat').nth(1).locator('strong').inner_text()) == 26.5
        metric(answer_row, 2, '—')
    else:
        metric(answer_row, 1, '+0.0 pp')
        metric(answer_row, 2, '+50.0 pp' if name == 'individual' else '—' if name == 'missing' else '+40.0 pp')
    drawer = evidence(page, key, 'A-END-00')
    if source == 'answer':
        drawer.locator('[data-profile-group="less"]').click()
        expect(drawer).to_contain_text('B-END-51')
        expect(drawer.locator('.owner-b')).to_contain_text(MODEL)
        expect(drawer.locator('.battle-example-result')).to_contain_text('Tied' if name == 'individual' else 'Outcome not supplied')
        if name != 'missing':
            expect(drawer.locator('.battle-example-result')).to_contain_text('40.0%')
    page.keyboard.press('Escape')
    expect(drawer).to_have_count(0)
    page.locator('[data-profile-opponent]').select_option('synthetic/model-51')
    page.locator('[data-profile-source]').select_option('prompt')
    drawer = evidence(page, 'prompt:12:negative', 'B-END-51')
    expect(drawer).to_contain_text(MODEL)
    page.keyboard.press('Escape')
    # The overview reuses identical model-owned conditional metrics.
    page.locator('.model-workspaces [data-model-mode="battles"]').click()
    expect(page.locator('[data-model-view="performance"]')).to_have_attribute('aria-current', 'page')
    page.locator('[data-battle-tab="concepts"]').click()
    expect(page.locator('[data-model-view="concepts"]')).to_have_attribute('aria-current', 'page')
    page.locator('[data-battle-source]').select_option('prompt')
    page.locator('[data-battle-concept]').select_option('prompt:12:positive')
    page.locator('[data-battle-metric]').select_option('winTieScore' if name == 'individual' else 'meanPreference')
    expect(page.locator('[data-comparison-model]')).to_have_count(52)
    overview = page.locator(f'[data-comparison-model="{MODEL}"]')
    metric(overview, 0, '50.0%')
    metric(overview, 1, score)
    metric(overview, 2, uplift)
    if name == 'individual':
        unlabelled = page.locator('[data-comparison-model="synthetic/model-02"]')
        metric(unlabelled, 1, '—')
        expect(page.locator('.profile-table-head')).to_contain_text('Win score')
        page.locator('[data-battle-metric]').select_option('meanPreference')
        metric(overview, 1, '80.0%')
        metric(overview, 2, '+20.0 pp')
        metric(unlabelled, 1, '50.0%')
        expect(page.locator('.profile-table-head')).to_contain_text('Mean preference')
        page.locator('[data-battle-metric]').select_option('winTieScore')
        metric(unlabelled, 1, '—')
    page.locator('[data-battle-source]').select_option(source)
    page.locator('[data-battle-concept]').select_option(key)
    metric(overview, 0, '100.0%' if source == 'pair' else '50.0%')
    metric(overview, 2, '—' if source == 'pair' or name == 'missing' else '+50.0 pp' if name == 'individual' else '+40.0 pp')
    page.locator(f'[data-open-profile="{MODEL}"]').click()
    expect(page.locator('[data-profile-model]')).to_have_value(MODEL)
    page.locator('[data-profile-model]').select_option('synthetic/model-50')
    expect(page.locator('[data-profile-model]')).to_have_value('synthetic/model-50')
    page.reload(wait_until='networkidle')
    expect(page.locator('[data-profile-model]')).to_have_value('synthetic/model-50')
    expect(page.locator('[data-model-view="profile"]')).to_have_attribute('aria-current', 'page')
    print(f'{name}: unified navigation, arbitrary model identity, source gating and scoped evidence passed.', flush=True)


def compare_outcomes(page, base):
    open_models(page, base, 'individual')
    page.locator('.model-workspaces [data-model-mode="duel"]').click()
    page.locator('[data-duel-first]').select_option(MODEL)
    page.locator('[data-duel-second]').select_option('synthetic/model-01')
    page.locator('[data-duel-source]').select_option('prompt')
    page.locator('[data-duel-metric]').select_option('outcome')
    prompt = page.locator('[data-duel-concept="prompt:12:positive"]')
    expect(prompt.locator('.duel-first strong')).to_have_text('100.0%')
    expect(prompt.locator('.duel-second strong')).to_have_text('0.0%')
    expect(prompt.locator('.duel-first small')).to_contain_text('1 scored')
    page.locator('[data-duel-source]').select_option('answer')
    page.locator('[data-duel-metric]').select_option('association')
    answer = page.locator('[data-duel-concept="answer:3"]')
    expect(answer.locator('.duel-first strong')).to_have_text('+50.0 pp')
    expect(answer.locator('.duel-second strong')).to_have_text('—')
    expect(answer.locator('.duel-first small')).to_have_text('1 more / 1 less · win score')
    expect(answer.locator('.duel-second small')).to_have_text('0 more / 1 less · win score')
    page.locator('[data-duel-scope]').select_option('headToHead')
    expect(answer.locator('.duel-first strong')).to_have_text('—')
    expect(answer.locator('.duel-second strong')).to_have_text('—')
    for view in ('performance', 'concepts', 'profile', 'duel'):
        page.locator(f'[data-model-view="{view}"]').click()
        expect(page.locator(f'[data-model-view="{view}"]')).to_have_attribute('aria-current', 'page')
        page.reload(wait_until='networkidle')
        expect(page.locator(f'[data-model-view="{view}"]')).to_have_attribute('aria-current', 'page')
        expect(page.locator('.model-workspaces [aria-current="page"]')).to_have_count(1)
    print('comparison: prompt outcomes, More/Less association and unscored/direct-cohort exclusions passed.', flush=True)


def generic_profile(page, base):
    open_models(page, base, 'generic')
    expect(page.locator('.model-workspaces [data-model-mode="profile"]')).to_have_attribute('aria-current', 'page')
    expect(page.locator('[data-profile-source] option')).to_have_count(1)
    expect(page.locator('[data-profile-source]')).to_have_value('answer')
    page.locator('[data-profile-model]').select_option('synthetic/one')
    rows = page.locator('[data-profile-concept]')
    expect(rows).to_have_count(40)
    assert rows.evaluate_all('(es)=>es.map(e=>e.dataset.profileConcept)') == [f'answer:{i}' for i in range(40)]
    metric(row(page, 'answer:0'), 0, '100.0%')
    metric(row(page, 'answer:0'), 1, '+100.0 pp')
    metric(row(page, 'answer:0'), 2, '—')
    page.locator('[data-profile-page="next"]').click()
    expect(rows).to_have_count(5)
    expect(rows.last).to_have_attribute('data-profile-concept', 'answer:44')
    page.locator('[data-profile-sort="share"]').click()
    assert all(int(key.split(':')[1]) % 2 == 0 for key in rows.evaluate_all('(es)=>es.slice(0,23).map(e=>e.dataset.profileConcept)'))
    header = page.locator('[data-profile-sort="share"]').locator('xpath=ancestor::*[@role="columnheader"][1]')
    expect(header).to_have_attribute('aria-sort', 'descending')
    page.locator('[data-profile-sort="share"]').click()
    expect(header).to_have_attribute('aria-sort', 'ascending')
    assert all(int(key.split(':')[1]) % 2 == 1 for key in rows.evaluate_all('(es)=>es.slice(0,22).map(e=>e.dataset.profileConcept)'))
    page.locator('[data-profile-sort="share"]').click()
    expect(header).to_have_attribute('aria-sort', 'none')
    assert rows.evaluate_all('(es)=>es.map(e=>e.dataset.profileConcept)') == [f'answer:{i}' for i in range(40)]
    drawer = evidence(page, 'answer:0', 'Synthetic first answer.')
    expect(drawer.locator('.response-card')).to_have_count(1)
    expect(drawer.locator('.battle-example-result')).to_contain_text('Outcome not supplied')
    page.keyboard.press('Escape')
    for width, height in [(1440, 900), (1024, 600)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.locator('#app').evaluate('e=>e.scrollTop=0')
        page.evaluate('window.scrollTo(0,0)')
        assert page.locator('#app').evaluate('e=>e.scrollWidth<=e.clientWidth')
        page.screenshot(path=f'/tmp/unified-models-generic-{width}.png')
    print('generic: default profile, absent-outcome activity, 40-row pagination, header cycles and exact-owner evidence passed.', flush=True)


if __name__ == '__main__':
    with TemporaryDirectory(prefix='prefscope-models-') as temporary, sync_playwright() as p:
        data = fixtures()
        for name, payload in data.items():
            helpers.export(Path(temporary) / name, payload)
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(helpers.QuietHandler, directory=temporary))
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            base = f'http://127.0.0.1:{server.server_port}'
            for name in ('mixed', 'individual', 'difference', 'missing'):
                smoke(page, base, name)
            compare_outcomes(page, base)
            generic_profile(page, base)
            assert not errors, errors
        finally:
            browser.close()
            server.shutdown()
            thread.join()
