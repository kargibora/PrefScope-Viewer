#!/usr/bin/env python3
"""Source ownership and canvas interaction checks against the production bundle.

Run: uv run --with playwright python tests/modern-map-smoke.py
Only temporary synthetic exports are created; run npm run build:bundle first.
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
DIST = ROOT / 'dist'
LONG_ANSWER = '  Synthetic map answer 44.\n' + 'Full source text, including <literal markup> & Unicode café.\n' * 300 + 'MAP-ANSWER-TAIL  '


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def table(rows):
    columns = list(rows[0])
    return dict(index=list(range(len(rows))), index_names=[None], column_names=[None],
                columns=columns, data=[[row[key] for key in columns] for row in rows])


def fixture(paired=False, identical=False, many=False):
    name = 'pairedFixture' if paired else 'genericFixture'
    data = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        f"import {{{name}}} from './tests/modern-fixture.mjs'; console.log(JSON.stringify({name}()));"], cwd=ROOT))
    data['provenance']['title'] = 'Synthetic map interaction test'
    data['views'] = dict(zip(['left_vectors', 'right_vectors'] if paired else ['completion_vectors'], data['views'].values()))
    data['row_metadata'].pop('preference_probability', None)
    if many:
        data['row_ids'] = [f'synthetic-map-{row:02d}' for row in range(45)]
        data['row_metadata'] = dict(response=[f'Synthetic map answer {row}.' for row in range(45)],
                                    model=[f'synthetic/model-{row % 20:02d}' for row in range(45)])
        data['row_metadata']['response'][-1] = LONG_ANSWER
        data['feature_ids'] = [3, 7, *range(100, 143)]
        data['views']['completion_vectors']['values'] = [[int(row < 7), 1, *[int(column == row % 43) for column in range(43)]] for row in range(45)]
    points = []
    for row, row_id in enumerate(data['row_ids']):
        for source, view in data['views'].items():
            points.append(dict(projection_id='answers', space='main', row_id=row_id, view=source,
                               x=1 if identical else len(points), y=1 if identical else (row * 3 + len(points)) % 5,
                               zero_vector=not any(view['values'][row])))
    meta = dict(projection_id='answers', method='umap', basis='full_feature_activations', preprocessing='none',
                space='main', feature_space_id=None, feature_ids=data['feature_ids'], views=list(data['views']),
                view_descriptors=[dict(view=source, **{key: value for key, value in view.items() if key != 'values'})
                                  for source, view in data['views'].items()], row_order='row_major_view_order',
                n_rows=len(data['row_ids']), n_features=len(data['feature_ids']), n_points=len(points), n_zero_rows=0,
                parameters={}, versions={}, input_hash='synthetic-map-fixture')
    metadata = [meta]
    if paired:
        prompt_views = data['prompt']['views']
        metadata.append({**meta, 'projection_id': 'prompt', 'space': 'prompt', 'feature_ids': data['prompt']['feature_ids'],
                         'views': list(prompt_views), 'n_points': len(data['row_ids']),
                         'view_descriptors': [dict(view=source, **{key: value for key, value in view.items() if key != 'values'})
                                              for source, view in prompt_views.items()]})
        points.extend(dict(projection_id='prompt', space='prompt', row_id=row_id, view=next(iter(prompt_views)),
                           x=row, y=row * 2, zero_vector=False) for row, row_id in enumerate(data['row_ids']))
    data['tables'] = dict(example_umap_meta=table(metadata), example_umap_points=table(points))
    return data


def export(folder, data):
    shutil.copytree(DIST, folder)
    (folder / 'data').mkdir()
    (folder / 'data/viewer-data.json').write_text(json.dumps(data))
    build = json.loads((folder / 'viewer-build.json').read_text())
    files = [dict(path=p.relative_to(folder).as_posix(), size_bytes=p.stat().st_size,
                  sha256=sha256(p.read_bytes()).hexdigest()) for p in folder.rglob('*') if p.is_file()]
    bundle = dict(schema='prefscope.viewer_bundle', schema_version=1, producer=dict(package='prefscope', version='0.3.1'),
                  viewer=dict(package=build['package'], version=build['version'],
                              build=dict(path='viewer-build.json', schema=build['schema'], schema_version=build['schema_version'],
                                         supported_data_schemas=build['supported_data_schemas']),
                              build_sha256=next(x['sha256'] for x in files if x['path'] == 'viewer-build.json')),
                  data=dict(path='data/viewer-data.json', schema=data['schema'], schema_version=data['schema_version']), files=files)
    (folder / 'viewer-bundle.json').write_text(json.dumps(bundle))


CANVAS_PROBE = """(() => {
  window.mapPaint = {points:[], frames:0, invalid:[]};
  const proto=CanvasRenderingContext2D.prototype;
  for(const name of ['clearRect','arc','fill']) {
    const original=proto[name];
    proto[name]=function(...args) {
      if(this.canvas.id==='map-canvas') {
        if(name==='clearRect') { mapPaint.points=[]; mapPaint.frames++; }
        if(name==='arc') {
          if(!args.slice(0,3).every(Number.isFinite)) mapPaint.invalid.push(args.slice(0,3));
          this.lastMapArc={x:args[0],y:args[1],radius:args[2]};
        }
        if(name==='fill' && this.lastMapArc) mapPaint.points.push({...this.lastMapArc,color:this.fillStyle});
      }
      return original.apply(this,args);
    };
  }
})()"""


def settled(page):
    page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')


def state(page):
    return page.evaluate('history.state.values')


def paint(page):
    settled(page)
    result = page.evaluate('mapPaint')
    assert not result['invalid'], result['invalid']
    return result


def open_map(browser, base, kind):
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.add_init_script(CANVAS_PROBE)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(f'{base}/{kind}/index.html#map', wait_until='networkidle')
    assert not page.locator('.route-state').count(), page.locator('#app').inner_text()
    expect(page.locator('body')).to_have_attribute('data-engine-source', 'shared')
    if kind == 'paired':
        page.click('[data-map-space="answer"]')
    expect(page.locator('#map-canvas')).to_be_visible()
    settled(page)
    expect(page.locator('.map-callout')).to_have_count(0)
    return page, errors


def select_feature(page, feature, source='answer', pole=None):
    page.click('.map-panel-tabs [data-map-panel="concepts"]')
    page.fill('#map-concept-search', f'#{feature}')
    key = f'{source}:{feature}' + (f':{pole}' if pole else '')
    if source == 'answer':
        expect(page.locator('[data-map-concept]')).to_have_count(1)
    page.click(f'[data-map-concept="{key}"]')
    settled(page)
    assert state(page)['mapLayers'] == [key]


def examples(page):
    page.click('.map-panel-tabs [data-map-panel="examples"]')
    settled(page)


def darkness(point):
    return sum(float(value) for value in re.findall(r'[\d.]+', point['color'])[:3])


def separate_inspector(page):
    for width, height in [(1440, 900), (1024, 600)]:
        page.set_viewport_size(dict(width=width, height=height))
        settled(page)
        canvas = page.locator('#map-canvas').bounding_box()
        inspector = page.locator('#map-callout').bounding_box()
        assert canvas['width'] > 250 and inspector['width'] > 200
        assert inspector['x'] + inspector['width'] <= canvas['x'] + 1, (canvas, inspector)
        assert canvas['x'] + canvas['width'] <= width + 1
        assert page.locator('#app').evaluate('e=>e.scrollWidth<=e.clientWidth')
    page.set_viewport_size(dict(width=1440, height=900))
    settled(page)


assert (DIST / 'index.html').is_file(), 'Run npm run build:bundle first.'
with TemporaryDirectory(prefix='prefscope-map-') as temporary:
    folder = Path(temporary)
    for kind in ['generic', 'paired', 'identical', 'many']:
        export(folder / kind, fixture(paired=kind == 'paired', identical=kind == 'identical', many=kind == 'many'))
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(folder)))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            base = f'http://127.0.0.1:{server.server_port}'
            page, errors = open_map(browser, base, 'generic')
            expect(page.locator('.map-panel-tabs [data-map-panel="concepts"]')).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('[data-map-concept]')).to_have_count(2)
            select_feature(page, 7)
            select_feature(page, 3)
            expect(page.locator('.map-active-summary strong')).to_have_text('2')
            points = paint(page)['points']
            assert len(points) == 3
            assert len({point['color'] for point in points}) == 3, points
            assert darkness(points[2]) < darkness(points[0]), 'Stronger activation should be darker'
            # Coordinate units have equal scale on both axes, without stretching UMAP geometry.
            assert abs((points[2]['x'] - points[0]['x']) / 2 - abs(points[2]['y'] - points[0]['y']) / 3) < 1
            examples(page)
            expect(page.locator('[data-map-record]')).to_have_count(2)
            assert page.locator('.map-example-title').all_text_contents() == ['Synthetic third answer.', 'Synthetic first answer.']
            page.select_option('[data-map-sort]', 'weakest')
            assert page.locator('.map-example-title').all_text_contents() == ['Synthetic first answer.', 'Synthetic third answer.']
            page.select_option('[data-map-sort]', 'dataset')
            separate_inspector(page)
            canvas = page.locator('#map-canvas')
            canvas.focus()
            page.keyboard.press('ArrowRight')
            expect(page.locator('.callout-preview')).to_have_text('Synthetic first answer.')
            page.keyboard.press('ArrowRight')
            expect(page.locator('.callout-preview')).to_have_text('Synthetic third answer.')
            page.keyboard.press('ArrowLeft')
            expect(page.locator('.callout-preview')).to_have_text('Synthetic first answer.')
            page.keyboard.press('End')
            expect(page.locator('.callout-preview')).to_have_text('Synthetic third answer.')
            page.keyboard.press('Home')
            expect(page.locator('.callout-preview')).to_have_text('Synthetic first answer.')
            page.keyboard.press('Escape')
            expect(page.locator('.map-callout')).to_have_count(0)
            # Double-click expands a sample; closing preserves the map and selection.
            target = paint(page)['points'][-1]
            box = canvas.bounding_box()
            transform = state(page)['mapTransform']
            page.mouse.dblclick(box['x'] + target['x'], box['y'] + target['y'])
            expect(page.locator('.map-sample-dialog')).to_be_visible()
            expect(page.locator('.map-sample-text')).to_have_text('Synthetic third answer.')
            assert page.locator('#app').evaluate('e=>e.inert')
            assert state(page)['mapTransform'] == transform
            for _ in range(12):
                page.keyboard.press('Tab')
                assert page.evaluate('!!document.activeElement.closest(".map-sample-dialog")')
            page.click('.map-sample-footer [data-area-step="next"]')
            expect(page.locator('.map-sample-text')).to_have_text('Synthetic first answer.')
            page.keyboard.press('Escape')
            expect(page.locator('.map-sample-dialog')).to_have_count(0)
            expect(page.locator('.callout-preview')).to_have_text('Synthetic first answer.')
            assert not page.locator('#app').evaluate('e=>e.inert')
            expect(canvas).to_be_focused()
            canvas.focus()
            page.keyboard.press('Enter')
            expect(page.locator('.map-sample-text')).to_have_text('Synthetic first answer.')
            page.click('.map-sample-dialog [data-close-overlay]')
            expect(page.locator('.map-sample-dialog')).to_have_count(0)
            expect(canvas).to_be_focused()
            page.click('[data-overlay="sample"]')
            expect(page.locator('.map-sample-dialog')).to_be_visible()
            page.locator('.overlay-backdrop').click(position=dict(x=5,y=5))
            expect(page.locator('.map-sample-dialog')).to_have_count(0)
            canvas.focus()
            page.keyboard.press('Escape')
            # Clicks inspect points in Select area mode; only drags brush.
            page.click('[data-map-mode="select"]')
            target = paint(page)['points'][-1]
            box = canvas.bounding_box()
            page.mouse.click(box['x'] + target['x'], box['y'] + target['y'])
            expect(page.locator('.callout-preview')).to_have_text('Synthetic third answer.')
            canvas.focus()
            page.keyboard.press('Escape')
            page.click('[data-map-mode="pan"]')
            page.locator('[data-map-record]').first.click()
            selected = state(page)['mapCursor']
            expect(page.locator('.callout-preview')).to_have_text('Synthetic first answer.')

            # A live pan must repaint while held and retain the inspected record.
            before = paint(page)
            box = canvas.bounding_box()
            x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + 55, y + 25, steps=3)
            during = paint(page)
            assert during['frames'] > before['frames'], 'Pan did not repaint until mouseup'
            assert abs(during['points'][0]['x'] - before['points'][0]['x'] - 55) < 1
            assert abs(during['points'][0]['y'] - before['points'][0]['y'] - 25) < 1
            page.mouse.up()
            settled(page)
            assert state(page)['mapCursor'] == selected
            expect(page.locator('.callout-preview')).to_have_text('Synthetic first answer.')
            page.click('[data-close-callout]')
            expect(page.locator('[data-map-record]')).to_have_count(2)
            canvas.focus()
            page.keyboard.press('+')
            assert state(page)['mapTransform']['scale'] > 1
            page.keyboard.press('0')
            assert state(page)['mapTransform'] == dict(scale=1, x=0, y=0)
            before = paint(page)['points']
            page.click('[data-zoom="-1"]')
            after = paint(page)['points']
            distance = lambda rows: abs(rows[-1]['x'] - rows[0]['x'])
            assert distance(after) < distance(before)
            page.click('[data-zoom="0"]')
            # Inactive dots remain inspectable while the list contains active examples only.
            target = paint(page)['points'][1]
            box = canvas.bounding_box()
            page.mouse.click(box['x'] + target['x'], box['y'] + target['y'])
            expect(page.locator('.callout-preview')).to_have_text('Synthetic second answer.')
            expect(page.locator('.map-example-strength strong')).to_have_text('Inactive')
            expect(page.locator('.map-record-pager')).to_have_count(0)
            page.click('[data-close-callout]')
            page.select_option('[data-map-population-select]', 'all')
            page.fill('.map-search', 'Synthetic second answer.')
            settled(page)
            expect(page.locator('.map-callout')).to_have_count(0)
            canvas.focus()
            page.keyboard.press('ArrowRight')
            expect(page.locator('.callout-preview')).to_have_text('Synthetic second answer.')
            assert 'completion_vectors' in state(page)['mapCursor']['source']
            page.click('[data-open-map-observation]')
            expect(page.locator('.response-card .owner-text')).to_have_text('Synthetic second answer.')
            assert 'completion_vectors' in state(page)['answerCursor']['source']
            assert not errors, errors
            page.close()
            print('Generic source, highlight ownership, keyboard, live pan and zoom passed.', flush=True)

            page, errors = open_map(browser, base, 'paired')
            select_feature(page, 3)
            expect(page.locator('.map-active-summary strong')).to_have_text('3')
            points = paint(page)['points']
            assert len(points) == 6
            assert points[1]['color'] == points[2]['color'] == points[5]['color']
            assert darkness(points[4]) < darkness(points[3]) < darkness(points[0])
            # B1 is inactive for this concept and outside the active examples list.
            box = page.locator('#map-canvas').bounding_box()
            page.mouse.click(box['x'] + points[1]['x'], box['y'] + points[1]['y'])
            expect(page.locator('.callout-preview')).to_have_text('Synthetic B one.')
            expect(page.locator('.map-example-strength strong')).to_have_text('Inactive')
            expect(page.locator('.map-prompt-context summary')).to_contain_text('Synthetic prompt one.')
            page.click('[data-overlay="sample"]')
            expect(page.locator('.map-sample-text')).to_have_text('Synthetic B one.')
            expect(page.locator('.map-sample-focus strong')).to_have_text('Inactive')
            page.click('.map-sample-prompt summary')
            expect(page.locator('.map-sample-prompt .owner-text')).to_have_text('Synthetic prompt one.')
            page.keyboard.press('Escape')
            expect(page.locator('.map-sample-dialog')).to_have_count(0)
            assert 'synthetic-1' not in page.locator('#map-callout').inner_text()
            expect(page.locator('.callout-actions [data-drawer]')).to_have_count(0)
            page.click('[data-close-callout]')
            page.select_option('[data-map-population-select]', 'all')
            page.select_option('[data-map-sort]', 'dataset')
            expect(page.locator('[data-map-record]')).to_have_count(6)
            page.click('[data-map-record="1"]')
            expect(page.locator('.callout-preview')).to_have_text('Synthetic B one.')
            expect(page.locator('.map-example-strength strong')).to_have_text('Inactive')
            separate_inspector(page)
            page.click('.map-callout [data-area-step="prev"]')
            expect(page.locator('.callout-preview')).to_have_text('Synthetic A one.')
            page.click('.map-callout [data-area-step="next"]')
            expect(page.locator('.callout-preview')).to_have_text('Synthetic B one.')
            page.click('[data-close-callout]')
            expect(page.locator('[data-map-record]')).to_have_count(6)
            page.fill('.map-search', 'Synthetic B one.')
            settled(page)
            page.locator('#map-canvas').focus()
            page.keyboard.press('ArrowRight')
            expect(page.locator('.callout-preview')).to_have_text('Synthetic B one.')
            expect(page.locator('.map-example-strength strong')).to_have_text('Inactive')
            assert 'right_vectors' in state(page)['mapCursor']['source']
            expect(page.locator('.map-preference')).to_have_count(0)
            page.click('[data-open-map-observation]')
            expect(page.locator('.response-card .owner-text')).to_have_text('Synthetic B one.')
            assert 'right_vectors' in state(page)['answerCursor']['source']
            assert not errors, errors
            page.close()
            print('Renamed paired sources, outside-highlight inspection and absent preference passed.', flush=True)

            page, errors = open_map(browser, base, 'identical')
            points = paint(page)['points']
            assert len(points) == 3 and len({(point['x'], point['y']) for point in points}) == 1
            box = page.locator('#map-canvas').bounding_box()
            assert 0 < points[0]['x'] < box['width'] and 0 < points[0]['y'] < box['height']
            page.locator('#map-canvas').focus()
            page.keyboard.press('End')
            expect(page.locator('.callout-preview')).to_have_text('Synthetic first answer.')
            assert not errors, errors
            page.close()
            print('Identical-coordinate projection remains finite, visible and keyboard accessible.')

            page, errors = open_map(browser, base, 'many')
            expect(page.locator('[data-map-concept]')).to_have_count(20)
            first_concepts = page.locator('[data-map-concept]').evaluate_all('nodes=>nodes.map(node=>node.dataset.mapConcept)')
            page.click('[data-map-concept-page="next"]')
            expect(page.locator('[data-map-concept]')).to_have_count(20)
            assert page.locator('[data-map-concept]').evaluate_all('nodes=>nodes.map(node=>node.dataset.mapConcept)') != first_concepts
            select_feature(page, 142)
            select_feature(page, 7)
            examples(page)
            expect(page.locator('[data-map-record]')).to_have_count(20)
            assert page.locator('[data-map-record]').first.get_attribute('data-map-record') == '0'
            page.click('[data-map-page="next"]')
            expect(page.locator('[data-map-record]')).to_have_count(20)
            assert page.locator('[data-map-record]').first.get_attribute('data-map-record') == '20'
            page.click('[data-map-page="next"]')
            expect(page.locator('[data-map-record]')).to_have_count(5)
            page.locator('[data-map-record]').last.click()
            expect(page.locator('.callout-preview')).to_contain_text('MAP-ANSWER-TAIL')
            assert page.locator('.callout-preview').text_content() == LONG_ANSWER
            separate_inspector(page)
            page.click('[data-close-callout]')
            select_feature(page, 3)
            examples(page)
            expect(page.locator('[data-map-record]')).to_have_count(7)
            page.select_option('[data-map-population-select]', 'all')
            expect(page.locator('[data-map-record]')).to_have_count(20)
            points = paint(page)['points']
            active_color = points[0]['color']
            before = [point for point in points if point['color'] == active_color]
            page.click('[data-fit-map]')
            after = [point for point in paint(page)['points'] if point['color'] == active_color]
            assert len(before) == len(after) == 7, (len(before), len(after), paint(page), state(page)['mapTransform'])
            assert state(page)['mapTransform']['scale'] > 1
            assert after[-1]['x'] - after[0]['x'] > before[-1]['x'] - before[0]['x']
            box = page.locator('#map-canvas').bounding_box()
            assert all(0 <= point['x'] <= box['width'] and 0 <= point['y'] <= box['height'] for point in after)
            page.click('[data-zoom="0"]')
            assert state(page)['mapTransform'] == dict(scale=1, x=0, y=0)
            assert not errors, errors
            page.close()
            page, errors = open_map(browser, base, 'generic')
            page.click('.map-concepts-footer [data-overlay="layers"]')
            expect(page.locator('#overlay-root')).to_contain_text('Examples must activate every selected concept')
            page.click('[data-toggle-layer="answer:7"]')
            page.keyboard.press('Escape')
            expect(page.locator('#overlay-root [role="dialog"]')).to_have_count(0)
            assert set(state(page)['mapLayers']) == {'answer:3', 'answer:7'}
            expect(page.locator('.map-combination-note')).to_contain_text('All 2 concepts must be active')
            examples(page)
            expect(page.locator('[data-map-record]')).to_have_count(1)
            expect(page.locator('[data-map-record]')).to_contain_text('Synthetic third answer.')
            select_feature(page, 7)
            expect(page.locator('.map-combination-note')).to_have_count(0)
            examples(page)
            expect(page.locator('[data-map-record]')).to_have_count(2)
            assert not errors, errors
            page.close()
            page, errors = open_map(browser, base, 'paired')
            page.click('[data-map-space="prompt"]')
            select_feature(page, 12, source='prompt', pole='positive')
            page.click('[data-map-space="answer"]')
            select_feature(page, 3)
            page.click('[data-map-space="prompt"]')
            assert state(page)['mapLayers'] == ['prompt:12:positive']
            expect(page.locator('[data-map-concept="prompt:12:positive"]')).to_have_attribute('aria-pressed', 'true')
            page.reload(wait_until='networkidle')
            expect(page.locator('[data-map-concept="prompt:12:positive"]')).to_have_attribute('aria-pressed', 'true')
            assert state(page)['mapLayers'] == ['prompt:12:positive']
            page.click('[data-map-space="answer"]')
            assert state(page)['mapLayers'] == ['answer:3']
            assert not errors, errors
            page.close()

            page, errors = open_map(browser, base, 'generic')
            page.click('[data-zoom="-1"]')
            page.click('[data-map-mode="select"]')
            points = paint(page)['points']
            canvas = page.locator('#map-canvas').bounding_box()
            page.mouse.move(canvas['x'] + min(point['x'] for point in points) - 10,
                            canvas['y'] + min(point['y'] for point in points) - 10)
            page.mouse.down()
            page.mouse.move(canvas['x'] + max(point['x'] for point in points) + 10,
                            canvas['y'] + max(point['y'] for point in points) + 10, steps=4)
            page.mouse.up()
            settled(page)
            selected = state(page)
            assert selected['mapArea'] and selected['mapTransform']['scale'] != 1
            select_feature(page, 7)
            assert state(page)['mapArea'] == selected['mapArea'], 'Changing concepts discarded the brushed area'
            assert state(page)['mapTransform'] == selected['mapTransform'], 'Changing concepts reset the camera'
            assert not errors, errors
            page.close()
            browser.close()
            print('Bounded record pagination, last-record selection and Fit matches passed.')
            print('Explicit concept combinations use AND; choosing a concept replaces the combination.')
            print('Projection-specific concepts restore; changing concepts preserves zoom and brushed area.')
    finally:
        server.shutdown()
        thread.join()
print('Map smoke passed.')
