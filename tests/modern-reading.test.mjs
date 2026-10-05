import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderReading, splitReasoning, hydrateReasoning } from '../src/modern/app/reading.js';

test('formats Markdown, tables, code and both common math delimiters', () => {
  const html = renderReading('# Heading\n\n**Strong** and `x < y`\n\n- item\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```python\nprint("<script>")\n```\n\n$x^2$ and \\(y^2\\)\n\n\\[z^2\\]');
  for (const expected of ['<h1>', '<strong>', '<ul>', '<table>', 'language-python', '&lt;script&gt;', 'class="katex"', 'katex-display']) assert.ok(html.includes(expected), expected);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 3);
  assert.ok(!html.includes('<script>'));
});

test('untrusted HTML, images, links and TeX cannot add executable content or fetch images', () => {
  const html = renderReading('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) [x](data:text/html,x) [x](file:///etc/passwd) ![remote](https://evil.invalid/image) [safe](https://example.com)\n\n$\\href{javascript:alert(1)}{x}$ $\\includegraphics{https://evil.invalid/image}$');
  assert.ok(!/<(?:script|img|iframe)\b/i.test(html));
  assert.ok(!/href="(?:javascript|data|file):/i.test(html));
  assert.ok(html.includes('href="https://example.com"'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!renderMarkdown('```html\n<img onerror="alert(1)">\n```').includes('<img'));
  const malformed = renderMarkdown('$\\frac{<img src=x>}$');
  assert.ok(!malformed.includes('<img'));
  assert.ok(malformed.includes('&lt;img'));
});

test('only complete leading reasoning is split; source slices retain exact whitespace', () => {
  assert.deepEqual(splitReasoning(' <think>\r\nreason\r\n</think>\r\n Final  '), { reasoning: '\r\nreason\r\n', final: '\r\n Final  ' });
  for (const text of ['<think>unfinished', 'Text <think>quoted</think>', '`<think>code</think>`', '> <think>quote</think>', '    <think>code</think>', '```\n<think>code</think>\n```']) {
    assert.deepEqual(splitReasoning(text), { reasoning: null, final: text });
  }
  const reasoning = '\n```xml\n</think>\n```\n\n> </think>\n\n`</think>` and \\</think>\n\nreal thought\n';
  assert.deepEqual(splitReasoning(`<think>${reasoning}</think>\n**Final**`), { reasoning, final: '\n**Final**' });
  assert.deepEqual(splitReasoning('<think>`</think>` actual</think>final'), { reasoning: '`</think>` actual', final: 'final' });
});

test('reasoning is collapsed, escaped, and only formatted once on first open', () => {
  const html = renderReading('<think>$x^2$ <script>bad</script></think>**Final**');
  assert.ok(html.includes('<details class="reading-reasoning">'));
  assert.ok(html.includes('<template class="reading-reasoning-source">$x^2$ &lt;script&gt;bad&lt;/script&gt;</template>'));
  assert.ok(!html.includes('class="katex"'));
  assert.ok(html.includes('<strong>Final</strong>'));
  let removed = false;
  const source = { content: { textContent: '$x^2$' }, remove() { removed = true; } }, body = { innerHTML: '' };
  const details = { open: false, querySelector: selector => selector.startsWith('template') ? (removed ? null : source) : body };
  hydrateReasoning(details); assert.equal(body.innerHTML, '');
  details.open = true; hydrateReasoning(details); assert.ok(body.innerHTML.includes('class="katex"')); assert.ok(removed);
  body.innerHTML = 'already formatted'; hydrateReasoning(details); assert.equal(body.innerHTML, 'already formatted');
});
