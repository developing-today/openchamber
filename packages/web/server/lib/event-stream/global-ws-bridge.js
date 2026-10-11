import { sendMessageStreamWsEvent, sendMessageStreamWsFrame, sendSerializedMessageStreamWsFrame, serializeMessageStreamWsEvent } from './protocol.js';
import { isOpenCodeEventId } from './sse-cursor.js';

function shouldTriggerUpstreamHealthCheck(upstream) {
  if (!upstream) {
    return true;
  }

  if (!upstream.body) {
    return upstream.ok || upstream.status >= 500;
  }

  return upstream.status >= 500;
}

export function createGlobalMessageStreamWsBridge({
  globalHub,
  ownsGlobalHub,
  wsClients,
  processForwardedEventPayload,
  triggerHealthCheck,
  heartbeatIntervalMs,
}) {
  const clients = new Set();
  // The last OpenCode id each client was sent, or the cursor it connected with until then. Hub ids
  // and payload ids are never kept: the browser keeps no cursor it could not replay from upstream.
  const clientLastEventIds = new Map();
  const readyClients = new Set();
  // The upstream read that resumes a client the replay buffer could not answer, while it runs.
  const resumeStops = new Map();

  // Every `ready` frame names the hub's head when the hub has seen an OpenCode event. A browser that
  // holds no cursor adopts it, so its next reconnect resumes from there instead of refetching.
  const readyFrame = (fields = {}) => {
    const headEventId = globalHub.headEventId();
    return { type: 'ready', scope: 'global', ...fields, ...(headEventId ? { headEventId } : {}) };
  };

  const removeClient = (socket) => {
    clients.delete(socket);
    clientLastEventIds.delete(socket);
    readyClients.delete(socket);
    wsClients.delete(socket);
    resumeStops.get(socket)?.();
    resumeStops.delete(socket);
  };

  const rememberCursor = (socket, eventId) => {
    if (isOpenCodeEventId(eventId)) clientLastEventIds.set(socket, eventId);
  };

  const forwardEvent = (socket, event) => {
    if (!sendSerializedMessageStreamWsFrame(socket, event.serialize())) {
      removeClient(socket);
      return false;
    }
    rememberCursor(socket, event.eventId);
    return true;
  };

  // An event the hub read from upstream on one client's own connection, forwarded the way the
  // shared stream forwards its events: with the synthetic events derived from it.
  const forwardUpstreamEvent = (socket, event) => {
    if (!forwardEvent(socket, event)) return false;
    processForwardedEventPayload(event.payload, (syntheticPayload) => {
      const serializedFrame = serializeMessageStreamWsEvent(syntheticPayload, { directory: 'global' });
      if (!sendSerializedMessageStreamWsFrame(socket, serializedFrame)) {
        removeClient(socket);
      }
    });
    return clients.has(socket);
  };

  const replayEvents = (socket, entries) => {
    for (const entry of entries) {
      if (!sendSerializedMessageStreamWsFrame(socket, entry.serializedFrame)) {
        removeClient(socket);
        return;
      }
      rememberCursor(socket, entry.eventId);
    }
  };

  // The client is ready once the buffer or OpenCode has answered its cursor. A cursor OpenCode
  // numbered that the buffer cannot answer is taken upstream; anything else the buffer cannot answer
  // is a client to refetch, as it always was.
  const markReady = (socket, requestedLastEventId) => {
    if (socket.readyState !== 1) {
      return;
    }

    globalHub.flushPending();
    const replay = globalHub.replayAfter(requestedLastEventId);
    // A cursor the buffer does not hold goes upstream only while no local frame has been committed: OpenCode
    // cannot replay one, so a resume could skip it. Otherwise the client is reset to refetch.
    if (replay === null && isOpenCodeEventId(requestedLastEventId) && globalHub.localFrames() === 0) {
      resumeFromUpstream(socket, requestedLastEventId);
      return;
    }

    const ready = readyFrame();
    if (replay === null) {
      ready.replayReset = true;
    } else if (isOpenCodeEventId(requestedLastEventId)) {
      // The buffer is contiguous for an OpenCode cursor: nothing was missed, so there is no refetch.
      ready.resumed = true;
    }
    const sent = sendMessageStreamWsFrame(socket, ready);
    if (!sent) {
      removeClient(socket);
      return;
    }

    readyClients.add(socket);
    wsClients.add(socket);
    if (replay !== null) replayEvents(socket, replay);
  };

  // The buffer cannot answer an OpenCode cursor, but OpenCode may: the events after the cursor are
  // read on a connection of this client's own and go out as they come, until the first one the hub
  // also holds. The client is told it resumed at once, as it is after a replay. If OpenCode cannot
  // honour the cursor, it is told to refetch instead, and then it is live like any other client.
  const resumeFromUpstream = (socket, cursor) => {
    if (!sendMessageStreamWsFrame(socket, readyFrame({ resumed: true }))) {
      removeClient(socket);
      return;
    }

    const goLive = () => {
      readyClients.add(socket);
      wsClients.add(socket);
    };
    const refetch = () => {
      resumeStops.delete(socket);
      if (!clients.has(socket)) return;
      if (!sendMessageStreamWsFrame(socket, readyFrame({ replayReset: true }))) {
        removeClient(socket);
        return;
      }
      goLive();
    };

    const stop = globalHub.openUpstreamAfter(cursor, {
      onEvent(event) {
        if (clients.has(socket)) forwardUpstreamEvent(socket, event);
      },
      onCaughtUp(event) {
        resumeStops.delete(socket);
        if (!clients.has(socket) || !forwardUpstreamEvent(socket, event)) return;
        const tail = globalHub.replayAfter(event.eventId);
        // A local frame after the caught-up event cannot be replayed: refetch, as for any other gap.
        if (tail === null) {
          refetch();
          return;
        }
        replayEvents(socket, tail);
        if (clients.has(socket)) goLive();
      },
      // OpenCode had nothing after the cursor, so the client is current: it goes live with nothing to
      // replay. Events committed from here on reach it through the shared stream.
      onIdle() {
        resumeStops.delete(socket);
        if (clients.has(socket)) goLive();
      },
      onResync: refetch,
      onFailed: refetch,
    });
    resumeStops.set(socket, stop);
  };

  const stopHubIfUnused = () => {
    if (ownsGlobalHub && clients.size === 0) {
      globalHub.stop();
    }
  };

  const closeClientsWithInitialError = ({ message, closeReason = message, triggerHealthCheckFor = null }) => {
    for (const socket of Array.from(clients)) {
      sendMessageStreamWsFrame(socket, { type: 'error', message });
      try {
        socket.close(1011, closeReason);
      } catch {
      }
      removeClient(socket);
    }

    if (triggerHealthCheckFor === true || (triggerHealthCheckFor && shouldTriggerUpstreamHealthCheck(triggerHealthCheckFor))) {
      triggerHealthCheck?.();
    }

    if (ownsGlobalHub) {
      globalHub.stop();
    }
  };

  // Browser clients take the events of isolated spaces too: each frame carries its directory,
  // and a space's directory is one more project directory to the UI.
  const unsubscribeEvent = globalHub.subscribeEvent((event) => {
    if (event.resync) {
      // OpenCode could not honour the cursor: the ready clients refetch, as after a replay reset.
      for (const socket of Array.from(clients)) {
        if (!readyClients.has(socket)) {
          continue;
        }
        if (!sendMessageStreamWsFrame(socket, readyFrame({ replayReset: true }))) {
          removeClient(socket);
        }
      }
      return;
    }

    const { payload } = event;
    for (const socket of Array.from(clients)) {
      if (!readyClients.has(socket)) {
        continue;
      }
      forwardEvent(socket, event);
    }

    processForwardedEventPayload(payload, (syntheticPayload) => {
      if (readyClients.size === 0) return;
      const serializedFrame = serializeMessageStreamWsEvent(syntheticPayload, { directory: 'global' });
      for (const socket of Array.from(clients)) {
        if (!readyClients.has(socket)) {
          continue;
        }
        const sent = sendSerializedMessageStreamWsFrame(socket, serializedFrame);
        if (!sent) {
          removeClient(socket);
        }
      }
    });
  }, { spaces: true });

  const unsubscribeStatus = globalHub.subscribeStatus((status) => {
    if (status.type === 'connect') {
      for (const socket of Array.from(clients)) {
        if (!readyClients.has(socket)) {
          // A client still resuming from upstream keeps its own read; it is not marked again.
          if (!resumeStops.has(socket)) markReady(socket, clientLastEventIds.get(socket) ?? '');
          continue;
        }

        if (status.wasReady) {
          // The upstream reconnects from its own cursor, so what it missed is replayed; without an
          // OpenCode cursor there is nothing to replay from, and the client must refetch as before.
          const ready = readyFrame();
          if (isOpenCodeEventId(globalHub.upstreamCursor())) ready.resumed = true;
          const sent = sendMessageStreamWsFrame(socket, ready);
          if (!sent) {
            removeClient(socket);
          }
        }
      }
      return;
    }

    if (status.type === 'initial-error') {
      const error = status.error;
      if (error?.type === 'upstream_unavailable') {
        closeClientsWithInitialError({
          message: `OpenCode event stream unavailable (${error.status})`,
          closeReason: 'OpenCode event stream unavailable',
          triggerHealthCheckFor: error.response,
        });
        return;
      }

      closeClientsWithInitialError({
        message: status.buildUrlFailed ? 'OpenCode service unavailable' : 'Failed to connect to OpenCode event stream',
        closeReason: status.buildUrlFailed ? 'OpenCode service unavailable' : 'Failed to connect to OpenCode event stream',
        triggerHealthCheckFor: !status.buildUrlFailed,
      });
      return;
    }

    if (status.type === 'error' && status.error?.type === 'stream_error') {
      console.warn('Message stream WS proxy error:', status.error.error);
    }
  });

  const accept = (socket, { requestedLastEventId = '' } = {}) => {
    const pingInterval = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }

      try {
        socket.ping();
      } catch {
      }
    }, heartbeatIntervalMs);

    const heartbeatInterval = setInterval(() => {
      if (!globalHub.isConnected()) {
        return;
      }

      sendMessageStreamWsEvent(socket, { type: 'openchamber:heartbeat', timestamp: Date.now() }, { directory: 'global' });
    }, heartbeatIntervalMs);

    socket.on('close', () => {
      clearInterval(pingInterval);
      clearInterval(heartbeatInterval);
      removeClient(socket);
      stopHubIfUnused();
    });

    socket.on('error', () => {
      void 0;
    });

    clients.add(socket);
    clientLastEventIds.set(socket, requestedLastEventId);
    globalHub.start();
    if (globalHub.isConnected()) {
      markReady(socket, requestedLastEventId);
    }
  };

  const close = () => {
    unsubscribeEvent();
    unsubscribeStatus();
    if (ownsGlobalHub) {
      globalHub.stop();
    }
    for (const socket of Array.from(clients)) {
      removeClient(socket);
    }
  };

  return {
    accept,
    close,
    /** The id of the last upstream event sent to a client, or the cursor it connected with. */
    lastEventIdOf(socket) {
      return clientLastEventIds.get(socket);
    },
  };
}
