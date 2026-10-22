import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createDeviceSettingsReporter, readDeviceSettings } from './deviceSettingsReport';
import { useUIStore } from '@/stores/useUIStore';

let hold = false;
const harness = (accept = () => true) => {
  let values = { sidebarWidth: 280 };
  const timers = new Map<number, () => void>();
  let nextHandle = 0;
  const sent: Array<{ deviceId: string; values: { sidebarWidth: number }; closing: boolean }> = [];
  let release: (() => void) | null = null;
  const reporter = createDeviceSettingsReporter({
    read: () => values,
    send: async (report, closing) => {
      sent.push({ ...report, closing });
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
      return accept();
    },
    deviceId: 'device-aaaa',
    surface: 'web',
    schedule: (callback) => { nextHandle += 1; timers.set(nextHandle, callback); return nextHandle; },
    cancel: (handle) => { timers.delete(handle); },
  });
  const tick = async () => { const pending = [...timers.values()]; timers.clear(); for (const run of pending) run(); await Promise.resolve(); await Promise.resolve(); };
  return { reporter, sent, tick, set: (next: number) => { values = { sidebarWidth: next }; }, release: () => release?.() };
};

describe('device settings reporter', () => {
  test('sends once after a burst of changes, then only when something changed', async () => {
    const { reporter, sent, tick, set } = harness();
    reporter.request(); set(300); reporter.request(); set(320); reporter.request();
    await tick();
    expect(sent.map((report) => report.values.sidebarWidth)).toEqual([320]);

    reporter.request();
    await tick();
    expect(sent).toHaveLength(1);

    set(340); reporter.request();
    await tick();
    expect(sent.map((report) => report.values.sidebarWidth)).toEqual([320, 340]);
    expect(sent[0]).toMatchObject({ deviceId: 'device-aaaa', surface: 'web' });
  });

  test('sends again after the server refused a report', async () => {
    let accept = false;
    const { reporter, sent, tick } = harness(() => accept);
    reporter.request();
    await tick();
    accept = true;
    reporter.request();
    await tick();
    expect(sent).toHaveLength(2);
  });

  test('tells a newly connected server even when nothing changed', async () => {
    const { reporter, sent, tick } = harness();
    reporter.request();
    await tick();
    reporter.forget();
    reporter.request();
    await tick();
    expect(sent).toHaveLength(2);
  });
});

describe('device settings reporter, closing and switching', () => {
  test('a closing window sends a pending change at once, marked to outlive the page', async () => {
    const { reporter, sent, set } = harness();
    set(300); reporter.request();
    await reporter.flush(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ values: { sidebarWidth: 300 }, closing: true });
  });

  test('a reply from the previous server does not count for the new one', async () => {
    hold = true;
    try {
      const { reporter, sent, tick, release } = harness();
      const pending = reporter.flush();
      reporter.forget();
      release();
      await pending;
      hold = false;
      reporter.request();
      await tick();
      expect(sent).toHaveLength(2);
    } finally {
      hold = false;
    }
  });
});

// The server keeps only its own list of reportable keys
// (packages/web/server/lib/device-settings/store.js); a key the UI sends that
// the server drops, or the other way round, would go unnoticed without this.
test('the keys this window reports are the keys the server keeps', () => {
  const store = readFileSync(new URL('../../../../web/server/lib/device-settings/store.js', import.meta.url), 'utf8');
  const block = store.slice(store.indexOf('const REPORTABLE_KEYS = new Set(['), store.indexOf(']);', store.indexOf('const REPORTABLE_KEYS')));
  const serverKeys = [...block.matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]).sort();
  expect(serverKeys.length).toBeGreaterThan(20);
  expect(Object.keys(readDeviceSettings(useUIStore.getState())).sort()).toEqual(serverKeys);
});
