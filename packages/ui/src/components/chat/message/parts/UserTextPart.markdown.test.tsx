import { describe, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { Part } from '@/lib/opencode/model';

// A user's message from its text to the DOM a user sees: the preparation in
// `userTextPartContent`, the renderer's typed-text mode and the real DOMPurify
// on a happy-dom window. Inline code with quotes used to show `&quot;`: the
// text was escaped as HTML before it reached a Markdown parser, which shows
// code character for character and escaped it again.

// Bun does not load Vite's `?worker&url` imports. An empty URL keeps the
// highlight worker from starting, so code stays uncoloured; nothing here reads
// colours.
plugin({
  name: 'user-text-markdown-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
  },
});

// DOMPurify binds to the window it finds when it is first imported, so the
// DOM goes in before the renderer loads.
const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  customElements: browser.customElements,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLAnchorElement: browser.HTMLAnchorElement,
  SVGElement: browser.SVGElement,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

// The app stores start loading the server's state when imported; every request
// answers empty here instead of reaching for a server.
spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
  if (path.endsWith('/location')) {
    return Response.json({ directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } });
  }
  if (path.endsWith('/session')) return Response.json({ data: [] });
  if (path.endsWith('/config') || path.endsWith('/project')) return Response.json([]);
  return Response.json({});
});

const { prepareUserMarkdownContent } = await import('./userTextPartContent');
const { renderMarkdownBlocks, renderMarkdownBlocksSync } = await import('../../markdown/markdownCore');

const userMarkdown = (textContent: string): string => prepareUserMarkdownContent({ textContent, skillNames: new Set() });

const toDom = (html: string): HTMLDivElement => {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
};

/** The first paint of a user message, the way `SimpleMarkdownRenderer literalHtml` draws it. */
const renderUserText = (textContent: string): HTMLDivElement =>
  toDom(renderMarkdownBlocksSync(userMarkdown(textContent), false, 'local', 'literal').map((block) => block.html).join(''));

