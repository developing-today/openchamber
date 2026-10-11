import { describe, expect, test } from 'bun:test';

import {
  nextSecretRequestPollDelay,
  startSecretRequestPolling,
  type PollVisibility,
} from './useMcpxSecretRequests';

type Timer = { id: number; callback: () => void; delay: number };

// The test fires the next scheduled poll by hand, so the cadence is checked without waiting.
const manualScheduler = () => {
  const timers: Timer[] = [];
  let nextId = 1;
  return {
    timers,
    schedule: (callback: () => void, delay: number) => {
      const id = nextId;
      nextId += 1;
      timers.push({ id, callback, delay });
      return id;
    },
    cancel: (id: number) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index !== -1) timers.splice(index, 1);
    },
    fire: () => {
      const timer = timers.shift();
      if (!timer) throw new Error('No poll is scheduled');
      timer.callback();
    },
  };
};

// Each load returns its call number, or throws when the next scripted outcome is 'fail'.
const scriptedLoad = (outcomes: Array<'ok' | 'fail'>) => {
  const calls: number[] = [];
  return {
    calls,
    load: async (): Promise<number> => {
      const call = calls.length + 1;
      calls.push(call);
      if (outcomes.shift() === 'fail') throw new Error('daemon unreachable');
      return call;
    },
  };
};

// Each load stays in flight until the test releases it.
const gatedLoad = () => {
  const inFlight: Array<() => void> = [];
  let calls = 0;
  let running = 0;
  let peak = 0;
  return {
    load: () => new Promise<number>((resolve) => {
      calls += 1;
      running += 1;
      peak = Math.max(peak, running);
      const call = calls;
      inFlight.push(() => {
        running -= 1;
        resolve(call);
      });
    }),
    release: () => inFlight.shift()?.(),
    calls: () => calls,
    peak: () => peak,
  };
};

const visible = (): PollVisibility => ({ isHidden: () => false, onVisible: () => () => undefined });

const screen = () => {
  let hidden = false;
  const listeners = new Set<() => void>();
  return {
    visibility: {
      isHidden: () => hidden,
      onVisible: (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    } satisfies PollVisibility,
    hide: () => { hidden = true; },
    show: () => {
      hidden = false;
      for (const listener of [...listeners]) listener();
    },
  };
};

// Lets the poll's awaited work and its follow-up scheduling run.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('nextSecretRequestPollDelay', () => {
  test('polls every 2 s while the daemon answers, then doubles per failure up to 30 s', () => {
    expect([0, 1, 2, 3, 4, 10].map((failures) => nextSecretRequestPollDelay(failures)))
      .toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });
});

describe('startSecretRequestPolling', () => {
  test('loads on start, then again 2 s after each load settles', async () => {
    const scheduler = manualScheduler();
    const applied: number[] = [];
    const { load, calls } = scriptedLoad([]);
    const poller = startSecretRequestPolling(load, (value) => { applied.push(value); }, scheduler.schedule, scheduler.cancel, visible());
    await settle();
    expect(calls).toEqual([1]);
    expect(scheduler.timers.map((timer) => timer.delay)).toEqual([2_000]);

    scheduler.fire();
    await settle();
    expect(calls).toEqual([1, 2]);
    expect(applied).toEqual([1, 2]);
    poller.stop();
  });

  test('keeps the last good result and backs off while the daemon is unreachable, then resumes at 2 s', async () => {
    const scheduler = manualScheduler();
    const applied: number[] = [];
    const { load } = scriptedLoad(['ok', 'fail', 'fail', 'ok']);
    const poller = startSecretRequestPolling(load, (value) => { applied.push(value); }, scheduler.schedule, scheduler.cancel, visible());
    await settle();

    scheduler.fire();
    await settle();
    expect(scheduler.timers.map((timer) => timer.delay)).toEqual([4_000]);

    scheduler.fire();
    await settle();
    expect(scheduler.timers.map((timer) => timer.delay)).toEqual([8_000]);

    scheduler.fire();
    await settle();
    expect(applied).toEqual([1, 4]);
    expect(scheduler.timers.map((timer) => timer.delay)).toEqual([2_000]);
    poller.stop();
  });

  test('never runs two loads at once, and a refresh during a load gets exactly one follow-up', async () => {
    const scheduler = manualScheduler();
    const gate = gatedLoad();
    const applied: number[] = [];
    const poller = startSecretRequestPolling(gate.load, (value) => { applied.push(value); }, scheduler.schedule, scheduler.cancel, visible());
    expect(gate.calls()).toBe(1);

    const first = poller.refresh();
    const second = poller.refresh();
    expect(gate.calls()).toBe(1);

    gate.release();
    await settle();
    expect(gate.calls()).toBe(2);

    gate.release();
    await Promise.all([first, second]);
    expect(gate.peak()).toBe(1);
    expect(applied).toEqual([1, 2]);
    expect(scheduler.timers.map((timer) => timer.delay)).toEqual([2_000]);
    poller.stop();
  });

  test('does not poll while the app is hidden, and polls once when it becomes visible', async () => {
    const scheduler = manualScheduler();
    const app = screen();
    const { load, calls } = scriptedLoad([]);
    app.hide();
    const poller = startSecretRequestPolling(load, () => undefined, scheduler.schedule, scheduler.cancel, app.visibility);
    await settle();
    expect(calls).toEqual([]);
    expect(scheduler.timers).toEqual([]);

    app.show();
    await settle();
    expect(calls).toEqual([1]);
    poller.stop();
  });

  test('stop cancels the next poll and drops a result that arrives afterwards', async () => {
    const scheduler = manualScheduler();
    const gate = gatedLoad();
    const applied: number[] = [];
    const poller = startSecretRequestPolling(gate.load, (value) => { applied.push(value); }, scheduler.schedule, scheduler.cancel, visible());
    const pending = poller.refresh();
    poller.stop();

    gate.release();
    await settle();
    expect(applied).toEqual([]);
    expect(scheduler.timers).toEqual([]);
    await pending;
  });
});
