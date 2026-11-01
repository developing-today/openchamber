/**
 * Every setting OpenChamberVisualSettings can gate on `visibleSettings`.
 * Single source of truth: the VisibleSetting type is derived from this
 * list, and the Appearance page allowlist is derived from it too, so a
 * new gateable setting cannot ship unreachable (#1078).
 */
export const VISIBLE_SETTINGS = [
  "theme",
  "windowControlsPosition",
  "pwaInstallName",
  "pwaOrientation",
  "mobileKeyboardMode",
  "timeFormat",
  "weekStart",
  "fontSize",
  "terminalFontSize",
  "editorFontSize",
  "spacing",
  "scrollbars",
  "inputBarOffset",
  "animatedActivityIndicators",
  "sidebarRows",
] as const;

export type VisibleSetting = (typeof VISIBLE_SETTINGS)[number];

/**
 * The Appearance page allowlist: every gateable visual setting, except
 * weekStart in VS Code.
 */
export const getAppearanceVisibleSettings = (isVSCode: boolean): VisibleSetting[] =>
  VISIBLE_SETTINGS.filter((setting) => !(isVSCode && setting === "weekStart"));