describe('user message Markdown', () => {
  test('shows inline code with quotes as typed, in the first paint and the settled render', async () => {
    const markdown = userMarkdown('Rendering check: the route answers `{ "ok": true }` here.');
    const firstPaint = renderMarkdownBlocksSync(markdown, false, 'local', 'literal');
    const settled = await renderMarkdownBlocks(markdown, false, 'local', 'literal');

    for (const blocks of [firstPaint, settled]) {
      const root = toDom(blocks.map((block) => block.html).join(''));
      expect(root.querySelector('code')?.textContent).toBe('{ "ok": true }');
      expect(root.textContent?.trim()).toBe('Rendering check: the route answers { "ok": true } here.');
    }
  });

  test('keeps code, autolinks and math character for character', () => {
    const root = renderUserText([
      "Compare `a < b && c > d` with `'x'`.",
      '',
      'See <https://example.com/a?b=1&c=2> and \\(a < b\\).',
      '',
      '    indented "code" <x> &amp;',
    ].join('\n'));

    expect(Array.from(root.querySelectorAll('code'), (code) => code.textContent?.trim())).toEqual([
      'a < b && c > d',
      "'x'",
      'indented "code" <x> &amp;',
    ]);
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a?b=1&c=2');
    expect(root.querySelector('.katex')).not.toBeNull();
    expect(root.querySelector('.katex-error')).toBeNull();
  });

  test('shows tags and character references as typed and builds no element from them', () => {
    const payloads = [
      'Use <b>bold</b> and <script>alert("x")</script>',
      '<img src=x onerror="alert(1)">',
      '<svg onload=alert(1)>',
      '<a href="javascript:alert(1)">j</a>',
      '<style>body{display:none}</style>',
      '<details open><summary>S</summary>body</details>',
      '&amp; &lt;b&gt; &quot; &nbsp; &#x27;',
    ];
    for (const payload of payloads) {
      const root = renderUserText(payload);
      expect(root.textContent?.trim()).toBe(payload);
      expect(Array.from(root.querySelectorAll('*'), (element) => element.tagName.toLowerCase())).toEqual(['p']);
    }
  });

  test('keeps the lines of a tag block and renders the Markdown inside it', () => {
    const lines = renderUserText('<open_items>\nfirst\nsecond\n</open_items>');
    expect(lines.querySelectorAll('br')).toHaveLength(3);
    expect(lines.textContent?.trim()).toBe('<open_items>firstsecond</open_items>');

    const list = renderUserText('<context>\n- a\n- b\n</context>');
    expect(Array.from(list.querySelectorAll('li'), (item) => item.textContent?.trim())).toEqual(['a', 'b</context>']);
  });

  test('keeps a fenced block whole inside a tag block, blank lines included', () => {
    const root = renderUserText('<example>\n```js\nconst a = 1;\n\nconst b = 2;\n```\n</example>');
    expect(Array.from(root.querySelectorAll('pre code'), (code) => code.textContent)).toEqual(['const a = 1;\n\nconst b = 2;\n']);
  });

  test('never reuses the cached assistant render of the same text', () => {
    const text = '<open_items>\nfirst\n</open_items>';
    renderMarkdownBlocksSync(userMarkdown(text), false, 'local', 'escape');
    expect(renderUserText(text).querySelectorAll('br')).toHaveLength(2);
  });
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { OpenCode } = await import('@opencode/client');
const { SyncProvider } = await import('@/sync/sync-context');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { useUIStore } = await import('@/stores/useUIStore');
const { loadMarkdownRendererModule } = await import('../../markdownRendererLoader');
const { default: UserTextPart } = await import('./UserTextPart');

const unavailable = (): never => { throw new Error('Rendering a user message must not call runtime APIs'); };
const runtimeAPIs: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unavailable(); },
  get git() { return unavailable(); },
  get files() { return unavailable(); },
  get settings() { return unavailable(); },
  get permissions() { return unavailable(); },
  get notifications() { return unavailable(); },
  get sourceControl() { return unavailable(); },
};

const sdk = OpenCode.make({
  baseUrl: 'http://localhost',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    // An idle event stream: a JSON body on /event fails the event pipeline.
    if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  },
});

describe('UserTextPart', () => {
  test('renders a message in Markdown mode through the typed-text path', async () => {
    useUIStore.setState({ userMessageRenderingMode: 'markdown', collapsibleUserMessages: false });
    // Loaded up front, so the renderer mounts without suspending.
    await loadMarkdownRendererModule();
    const part: Extract<Part, { type: 'text' }> = {
      id: 'prt_user_markdown',
      sessionID: 'ses_user_markdown',
      messageID: 'msg_user_markdown',
      type: 'text',
      // The tag block opens the message, where assistant output reads it as
      // raw HTML and loses its line breaks.
      text: '<context>\nfirst\nsecond\n</context>\n\nRendering check: the route answers `{ "ok": true }` here.',
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <RuntimeAPIContext.Provider value={runtimeAPIs}>
            <SyncProvider sdk={sdk} directory="">
              <I18nProvider>
                <UserTextPart
                  part={part}
                  messageId="msg_user_markdown"
                  isMobile={false}
                  messageExpanded
                  onExpandMessage={() => undefined}
                  partIndex={0}
                  onTruncationChange={() => undefined}
                  attachmentFilenames={[]}
                />
              </I18nProvider>
            </SyncProvider>
          </RuntimeAPIContext.Provider>,
        );
      });
      // The settled render replaces the first paint after a task.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

      const content = container.querySelector('[data-markdown-content]');
      expect(content?.querySelector('code')?.textContent).toBe('{ "ok": true }');
      expect(content?.querySelectorAll('br')).toHaveLength(3);
      expect(content?.textContent).toContain('<context>');
      expect(content?.textContent).not.toContain('&quot;');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
