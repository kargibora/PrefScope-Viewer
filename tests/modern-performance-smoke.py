#!/usr/bin/env python3
"""Long-text correctness and repeatable browser timings against the current production dist.

Run after npm run build:bundle. All generated data stays in a temporary export.
PERFORMANCE_VIEWER_DATA optionally adds a real export benchmark; elapsed medians are
reported, never asserted against a machine-dependent performance threshold.
"""
from functools import partial
from hashlib import sha256
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from statistics import median
from tempfile import TemporaryDirectory
from threading import Thread
from time import perf_counter
import json
import os
import re
import shutil
import subprocess
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
LINE_TEXT = ('  \nA long source answer line with spaces and punctuation.\n' * 80
             + ('Literal <tag> & "quoted" text; Unicode café 😊.\n\n' * 2600)
             + '\nANSWER-LINES-TAIL\n  ')
PARAGRAPH_TEXT = ('  A long paragraph with spaces and punctuation. ' * 80
                  + 'Literal <tag> & "quoted" text; Unicode café 😊. ' * 2800
                  + ' ANSWER-PARAGRAPH-TAIL  ')
PROMPT_TEXT = 'A long source prompt.\n' * 6000 + '\nPROMPT-TAIL'
assert min(map(len, (LINE_TEXT, PARAGRAPH_TEXT, PROMPT_TEXT))) > 100_000


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def fixture(name):
    return json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        f"import {{ {name} }} from './tests/modern-fixture.mjs'; console.log(JSON.stringify({name}()));"], cwd=ROOT))


def export(folder, data):
    shutil.copytree(DIST, folder)
    (folder / 'data').mkdir()
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


def settled(page):
    page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')


def sample(page, operation):
    start = perf_counter()
    operation()
    settled(page)
    return (perf_counter() - start) * 1000


def exact_text(page, selector, expected, copy=False):
    target = page.locator(selector)
    assert target.text_content() == expected, f'{selector}: source text changed or missing'
    assert target.locator('.text-chunk').count() > 0, f'{selector}: long text was not chunked'
    if copy:
        target.evaluate('e=>{const range=document.createRange();range.selectNodeContents(e);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)}')
        page.keyboard.press('ControlOrMeta+C')
        assert page.evaluate('navigator.clipboard.readText()') == expected, f'{selector}: native copy changed source text'
        page.evaluate('getSelection().removeAllRanges()')


def source_answer(page, text):
    page.locator('.response-card [data-drawer^="source:"]').click()
    exact_text(page, '#overlay-root .source-text >> nth=1', text, copy=True)
    page.keyboard.press('Escape')
    expect(page.locator('#overlay-root .drawer')).to_have_count(0)


def scrollable(page, selector):
    target = page.locator(selector)
    target.scroll_into_view_if_needed()
    assert target.evaluate('e=>e.scrollHeight>e.clientHeight && getComputedStyle(e).overflowY==="auto"')
    assert target.evaluate('e=>e.clientHeight<=innerHeight*.7')
    target.focus()
    page.keyboard.press('PageDown')
    page.wait_for_function('e=>e.scrollTop>0', arg=target.element_handle())
    target.evaluate('e=>e.scrollTop=0')


def benchmark(page, label):
    times = [sample(page, lambda direction=direction: page.click(f'[data-page="answer:{direction}"]'))
             for direction in ('next', 'prev') * 4]
    page.click('#answer-model-trigger')
    search = page.locator('#answer-model-search')
    query_times = [sample(page, lambda query=query: search.fill(query))
                   for query in ('model-1', '', 'model-0', '', 'model-2', '')]
    page.keyboard.press('Escape')
    print(f'{label}: answer navigation median {median(times):.1f} ms; model search median {median(query_times):.1f} ms')


