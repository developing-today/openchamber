import { describe, expect, test } from 'bun:test';
import { createDeviceSettingsReporter } from './deviceSettingsReport';

const harness = (accept = () => true) => {
  let values = { sidebarWidth: 280 };
  const timers: Array<() => void> = [];
  const sent: Array<{ deviceId: string; values: { sidebarWidth: number } }> = [];
  const reporter = createDeviceSettingsReporter({
    read: () => values,
    send: async (report) => { sent.push(report); return accept(); },
    deviceId: 'device-aaaa',
    surface: 'web',
    schedule: (callback) => { timers.push(callback); return timers.length - 1; },
    cancel: (handle) => { timers[handle] = () => {}; },
  });
  const tick = async () => { const pending = timers.splice(0); for (const run of pending) run(); await Promise.resolve(); await Promise.resolve(); };
  return { reporter, sent, tick, set: (next: number) => { values = { sidebarWidth: next }; } };
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
