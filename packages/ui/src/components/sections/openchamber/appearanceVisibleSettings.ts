import type { VisibleSetting } from './OpenChamberVisualSettings';

// The Appearance (visual) section's allowlist for OpenChamberVisualSettings.
// Every setting the visual-settings component can gate on (its VisibleSetting
// union) belongs here, except weekStart, which the VS Code runtime omits.
// Pinned by appearanceVisibleSettings.test.ts — if a new VisibleSetting is
// added to OpenChamberVisualSettings, add it here too or the test fails.
export const getAppearanceVisibleSettings = (isVSCode: boolean): VisibleSetting[] => [
    'theme',
    'windowControlsPosition',
    'pwaInstallName',
    'pwaOrientation',
    'mobileKeyboardMode',
    'timeFormat',
    ...(!isVSCode ? ['weekStart' as const] : []),
    'fontSize',
    'terminalFontSize',
    'editorFontSize',
    'spacing',
    'scrollbars',
    'inputBarOffset',
    'animatedActivityIndicators',
    'sidebarRows',
];