assert (DIST / 'index.html').is_file(), 'Run npm run build:bundle first.'
with TemporaryDirectory(prefix='prefscope-performance-') as temporary:
    folder = Path(temporary)
    generic = fixture('genericFixture')
    generic['row_ids'] = [f'performance-{i:04d}' for i in range(600)]
    generic['views']['response']['values'] = [[1, i % 3] for i in range(600)]
    generic['row_metadata'] = {
        'model': [f'performance/model-{i % 20:02d}' for i in range(600)],
        'response': [LINE_TEXT, PARAGRAPH_TEXT] + [f'Short source answer {i}.' for i in range(2, 600)],
    }
    export(folder / 'large', generic)
    paired = fixture('pairedFixture')
    paired['row_metadata'].update(prompt=[PROMPT_TEXT] * 3, response_a=[LINE_TEXT] * 3,
                                  response_b=[PARAGRAPH_TEXT] * 3, model_a=['performance/one'] * 3,
                                  model_b=['performance/two'] * 3)
    paired['prompt']['catalog'] = dict(feature_space=paired['prompt']['feature_space'],
        provenance={'feature_space_status': 'unbound'}, column_sources={},
        table=dict(index=[12, 6], index_names=[None], column_names=[None],
                   columns=['feature_id', 'name', 'description'],
                   data=[[i, f'Synthetic prompt concept {i}', 'Long concept evidence. ' * 100] for i in (12, 6)]))
    export(folder / 'paired', paired)
    real = os.environ.get('PERFORMANCE_VIEWER_DATA')
    if real:
        export(folder / 'real', json.loads(Path(real).read_text()))
    ThreadingHTTPServer.request_queue_size = 128
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(folder)))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            context = browser.new_context(viewport={'width': 1440, 'height': 900}, permissions=['clipboard-read', 'clipboard-write'])
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            start = perf_counter()
            page.goto(base + '/large/index.html#answers', wait_until='networkidle')
            expect(page.locator('body')).to_have_attribute('data-engine-source', 'shared')
            print(f'Synthetic 600 rows / 20 models: ready in {(perf_counter()-start)*1000:.1f} ms')
            expect(page.locator('.context-count')).to_have_text('600 matching answers')
            expect(page.locator('[data-reading-mode], .response-preference')).to_have_count(0)
            source_answer(page, LINE_TEXT)
            scrollable(page, '.answer-route .response-card .owner-text')
            page.click('[data-page="answer:next"]')
            source_answer(page, PARAGRAPH_TEXT)
            page.click('[data-page="answer:prev"]')
            benchmark(page, 'Synthetic long answers')
            page.click('#answer-model-trigger')
            assert page.locator('[data-answer-scope^="model:"]').count() == 20
            page.keyboard.press('Escape')

            page.goto(base + '/paired/index.html#prompts', wait_until='networkidle')
            expect(page.locator('.prompt-route .concept-explanation')).not_to_have_attribute('open', '')
            print('Desktop response y:', page.locator('.response-pair').bounding_box()['y'])
            assert page.locator('.response-pair').bounding_box()['y'] < 700
            scrollable(page, '.prompt-evidence .prompt-text')
            assert page.locator('.prompt-evidence .concept-disclosure').get_attribute('open') is None
            heading = page.locator('.responses-heading')
            before = heading.bounding_box()['y']
            page.locator('.prompt-context-rail').evaluate('e=>e.style.minHeight="1800px"')
            assert heading.bounding_box()['y'] == before, 'Tall activation rail must not push responses down'
            page.locator('.prompt-context-rail').evaluate('e=>e.style.minHeight=""')
            page.set_viewport_size({'width':1024, 'height':600})
            page.locator('#app').evaluate('e=>e.scrollTop=0')
            print('Laptop response y:', page.locator('.response-pair').bounding_box()['y'])
            assert page.locator('.response-pair').bounding_box()['y'] < 520, 'Responses should be visible on a short laptop screen'
            assert page.locator('.response-pair').bounding_box()['y'] < page.locator('.prompt-context-rail').bounding_box()['y']
            page.locator('.concept-explanation summary').click()
            expect(page.locator('.concept-explanation p')).to_be_visible()
            page.locator('.concept-explanation summary').click()
            assert page.locator('#app').evaluate('e=>e.scrollWidth<=e.clientWidth')
            page.set_viewport_size({'width':1440, 'height':900})

            for side, text in [('a', LINE_TEXT), ('b', PARAGRAPH_TEXT)]:
                selector = f'.response-card.owner-{side} .answer-preview'
                preview = page.locator(selector)
                expect(preview).to_have_class(re.compile(r'collapsed'))
                expect(preview).to_contain_text('ANSWER-LINES-TAIL' if side == 'a' else 'ANSWER-PARAGRAPH-TAIL')
                page.locator(f'.response-card.owner-{side} [data-expand-answer]').click()
                expect(preview).to_have_class(re.compile(r'expanded'))
                scrollable(page, selector)
                page.locator(f'.response-card.owner-{side} [data-drawer^="source:"]').click()
                exact_text(page, '#overlay-root .source-text >> nth=1', text, copy=True)
                page.keyboard.press('Escape')
                expect(page.locator('#overlay-root .drawer')).to_have_count(0)
                page.locator(f'.response-card.owner-{side} [data-expand-answer]').click()
                expect(preview).to_have_class(re.compile(r'collapsed'))
            page.click('.workspace-nav [data-nav="answers"]')
            page.click('[data-reader-prompt] summary')
            expect(page.locator('.rail-prompt .owner-text')).to_contain_text('PROMPT-TAIL')
            page.locator('.response-card [data-drawer^="source:"]').click()
            exact_text(page, '#overlay-root .source-text >> nth=0', PROMPT_TEXT, copy=True)
            page.keyboard.press('Escape')
            expect(page.locator('#overlay-root .drawer')).to_have_count(0)
            scrollable(page, '.rail-prompt[open] .owner-text')
            page.set_viewport_size({'width': 1024, 'height': 600})
            scrollable(page, '.answer-route .response-card .owner-text')
            scrollable(page, '.rail-prompt[open] .owner-text')
            page.set_viewport_size({'width': 1440, 'height': 900})
            page.click('.workspace-nav [data-nav="models"]')
            page.locator('.model-workspaces [data-model-mode="profile"]').click()
            page.locator('[data-profile-model]').select_option('performance/one')
            page.locator('[data-profile-source]').select_option('answer')
            for side, text, tail in [('a', LINE_TEXT, 'ANSWER-LINES-TAIL'), ('b', PARAGRAPH_TEXT, 'ANSWER-PARAGRAPH-TAIL')]:
                page.locator('[data-profile-evidence="answer:3"]').click()
                drawer = page.locator('.profile-evidence-drawer')
                expect(drawer).to_be_visible()
                expect(drawer.locator(f'.owner-{side} .owner-text')).to_contain_text(tail)
                expect(drawer.locator('.evidence-prompt')).not_to_have_attribute('open', '')
                drawer.locator('.evidence-prompt > summary').click()
                expect(drawer.locator('.evidence-prompt .owner-text')).to_contain_text('PROMPT-TAIL')
                drawer.locator(f'.owner-{side} [data-drawer^="source:"]').click()
                exact_text(page, '#overlay-root .source-text >> nth=0', PROMPT_TEXT, copy=True)
                exact_text(page, '#overlay-root .source-text >> nth=1', text, copy=True)
                page.keyboard.press('Escape')
                expect(page.locator('#overlay-root .drawer')).to_have_count(0)
            if real:
                start = perf_counter()
                page.goto(base + '/real/index.html#answers', wait_until='networkidle')
                expect(page.locator('body')).to_have_attribute('data-engine-source', 'shared')
                print(f'Real export: ready in {(perf_counter()-start)*1000:.1f} ms')
                if page.locator('[data-page="answer:next"]').is_enabled():
                    benchmark(page, 'Real export')
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        thread.join()
print('Long source text, native copy, preview expansion, model evidence/source drawers, and 20-model browser benchmark passed.')
