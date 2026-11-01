import { describe, expect, test } from 'bun:test';

import { getAppearanceVisibleSettings } from './appearanceVisibleSettings';

// Every value in OpenChamberVisualSettings' VisibleSetting union, as of #1078.
// This list is the pin: adding a gateable setting to the visual-settings
// component without adding it to the Appearance allowlist (and here) fails.
const ALL_GATEABLE_SETTINGS = [
  'theme',
  'windowControlsPosition',
  'pwaInstallName',
  'pwaOrientation',
  'mobileKeyboardMode',
  'timeFormat',
  'weekStart',
  'fontSize',
  'terminalFontSize',
  'editorFontSize',
  'spacing',
  'scrollbars',
  'inputBarOffset',
  'animatedActivityIndicators',
  'sidebarRows',
];

describe('getAppearanceVisibleSettings', () => {
  test('includes sidebarRows so the session-row controls render on the Appearance page', () => {
    expect(getAppearanceVisibleSettings(false)).toContain('sidebarRows');
    expect(getAppearanceVisibleSettings(true)).toContain('sidebarRows');
  });

  test('covers every gateable visual setting outside VS Code, with no duplicates', () => {
    const settings = getAppearanceVisibleSettings(false);
    expect([...settings].sort()).toEqual([...ALL_GATEABLE_SETTINGS].sort());
    expect(new Set(settings).size).toBe(settings.length);
  });

  test('omits only weekStart in the VS Code runtime', () => {
    const settings = getAppearanceVisibleSettings(true);
    expect([...settings].sort()).toEqual(ALL_GATEABLE_SETTINGS.filter((s) => s !== 'weekStart').sort());
  });
});
