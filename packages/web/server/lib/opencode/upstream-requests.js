const inFlightByPort = new Map();

// Counts proxied requests that are still answering from an upstream port. A draining OpenCode
// is idle only when none are left, so a request that started before a handoff finishes on it.
export const beginUpstreamRequest = (port) => {
  if (!Number.isInteger(port) || port <= 0) return () => {};
  inFlightByPort.set(port, (inFlightByPort.get(port) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const remaining = (inFlightByPort.get(port) ?? 1) - 1;
    if (remaining > 0) inFlightByPort.set(port, remaining);
    else inFlightByPort.delete(port);
  };
};

export const countUpstreamRequests = (port) => inFlightByPort.get(port) ?? 0;
