import { describe, expect, it } from 'vitest';
import { createDeviceSettingsStore } from './store.js';

const report = (overrides = {}) => ({ deviceId: 'device-aaaa', surface: 'web', values: { sidebarWidth: 280, messageLimit: 200 }, ...overrides });

describe('device settings store', () => {
  it('keeps the latest report per device, most recent first', () => {
    let clock = 1;
    const store = createDeviceSettingsStore({ now: () => clock++ });
    expect(store.report(report())).toEqual({ ok: true });
    expect(store.report(report({ deviceId: 'device-bbbb', surface: 'mobile', values: { mobileKeyboardMode: 'native' } }))).toEqual({ ok: true });
    expect(store.report(report({ values: { sidebarWidth: 320 } }))).toEqual({ ok: true });

    expect(store.list()).toEqual([
      { deviceId: 'device-aaaa', surface: 'web', values: { sidebarWidth: 320 }, updatedAt: 3 },
      { deviceId: 'device-bbbb', surface: 'mobile', values: { mobileKeyboardMode: 'native' }, updatedAt: 2 },
    ]);
  });

  it('keeps only the reportable device keys', () => {
    const store = createDeviceSettingsStore();
    store.report(report({ values: {
      sidebarWidth: 280,
      themeId: 'x', // profile
      desktopUiPassword: 'secret', // instance secret
      notAKey: 1,
      // Device-scoped but transient: the UI leaves them out, and so does the server.
      contextPanelByDirectory: { '/repo': {} },
      agentTerminalNames: { t1: 'x' },
      workStatusScrollTop: 10,
    } }));
    expect(store.list()[0].values).toEqual({ sidebarWidth: 280 });
  });

  it('drops keys the registry limits to other surfaces', () => {
    const store = createDeviceSettingsStore();
    const values = { sidebarWidth: 280, mobileKeyboardMode: 'native', desktopWindowControlsStyle: 'classic', inputBarOffset: 0 };
    store.report(report({ deviceId: 'device-web1', surface: 'web', values }));
    store.report(report({ deviceId: 'device-dsk1', surface: 'desktop', values }));
    store.report(report({ deviceId: 'device-mob1', surface: 'mobile', values }));
    const bySurface = Object.fromEntries(store.list().map((device) => [device.surface, device.values]));
    expect(bySurface.web).toEqual({ sidebarWidth: 280, inputBarOffset: 0 });
    expect(bySurface.desktop).toEqual({ sidebarWidth: 280, desktopWindowControlsStyle: 'classic' });
    expect(bySurface.mobile).toEqual({ sidebarWidth: 280, mobileKeyboardMode: 'native', inputBarOffset: 0 });
  });

  it('refuses malformed and oversized reports and changes nothing', () => {
    const store = createDeviceSettingsStore();
    expect(store.report(null)).toMatchObject({ ok: false, status: 400 });
    expect(store.report(report({ deviceId: 'x' }))).toMatchObject({ ok: false, status: 400 });
    expect(store.report(report({ deviceId: '../../etc/passwd' }))).toMatchObject({ ok: false, status: 400 });
    expect(store.report(report({ surface: 'tv' }))).toMatchObject({ ok: false, status: 400 });
    expect(store.report(report({ values: [] }))).toMatchObject({ ok: false, status: 400 });
    expect(store.report(report({ values: { contextRailOrder: ['x'.repeat(70 * 1024)] } }))).toMatchObject({ ok: false, status: 413 });
    expect(store.list()).toEqual([]);
  });

  it('drops the least recently reported device past the cap', () => {
    const store = createDeviceSettingsStore({ maxDevices: 2 });
    store.report(report({ deviceId: 'device-1111' }));
    store.report(report({ deviceId: 'device-2222' }));
    store.report(report({ deviceId: 'device-1111' }));
    store.report(report({ deviceId: 'device-3333' }));
    expect(store.list().map((device) => device.deviceId)).toEqual(['device-3333', 'device-1111']);
  });

  it('hands out copies, so a caller cannot change what is stored', () => {
    const store = createDeviceSettingsStore();
    store.report(report());
    store.list()[0].values.sidebarWidth = 999;
    expect(store.list()[0].values.sidebarWidth).toBe(280);
  });
});
