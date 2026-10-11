import React from 'react';

import { fetchPendingSecretRequests, type McpxSecretRequest } from '@/lib/mcpxSecrets';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

const MCPX_SECRET_REQUEST_POLL_MS = 2_000;
const MAX_POLL_BACKOFF_MS = 30_000;

type ScheduleTimeout = (callback: () => void, delay: number) => number;
type ClearScheduledTimeout = (timeoutId: number) => void;

/** Whether anyone can see the app, and a way to hear when they can again. */
export type PollVisibility = {
  isHidden: () => boolean;
  onVisible: (listener: () => void) => () => void;
};

type SecretRequestPoller = {
  /** Loads now, or right after the load in flight. Resolves once a load that started after this call has settled. */
  refresh: () => Promise<void>;
  stop: () => void;
};

/**
 * The wait before the next load: 2 s while the daemon answers, then doubling for
 * each failure in a row, up to 30 s.
 */
export const nextSecretRequestPollDelay = (consecutiveFailures: number): number => (
  consecutiveFailures === 0
    ? MCPX_SECRET_REQUEST_POLL_MS
    : Math.min(MAX_POLL_BACKOFF_MS, MCPX_SECRET_REQUEST_POLL_MS * 2 ** consecutiveFailures)
);

const NEVER_HIDDEN: PollVisibility = { isHidden: () => false, onVisible: () => () => undefined };

/**
 * Loads every 2 s while the app is visible. One load runs at a time, and the next is
 * scheduled only after it settles, so a slow daemon never piles up requests. A failed
 * load skips `apply`, which keeps the last good result, and backs off. A result that
 * arrives after `stop` is dropped.
 */
export const startSecretRequestPolling = <T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
  scheduleTimeout: ScheduleTimeout = window.setTimeout.bind(window),
  clearScheduledTimeout: ClearScheduledTimeout = window.clearTimeout.bind(window),
  visibility: PollVisibility = NEVER_HIDDEN,
): SecretRequestPoller => {
  let disposed = false;
  let timeoutId: number | undefined;
  let running = false;
  let refreshQueued = false;
  let failures = 0;
  // A poll that came due while the app was hidden runs once it is visible again.
  let dueWhileHidden = false;
  // Refresh callers waiting for a load that starts after they asked.
  let waiting: Array<() => void> = [];

  const cancelScheduled = () => {
    if (timeoutId === undefined) return;
    clearScheduledTimeout(timeoutId);
    timeoutId = undefined;
  };

  const poll = async (): Promise<void> => {
    if (disposed || running) return;
    if (visibility.isHidden()) {
      dueWhileHidden = true;
      return;
    }
    dueWhileHidden = false;
    running = true;
    const satisfied = waiting;
    waiting = [];
    try {
      const value = await load();
      failures = 0;
      if (!disposed) apply(value);
    } catch {
      failures += 1;
    }
    running = false;
    satisfied.forEach((resolve) => resolve());
    if (disposed) return;
    if (refreshQueued) {
      refreshQueued = false;
      void poll();
      return;
    }
    timeoutId = scheduleTimeout(() => {
      timeoutId = undefined;
      void poll();
    }, nextSecretRequestPollDelay(failures));
  };

  const refresh = (): Promise<void> => new Promise((resolve) => {
    if (disposed) {
      resolve();
      return;
    }
    waiting.push(resolve);
    if (running) {
      refreshQueued = true;
      return;
    }
    cancelScheduled();
    void poll();
  });

  const stopListening = visibility.onVisible(() => {
    if (dueWhileHidden) void refresh();
  });

  void poll();

  return {
    refresh,
    stop: () => {
      disposed = true;
      stopListening();
      cancelScheduled();
      const pending = waiting;
      waiting = [];
      pending.forEach((resolve) => resolve());
    },
  };
};

const documentVisibility = (): PollVisibility => ({
  isHidden: () => document.visibilityState === 'hidden',
  onVisible: (listener) => {
    const handle = () => {
      if (document.visibilityState !== 'hidden') listener();
    };
    document.addEventListener('visibilitychange', handle);
    return () => document.removeEventListener('visibilitychange', handle);
  },
});

type McpxSecretRequestsState = {
  /** Pending requests from the connected runtime, in the order the daemon lists them. */
  requests: McpxSecretRequest[];
  /** Reads the list now. Resolves once that read has settled. */
  refresh: () => Promise<void>;
};

/** Pending secret requests from the connected runtime, polled while the app is visible. */
export const useMcpxSecretRequests = (): McpxSecretRequestsState => {
  const [requests, setRequests] = React.useState<McpxSecretRequest[]>([]);
  const pollerRef = React.useRef<SecretRequestPoller | null>(null);

  React.useEffect(() => {
    const start = () => startSecretRequestPolling(
      fetchPendingSecretRequests,
      setRequests,
      window.setTimeout.bind(window),
      window.clearTimeout.bind(window),
      documentVisibility(),
    );
    let poller = start();
    pollerRef.current = poller;
    // A request belongs to the runtime that reported it. A switch drops the list
    // and polls the new runtime, so a secret never goes to the wrong daemon.
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      poller.stop();
      setRequests([]);
      poller = start();
      pollerRef.current = poller;
    });
    return () => {
      unsubscribe();
      poller.stop();
      pollerRef.current = null;
    };
  }, []);

  const refresh = React.useCallback(() => pollerRef.current?.refresh() ?? Promise.resolve(), []);
  return { requests, refresh };
};
