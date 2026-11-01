import { describe, expect, test } from "bun:test";

import {
  getAppearanceVisibleSettings,
  VISIBLE_SETTINGS,
} from "./visualSettings";

describe("Appearance page visibleSettings allowlist (#1078)", () => {
  test("includes every gateable visual setting outside VS Code", () => {
    expect(getAppearanceVisibleSettings(false)).toEqual([...VISIBLE_SETTINGS]);
  });

  test("includes sidebarRows so SessionRowDisplaySettings can render", () => {
    expect(getAppearanceVisibleSettings(false)).toContain("sidebarRows");
    expect(getAppearanceVisibleSettings(true)).toContain("sidebarRows");
  });

  test("omits only weekStart in VS Code", () => {
    expect(getAppearanceVisibleSettings(true)).toEqual(
      VISIBLE_SETTINGS.filter((setting) => setting !== "weekStart"),
    );
  });
});
