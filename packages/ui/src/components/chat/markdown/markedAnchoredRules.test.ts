import { describe, expect, test } from 'bun:test';
import { Lexer, Marked } from 'marked';
import { pinMarkedAnchoredRules } from './markedAnchoredRules';

// Markdown touching every block and inline rule the pin replaces: headings,
// setext headings, rules, quotes, lists, code, fences, tables, HTML, link
// definitions, links, autolinks, emphasis, strikethrough, escapes and breaks.
const CORPUS = [
  '# Title',
  'Setext heading\n==============',
  'Paragraph with **bold**, *em*, ~~gone~~, `code`, a [link](https://a.example "t"), <https://b.example>, www.c.example and \\*escaped\\*.  \nHard break above.',
  '---',
  '> quoted line\n> > nested quote\ncontinued lazily',
  '- item one\n- item two\n  - nested\n\n1. first\n2) second',
  '    indented code\n    more',
  '```ts\nconst x = 1;\n```',
  '| a | b |\n|---|:-:|\n| 1 | 2 |',
  '<div>\nraw html\n</div>',
  '[ref]: https://ref.example "Ref"\n\nUse [ref] and [text][ref] and ![img](pic.png).',
  'trailing <span>inline</span> tag and an email@example.com',
].join('\n\n');

const lexAll = () => [new Marked({ gfm: true }), new Marked({ gfm: true, breaks: true }), new Marked({ pedantic: true })]
  .map((marked) => JSON.stringify(marked.lexer(CORPUS)));

const paragraphs = (count: number) => Array.from({ length: count }, (_, i) => `Paragraph ${i} is short.`).join('\n\n');

const fastestLexMs = (source: string) => {
  const marked = new Marked({ gfm: true });
  let best = Infinity;
  for (let run = 0; run < 3; run += 1) {
    const start = performance.now();
    marked.lexer(source);
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

describe('pinMarkedAnchoredRules', () => {
  // Runs before the pin, so `before` comes from marked's own rules.
  const before = lexAll();
  const pinned = pinMarkedAnchoredRules();

  test('replaces the anchored rules, and only once', () => {
    expect(pinned).toBeGreaterThan(20);
    expect(Lexer.rules.block.gfm.hr.sticky).toBe(true);
    expect(Lexer.rules.inline.gfm.emStrongRDelimAst.sticky).toBe(false);
    expect(pinMarkedAnchoredRules()).toBe(0);
  });

  test('lexes the same tokens as before', () => {
    expect(lexAll()).toEqual(before);
  });

  test('a rule matches from the start of each input, whatever the last match left', () => {
    const { hr } = Lexer.rules.block.gfm;
    expect(hr.exec('---\nafter')?.[0]).toBe('---\n');
    expect(hr.lastIndex).toBeGreaterThan(0);
    expect(hr.exec('***\n')?.[0]).toBe('***\n');
    expect(hr.exec('text\n---\n')).toBeNull();
  });

  // The cost of a message must grow with its length, not its square. Four
  // times the paragraphs takes about four times as long when linear and about
  // sixteen times when quadratic; the bound sits between, so machine speed
  // does not matter.
  test('lexing time grows linearly with the number of paragraphs', () => {
    fastestLexMs(paragraphs(250));
    const small = fastestLexMs(paragraphs(1_000));
    const large = fastestLexMs(paragraphs(4_000));
    expect(large / Math.max(small, 1)).toBeLessThan(8);
  }, 60_000);
});
