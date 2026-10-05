#!/usr/bin/env python3
"""Reader usability and source-fidelity checks against a running modern Viewer.

Run with `uv run --with playwright python tests/modern-reader-smoke.py`.
READER_VIEWER_URL defaults to http://127.0.0.1:5273/. The selected real export is
checked first; deterministic artifacts then replace only the three data requests.
No export, application source, or build output is modified.
"""
from pathlib import Path
import json
import os
import re
import subprocess
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
URL = os.environ.get('READER_VIEWER_URL', 'http://127.0.0.1:5273/').split('#')[0].rstrip('/') + '/'
PROMPT = 'Explain this example and preserve the source text.\n' * 80 + 'PROMPT-END'
ANSWER = '''  <think>REASONING-MARKER: verify **the calculation** before answering.
The hidden reasoning must be available when expanded.</think>

## Result

The **answer** is given by \\(x^2 + 1\\).

- First item
- Second item

```python
print("<tag> & exact code")
```

<img src=x onerror="window.__readerInjected=1">
[Unsafe link](javascript:window.__readerInjected=2)

Literal café 😊 and trailing spaces.\x20\x20
ANSWER-END  '''
ANSWERS = [ANSWER + f'\nRECORD-{row}\n  ' for row in range(3)]


def fixture():
    script = r'''
import { readFileSync } from 'node:fs';
import { pairedFixture, artifacts, jsonBytes } from './tests/modern-fixture.mjs';
const input = JSON.parse(readFileSync(0, 'utf8')), data = pairedFixture();
data.views.z_a.values = [[1, 1], [2, 1], [3, 1]];
data.views.z_b.values = [[0, 0], [0, 0], [0, 0]];
data.row_metadata.prompt = Array(3).fill(input.prompt);
data.row_metadata.prompt_id = ['prompt-one', 'prompt-two', 'prompt-three'];
data.row_metadata.response_a = input.answers;
data.row_metadata.model_a = Array(3).fill('reader/selected');
data.row_metadata.model_b = Array(3).fill('reader/other');
data.catalog = { feature_space: data.feature_space, provenance: {}, column_sources: {},
  table: { columns: ['feature_id', 'name', 'description'], index: [0, 1], data: [
    [3, 'Reader focus', 'Supplied evidence description for the selected concept.'],
    [7, 'Related behavior', 'A second concept used to test named relationship filters.']] } };
const result = artifacts(data);
result.files.set('viewer-bundle.json', jsonBytes(result.bundle));
console.log(JSON.stringify(Object.fromEntries([...result.files].map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]))));
'''
    return json.loads(subprocess.check_output(
        ['node', '--input-type=module', '-e', script], cwd=ROOT,
        input=json.dumps({'prompt': PROMPT, 'answers': ANSWERS}).encode()))


def current_state(page):
    return page.evaluate('history.state.values')


def answer_text(page):
    return page.locator('.answer-route .response-card .owner-text')


def visible_answer_height(page):
    return answer_text(page).evaluate('''e => {
      const owner=e.getBoundingClientRect(), r=(e.querySelector('.reading-final')||e).getBoundingClientRect();
      const app=document.querySelector('#app').getBoundingClientRect();
      return Math.max(0,Math.min(r.bottom,owner.bottom,app.bottom,innerHeight)-Math.max(r.top,owner.top,app.top,0));
    }''')


