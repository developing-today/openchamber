import { createRequire } from 'node:module';
import { isPlainObject, isString } from '../shared/guards.js';

/**
 * The device settings each open OpenChamber window reports: the settings the
 * registry scopes to one device (sidebar width, message limit, theme choice,
 * panel layout...), which live only in that window's own storage and never
 * reach `settings.json`. The agent tool reads them here (`settings.devices`);
 * nothing writes them back.
 *
 * Kept in memory only: a window reports again after a change and on load, so
 * a restart forgets devices until their windows report again. At most
 * `maxDevices` devices are kept, the least recently reported dropped first.
 * Only the reportable keys are kept, so a modified client cannot carry
 * anything else in: the registry's device-scoped preferences, without the
 * transient state the UI leaves out (per-folder panels, open dialogs, the
 * Settings page on screen, "last viewed" stamps, terminal names). Keep this
 * list equal to `readDeviceSettings` in
 * `packages/ui/src/lib/settings/deviceSettingsReport.ts`.
 */
const REPORTABLE_KEYS = new Set([
  'theme', 'isSidebarOpen', 'sidebarWidth', 'contextRailOrder', 'contextRailHiddenSurfaces',
  'mobileWorkspaceTabOrder', 'mobileWorkspaceHiddenTabs', 'contextSurfaceZones', 'contextEditorTreeVisible',
  'contextEditorVisible', 'contextEditorTreeWidth', 'workStatusExpandedSections', 'messageQueueExpanded',
  'messageLimit', 'walkthroughTocWidth', 'diffFileListMode', 'diffFileTreeWidth', 'showTerminalQuickKeysOnDesktop',
  'dockBadgeEnabled', 'alwaysShowScrollbars', 'mobileKeyboardMode', 'desktopWindowControlsPosition',
  'desktopWindowControlsStyle', 'inputBarOffset',
]);
// Every reportable key must stay device-scoped in the registry.
const registry = createRequire(import.meta.url)('../opencode/settings-registry.json');
const DEVICE_KEYS = new Set([...REPORTABLE_KEYS].filter((key) => registry.fields[key]?.scope === 'device'));
const SURFACES = new Set(['web', 'desktop', 'vscode', 'mobile']);
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_REPORT_BYTES = 64 * 1024;

export const createDeviceSettingsStore = ({ now = Date.now, maxDevices = 20 } = {}) => {
  const devices = new Map();

  /** @returns {{ ok: true } | { ok: false, status: number, error: string }} */
  const report = (input) => {
    if (!isPlainObject(input)) return { ok: false, status: 400, error: 'A report is an object' };
    const { deviceId, surface, values } = input;
    if (!isString(deviceId) || !DEVICE_ID_PATTERN.test(deviceId)) return { ok: false, status: 400, error: 'deviceId is 8 to 64 letters, digits, - or _' };
    if (!SURFACES.has(surface)) return { ok: false, status: 400, error: `surface is one of ${[...SURFACES].join(', ')}` };
    if (!isPlainObject(values)) return { ok: false, status: 400, error: 'values is an object of device settings' };
    if (JSON.stringify(values).length > MAX_REPORT_BYTES) return { ok: false, status: 413, error: 'Device settings report is too large' };
    const kept = Object.fromEntries(Object.entries(values).filter(([key, value]) => DEVICE_KEYS.has(key) && value !== undefined));
    devices.delete(deviceId);
    devices.set(deviceId, { deviceId, surface, values: kept, updatedAt: now() });
    while (devices.size > maxDevices) devices.delete(devices.keys().next().value);
    return { ok: true };
  };

  /** Every reported device, most recently reported first. */
  const list = () => [...devices.values()].reverse().map((device) => structuredClone(device));

  return { report, list };
};
