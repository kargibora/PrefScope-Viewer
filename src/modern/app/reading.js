import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
markdown.disable('image'); // Dataset text must never trigger remote image requests.
markdown.validateLink = url => /^(?:https?:|mailto:)/i.test(url);
markdown.use(texmath, {
  engine: katex,
  delimiters: ['dollars', 'brackets'],
  katexOptions: { trust: false, throwOnError: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 },
});
const escape = markdown.utils.escapeHtml;

// Let Markdown identify code, escapes and blockquotes instead of scanning those
// constructs ourselves. This parser only recognizes the reasoning delimiter.
const reasoningParser = new MarkdownIt({ html: false });
reasoningParser.inline.ruler.before('html_inline', 'reasoning_close', (state, silent) => {
  if (!state.src.startsWith('</think>', state.pos)) return false;
  if (!silent) {
    const token = state.push('reasoning_close', '', 0);
    token.meta = { offset: state.pos };
  }
  state.pos += 8;
  return true;
});

export function splitReasoning(text) {
  const original = String(text ?? '');
  const opening = /^(?:[ \t]*\r?\n)* {0,3}<think>/.exec(original);
  if (!opening) return { reasoning: null, final: original };
  const body = original.slice(opening[0].length), lines = body.split('\n');
  for (const block of reasoningParser.parse(body, {})) {
    if (block.type !== 'inline' || block.level !== 1) continue;
    const closing = block.children.find(token => token.type === 'reasoning_close');
    if (!closing) continue;
    const before = block.content.slice(0, closing.meta.offset);
    const fragments = before.split('\n'), lineIndex = block.map[0] + fragments.length - 1;
    // Token content strips indentation and normalizes CRLF. Locate the same
    // delimiter occurrence in its original line so the returned slices stay exact.
    const occurrence = fragments.at(-1).split('</think>').length;
    let column = -8;
    for (let n = 0; n < occurrence; n++) column = lines[lineIndex].indexOf('</think>', column + 8);
    const offset = lines.slice(0, lineIndex).reduce((sum, line) => sum + line.length + 1, 0) + column;
    return { reasoning: body.slice(0, offset), final: body.slice(offset + 8) };
  }
  return { reasoning: null, final: original };
}

export function renderMarkdown(text) {
  return markdown.render(String(text ?? ''));
}

export function renderReading(text) {
  const { reasoning, final } = splitReasoning(text);
  return `<div class="reading-content">${reasoning === null ? '' : `<details class="reading-reasoning"><summary>Reasoning</summary><template class="reading-reasoning-source">${escape(reasoning)}</template><div class="reading-reasoning-body"></div></details>`}<div class="reading-final">${renderMarkdown(final)}</div></div>`;
}

export function hydrateReasoning(details) {
  const source = details.querySelector('template.reading-reasoning-source');
  if (!source || !details.open) return;
  details.querySelector('.reading-reasoning-body').innerHTML = renderMarkdown(source.content.textContent);
  source.remove();
}
