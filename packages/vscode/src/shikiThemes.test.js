import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

let themeLabels = {};
let themeFiles = new Map();
let reportedSizes = new Map();
let statCalls = [];
let readCalls = [];

mock.module('vscode', () => ({
  ColorThemeKind: { Light: 1, Dark: 2, HighContrastLight: 4 },
  Uri: { joinPath: (_base, path) => ({ path }) },
  extensions: {
    all: [{
      extensionUri: {},
      packageJSON: {
        contributes: {
          themes: [
            { label: 'Light', path: 'themes/light.json' },
            { label: 'Dark', path: 'themes/dark.json' },
          ],
        },
      },
    }],
  },
  window: { activeColorTheme: { kind: 2 } },
  workspace: {
    getConfiguration: () => ({ get: (key) => themeLabels[key] }),
    fs: {
      stat: async (uri) => {
        statCalls.push(uri.path);
        return { size: reportedSizes.get(uri.path) ?? themeFiles.get(uri.path)?.byteLength ?? 0 };
      },
      readFile: async (uri) => {
        readCalls.push(uri.path);
        const bytes = themeFiles.get(uri.path);
        if (!bytes) throw new Error(`Missing theme file: ${uri.path}`);
        return bytes;
      },
    },
  },
}));

const { getWebviewShikiThemes, SHIKI_THEME_MAX_BYTES } = await import('./shikiThemes.ts?shiki-theme-cap-test');

const encodeTheme = (name) => new TextEncoder().encode(JSON.stringify({ name, colors: { background: '#fff' } }));

beforeEach(() => {
  themeLabels = { colorTheme: 'Dark', preferredLightColorTheme: 'Light', preferredDarkColorTheme: 'Dark' };
  themeFiles = new Map([
    ['themes/light.json', encodeTheme('Light theme')],
    ['themes/dark.json', encodeTheme('Dark theme')],
  ]);
  reportedSizes = new Map();
  statCalls = [];
  readCalls = [];
});

afterEach(() => {
  themeFiles.clear();
  reportedSizes.clear();
});

describe('VS Code Shiki theme file size cap (#1104)', () => {
  it('skips an over-cap theme read and keeps the existing one-side fallback', async () => {
    reportedSizes.set('themes/dark.json', SHIKI_THEME_MAX_BYTES + 1);

    const themes = await getWebviewShikiThemes();

    expect(statCalls).toHaveLength(2);
    expect(readCalls).toEqual(['themes/light.json']);
    expect(themes).toEqual({
      light: { name: 'Light theme (Light)', colors: { background: '#fff' } },
      dark: { name: 'Light theme (Dark)', colors: { background: '#fff' } },
    });
  });

  it('preserves normal light and dark theme resolution', async () => {
    const themes = await getWebviewShikiThemes();

    expect(readCalls).toHaveLength(2);
    expect(themes).toEqual({
      light: { name: 'Light theme (Light)', colors: { background: '#fff' } },
      dark: { name: 'Dark theme (Dark)', colors: { background: '#fff' } },
    });
  });

  it('allows a theme exactly at the cap', async () => {
    reportedSizes.set('themes/dark.json', SHIKI_THEME_MAX_BYTES);

    const themes = await getWebviewShikiThemes();

    expect(readCalls).toContain('themes/dark.json');
    expect(themes?.dark?.name).toBe('Dark theme (Dark)');
  });

  it('rejects a theme that grows past the cap after stat', async () => {
    reportedSizes.set('themes/dark.json', 1);
    themeFiles.set(
      'themes/dark.json',
      new TextEncoder().encode(JSON.stringify({ name: 'Large theme', colors: { padding: 'x'.repeat(SHIKI_THEME_MAX_BYTES) } })),
    );

    const themes = await getWebviewShikiThemes();

    expect(readCalls).toContain('themes/dark.json');
    expect(themes?.dark?.name).toBe('Light theme (Dark)');
  });
});
