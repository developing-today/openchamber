export const createGracefulShutdownRuntime = (dependencies) => {
  const {
    process,
    shutdownTimeoutMs,
    getExitOnShutdown,
    getIsShuttingDown,
    setIsShuttingDown,
    syncToHmrState,
    openCodeWatcherRuntime,
    sessionRuntime,
    sessionAssistRuntime,
    sessionWorkRuntime,
    sessionGoalRuntime,
    contextObligatoryRuntime,
    messageQueueRuntime,
    dispatchResultsRuntime,
    messageSearchRuntime,
    scheduledTasksRuntime,
    getHealthCheckInterval,
    clearHealthCheckInterval,
    getTerminalRuntime,
    setTerminalRuntime,
    getMessageStreamRuntime,
    setMessageStreamRuntime,
    shouldSkipOpenCodeStop,
    getOpenCodePort,
    getOpenCodeProcess,
    setOpenCodeProcess,
    waitForPortRelease,
    getServer,
    getUiAuthController,
    setUiAuthController,
    getActiveTunnelController,
    setActiveTunnelController,
    tunnelAuthController,
    beginGuestServiceShutdown,
    stopAllGuestServices,
    getGuestSurfaceRuntime,
    getRealtimeProxyRuntime,
    getDictationRuntime,
    getRelayService,
    getRelayReconcileTimer,
    getSpacesHost = () => null,
  } = dependencies;

  let shutdownPromise = null;
  const serverConnections = new Set();
  const busySocketRequests = new Map();
  let closingHttpServer = false;

  // Track TCP sockets before listen(): HTTP stops tracking them on upgrade,
  // even when no WebSocket handler completes the handshake.
  const trackServerConnections = (server) => {
    const onConnection = (socket) => {
      if (closingHttpServer) {
        socket.destroy();
        return;
      }
      serverConnections.add(socket);
      socket.once('close', () => {
        serverConnections.delete(socket);
        busySocketRequests.delete(socket);
      });
    };
    const onRequest = (request, response) => {
      const socket = request.socket;
      busySocketRequests.set(socket, (busySocketRequests.get(socket) ?? 0) + 1);
      response.once('close', () => {
        const remaining = (busySocketRequests.get(socket) ?? 1) - 1;
        if (remaining > 0) busySocketRequests.set(socket, remaining);
        else busySocketRequests.delete(socket);
      });
    };
    server.on('connection', onConnection);
    server.on('request', onRequest);
    server.once('close', () => {
      server.off('connection', onConnection);
      server.off('request', onRequest);
    });
  };

  // Stops accepting connections, then lets sockets with an in-flight HTTP request finish for up to
  // shutdownTimeoutMs. Idle keep-alive and upgraded sockets are cut at once: their owning runtimes
  // were stopped above, and net.Server.close() cannot complete while an upgraded socket is open.
  const drainHttpServer = async (server) => {
    let graceTimer = null;
    let sweepTimer = null;
    const closed = new Promise((resolve) => {
      server.close(() => {
        console.log('HTTP server closed');
        resolve(true);
      });
    });
    const sweepIdleSockets = () => {
      server.closeIdleConnections?.();
      for (const socket of serverConnections) {
        if (!busySocketRequests.has(socket)) socket.destroy();
      }
    };
    sweepIdleSockets();
    sweepTimer = setInterval(sweepIdleSockets, 100);
    const drained = await Promise.race([
      closed,
      new Promise((resolve) => {
        graceTimer = setTimeout(() => resolve(false), shutdownTimeoutMs);
      }),
    ]);
    clearInterval(sweepTimer);
    clearTimeout(graceTimer);
    if (!drained) {
      console.warn('Server close timeout reached, forcing shutdown');
      server.closeAllConnections?.();
      for (const socket of serverConnections) socket.destroy();
    }
  };

  const runShutdown = async (options = {}) => {
    if (getIsShuttingDown()) return;

    setIsShuttingDown(true);
    beginGuestServiceShutdown();
    syncToHmrState();
    console.log('Starting graceful shutdown...');
    const exitProcess = typeof options.exitProcess === 'boolean' ? options.exitProcess : getExitOnShutdown();

    // Both embedded stop() and daemon exits use this sequence. Close admission
    // synchronously above, then stop viewers before draining their services.
    const cleanupOperations = [
      () => clearInterval(getRelayReconcileTimer()),
      () => getGuestSurfaceRuntime()?.stop(),
      () => getRealtimeProxyRuntime()?.stop(),
      // The isolated-spaces host, when the switch is on: its connections into spaces end here.
      () => getSpacesHost()?.close(),
      () => getRelayService()?.stop(),
      () => getDictationRuntime()?.stop(),
      () => openCodeWatcherRuntime.stop(),
      () => sessionRuntime.dispose(),
      () => sessionAssistRuntime?.stop?.(),
      () => sessionWorkRuntime?.stop?.(),
      () => sessionGoalRuntime?.stop?.(),
      () => contextObligatoryRuntime?.stop?.(),
      () => messageQueueRuntime?.stop?.(),
      () => dispatchResultsRuntime?.stop?.(),
      () => messageSearchRuntime?.stop?.(),
      () => scheduledTasksRuntime?.stop?.(),
      stopAllGuestServices,
    ];
    for (const cleanup of cleanupOperations) {
      try {
        await cleanup();
      } catch {
        // One failed runtime must not skip the rest of host teardown.
      }
    }

    const healthCheckInterval = getHealthCheckInterval();
    if (healthCheckInterval) {
      clearHealthCheckInterval(healthCheckInterval);
    }

    const terminalRuntime = getTerminalRuntime();
    if (terminalRuntime) {
      try {
        await terminalRuntime.shutdown();
      } catch {
      } finally {
        setTerminalRuntime(null);
      }
    }

    const messageStreamRuntime = getMessageStreamRuntime();
    if (messageStreamRuntime) {
      try {
        await messageStreamRuntime.close();
      } catch {
      } finally {
        setMessageStreamRuntime(null);
      }
    }

    if (shouldSkipOpenCodeStop()) {
      console.log('Skipping OpenCode shutdown (external server)');
    } else if (options.keepOpenCode) {
      console.log('Leaving OpenCode running for the next start to adopt');
    } else {
      const portToKill = getOpenCodePort();
      const openCodeProcess = getOpenCodeProcess();

      if (openCodeProcess) {
        console.log('Stopping OpenCode process...');
        try {
          await openCodeProcess.close();
        } catch (error) {
          console.warn('Error closing OpenCode process:', error);
        }
        setOpenCodeProcess(null);
      }

      if (!(await waitForPortRelease(portToKill, 5000))) {
        console.warn(`Timed out waiting for OpenCode port ${portToKill} to be released during shutdown`);
      }
    }

    const server = getServer();
    if (server) {
      closingHttpServer = true;
      await drainHttpServer(server);
    }

    const uiAuthController = getUiAuthController();
    if (uiAuthController) {
      uiAuthController.dispose();
      setUiAuthController(null);
    }

    const activeTunnelController = getActiveTunnelController();
    if (activeTunnelController) {
      console.log('Stopping active tunnel...');
      activeTunnelController.stop();
      setActiveTunnelController(null);
      tunnelAuthController.clearActiveTunnel();
    }

    console.log('Graceful shutdown complete');
    if (exitProcess) {
      process.exit(0);
    }
  };

  const gracefulShutdown = (options = {}) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = runShutdown(options);
    return shutdownPromise;
  };

  return {
    gracefulShutdown,
    trackServerConnections,
  };
};