def go_answers(page):
    page.goto(URL + '#answers', wait_until='networkidle')
    expect(page.locator('body')).to_have_attribute('data-engine-source', 'shared')
    expect(answer_text(page)).to_be_visible()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport={'width': 1024, 'height': 600})
    page.set_default_timeout(10_000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    go_answers(page)
    assert visible_answer_height(page) >= 100, 'Real export: fewer than 100px of answer visible initially'
    print(f'Real export: {visible_answer_height(page):.0f}px of answer visible at 1024×600.')

    artifacts = fixture()
    for path in ('data/viewer-data.json', 'viewer-build.json', 'viewer-bundle.json'):
        page.route('**/' + path, lambda route, request, path=path: route.fulfill(
            status=200, content_type='application/json', body=artifacts[path]))
    page.goto('about:blank')
    go_answers(page)
    if page.locator('.reader-heading h1').inner_text() != 'Reader focus':
        page.locator('[data-focus-concept="answer:3"]').first.click()
    assert visible_answer_height(page) >= 100, 'Long prompt pushes the answer below the initial viewport'

    evidence = page.locator('.reader-heading details.concept-explanation')
    prompt = page.locator('details.rail-prompt[data-reader-prompt]')
    expect(evidence).not_to_have_attribute('open', '')
    expect(prompt).not_to_have_attribute('open', '')
    for disclosure in (evidence, prompt):
        disclosure.locator('summary').click()
        assert disclosure.evaluate('e=>e.open')
        page.locator('[data-page="answer:next"]').click()
        assert disclosure.evaluate('e=>e.open'), 'Opened reader disclosure was reset by paging'
        disclosure.locator('summary').click()
        page.locator('[data-page="answer:prev"]').click()
        assert not disclosure.evaluate('e=>e.open'), 'Closed reader disclosure reopened on paging'
    prompt.locator('summary').click()
    expect(prompt).to_contain_text('PROMPT-END')
    prompt.locator('summary').click()

    expect(page.locator('[data-reading-mode], .response-preference')).to_have_count(0)
    text = answer_text(page)
    reasoning = text.locator('.reading-reasoning')
    assert not reasoning.evaluate('e=>e.open'), 'Reasoning should start collapsed'
    expect(text.locator('h2')).to_have_text('Result')
    expect(text.locator('strong').filter(has_text='answer')).to_be_visible()
    expect(text.locator('li')).to_have_count(2)
    assert text.locator('pre code').text_content().strip() == 'print("<tag> & exact code")'
    expect(text.locator('script,img,iframe')).to_have_count(0)
    assert not text.locator('a').evaluate_all('es=>es.some(e=>/^javascript:/i.test(e.getAttribute("href")||""))')
    assert page.evaluate('window.__readerInjected') is None
    reasoning.locator('summary').click()
    assert reasoning.evaluate('e=>e.open')
    expect(reasoning).to_contain_text('REASONING-MARKER')
    assert reasoning.locator('strong').text_content() == 'the calculation'
    assert text.locator('.katex').count() > 0, 'Supplied math was not rendered'
    assert re.search(r'x(?:\^|²|\s*2)', text.text_content()), 'Mathematical content disappeared'

    selected = current_state(page)['answerCursor']['row_id']
    row = ['synthetic-1', 'synthetic-2', 'synthetic-3'].index(selected)
    page.locator('.response-card [data-drawer^="source:"]').click()
    source = page.locator('#overlay-root .source-text')
    expect(source).to_have_count(2)
    assert source.nth(0).text_content() == PROMPT, 'Source prompt text was changed'
    assert source.nth(1).text_content() == ANSWERS[row], 'Source answer whitespace or text was changed'
    page.keyboard.press('Escape')
    expect(page.locator('#overlay-root .drawer')).to_have_count(0)

    page.locator('[data-activation-pick="quartile:3"]').click()
    filters = page.locator('#context-strip .reader-active-filters')
    activation_chip = filters.locator('[data-clear-activation]')
    expect(activation_chip).to_be_visible()
    expect(filters).to_contain_text('Top 25%')
    page.locator('#app').evaluate('e=>e.scrollTop=0')
    expect(activation_chip).to_be_in_viewport()

    page.locator('[data-overlay="relationships"]').first.click()
    page.locator('[data-rel-minimum]').fill('0')
    page.locator('[data-rel-minimum]').press('Tab')
    page.locator('[data-rel-check="answer:7"]').click()
    page.locator('[data-apply-relationships]').click()
    relation_chip = filters.locator('[data-remove-relationship="answer:7"]')
    expect(relation_chip).to_be_visible()
    expect(relation_chip).to_contain_text('Related behavior')
    relation_chip.click()
    expect(relation_chip).to_have_count(0)
    expect(activation_chip).to_be_visible()
    assert current_state(page)['answerActivation'] is not None, 'Removing a relationship also cleared the activation filter'
    activation_chip.click()
    assert current_state(page)['answerActivation'] is None
    assert not errors, errors
    browser.close()
print('Reader geometry, disclosure persistence, safe formatting, exact source text and independent named filters passed.')
