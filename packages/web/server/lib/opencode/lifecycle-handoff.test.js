import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenCodeLifecycleRuntime } from './lifecycle.js';
import { readDrainingOpenCodeRecords } from './managed-opencode-state.js';

// Other test files mock node:child_process for the shared lifecycle module, so these must be the real functions.
const { spawn: realSpawn, spawnSync: realSpawnSync } = createRequire(import.meta.url)('node:child_process');

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const fakeOpenCodeScript = (markerPath) => `
  const fs = require('node:fs');
  const http = require('node:http');
  const host = process.argv[process.argv.indexOf('--hostname') + 1];
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  fs.appendFileSync(${JSON.stringify(markerPath)}, process.pid + '\\n');
  const server = http.createServer((req, res) => {
    if (req.url === '/api/info' || req.url === '/global/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ healthy: true, version: '2.0.14', pid: process.pid }));
      return;
    }
    if (req.url === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let tick = 0;
      const timer = setInterval(() => res.write('data: ' + JSON.stringify({ pid: process.pid, tick: tick++ }) + '\\n\\n'), 100);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, host, () => process.stdout.write('server listening on http://' + host + ':' + port + '\\n'));
`;

const openStream = async (port) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/event`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let ended = false;
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }
    } catch {
      // The stream ends with the process that serves it.
    } finally {
      ended = true;
    }
  })();
  return {
    events: () => chunks.join('').split('\n\n').filter((line) => line.startsWith('data:')).length,
    ended: () => ended,
    cancel: () => reader.cancel().catch(() => {}),
  };
};

const createFixture = async ({ busySessionIds = [] } = {}) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-handoff-'));
  const markerPath = path.join(root, 'pids');
  await fsp.writeFile(path.join(root, 'serve'), fakeOpenCodeScript(markerPath));
  const binary = { current: process.execPath };
  const busy = { current: busySessionIds };
  const handoffs = [];
  const state = { openCodeWorkingDirectory: root, useWslForOpencode: false };
  const createRuntime = (runtimeState = state) => createOpenCodeLifecycleRuntime({
    state: runtimeState,
    dataDir: root,
    env: { ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1' },
    syncToHmrState() {}, syncFromHmrState() {},
    checkOpenCodeBinary: async () => '2.0.14',
    ensureOpencodeCliEnv: () => binary.current,
    applyOpencodeBinaryFromSettings: async () => {},
    ensureLocalOpenCodeServerPassword: async () => 'fixture-only',
    getOpenCodeAuthHeaders: () => ({}),
    resolveManagedOpenCodeLaunchSpec: (value) => ({ binary: value, args: [] }),
    normalizeApiPrefix: (value) => value,
    setOpenCodePort() {}, setDetectedOpenCodeApiPrefix() {},
    waitForReady: async () => true,
    managedStartupTimeoutMs: 5000,
    listBusySessionIds: () => busy.current,
    spawnProcess: realSpawn,
    spawnSyncProcess: realSpawnSync,
    onOpenCodeHandoff: (predecessor) => {
      handoffs.push(predecessor);
      return () => {};
    },
  });
  const spawnedPids = async () => (await fsp.readFile(markerPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
  const cleanup = async (runtime, streams) => {
    for (const stream of streams) await stream.cancel();
    await runtime.closeDrainingOpenCode();
    for (const pid of (await spawnedPids()).reverse()) {
      if (alive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
    await fsp.rm(root, { recursive: true, force: true });
  };
  return { root, binary, busy, handoffs, state, createRuntime, spawnedPids, cleanup };
};

const readState = (root) => JSON.parse(fs.readFileSync(path.join(root, 'managed-opencode', 'state.json'), 'utf8'));
const portOf = (server) => Number(new URL(server.url).port);

describe('OpenCode handoff with real children', () => {
  let previousGrace;
  afterEach(() => {
    if (previousGrace === undefined) delete process.env.OPENCHAMBER_OPENCODE_DRAIN_GRACE_MS;
    else process.env.OPENCHAMBER_OPENCODE_DRAIN_GRACE_MS = previousGrace;
  });

  it('keeps the replaced OpenCode and its open event stream until its busy session goes idle', async () => {
    previousGrace = process.env.OPENCHAMBER_OPENCODE_DRAIN_GRACE_MS;
    process.env.OPENCHAMBER_OPENCODE_DRAIN_GRACE_MS = '600000';
    const fixture = await createFixture({ busySessionIds: ['ses_a'] });
    const previousRegistry = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = path.join(fixture.root, 'registry');
    const runtime = fixture.createRuntime();
    const streams = [];
    try {
      const first = await runtime.startOpenCode();
      fixture.state.openCodeProcess = first;
      const oldPort = portOf(first);
      const oldStream = await openStream(oldPort);
      streams.push(oldStream);
      await waitFor(() => oldStream.events() >= 2);

      const nextBinary = path.join(fixture.root, 'opencode-next');
      fs.symlinkSync(process.execPath, nextBinary);
      fixture.binary.current = nextBinary;

      expect(await runtime.reloadOpenCode()).toBe(true);
      const current = fixture.state.openCodeProcess;
      expect(current.pid).not.toBe(first.pid);
      const saved = readState(fixture.root);
      expect(saved.pid).toBe(current.pid);
      expect(saved.binary).toBe(nextBinary);
      expect(saved.port).not.toBe(oldPort);
      expect(fixture.handoffs.map((entry) => entry.url)).toEqual([`http://127.0.0.1:${oldPort}`]);

      const draining = readDrainingOpenCodeRecords(path.join(fixture.root, 'managed-opencode', 'draining.json'));
      expect(draining.map((record) => record.pid)).toEqual([first.pid]);
      expect(alive(first.pid)).toBe(true);

      const before = oldStream.events();
      await waitFor(() => oldStream.events() > before + 2, 3000);
      expect(oldStream.ended()).toBe(false);

      const newInfo = await fetch(`${current.url}/api/info`);
      expect(newInfo.ok).toBe(true);

      fixture.busy.current = [];
      await waitFor(() => !alive(first.pid), 6000);
      await waitFor(() => oldStream.ended(), 3000);
      expect(readDrainingOpenCodeRecords(path.join(fixture.root, 'managed-opencode', 'draining.json'))).toEqual([]);
      expect(alive(current.pid)).toBe(true);
    } finally {
      await fixture.cleanup(runtime, streams);
      if (previousRegistry === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
      else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = previousRegistry;
    }
  }, 30_000);

  it('does not restart OpenCode on a reload when the binary and arguments are unchanged', async () => {
    const fixture = await createFixture();
    const previousRegistry = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = path.join(fixture.root, 'registry');
    const runtime = fixture.createRuntime();
    try {
      const first = await runtime.startOpenCode();
      fixture.state.openCodeProcess = first;
      const pidBefore = readState(fixture.root).pid;

      expect(await runtime.reloadOpenCode()).toBe(false);

      expect(await fixture.spawnedPids()).toEqual([first.pid]);
      expect(readState(fixture.root).pid).toBe(pidBefore);
      expect(fixture.handoffs).toEqual([]);
      expect(alive(first.pid)).toBe(true);
    } finally {
      await fixture.cleanup(runtime, []);
      if (previousRegistry === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
      else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = previousRegistry;
    }
  }, 30_000);

  it('adopts the running OpenCode after an OpenChamber restart instead of spawning a second one', async () => {
    const fixture = await createFixture();
    const previousRegistry = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = path.join(fixture.root, 'registry');
    const first = fixture.createRuntime();
    let second = null;
    try {
      const running = await first.startOpenCode();
      const pid = running.pid;
      const port = portOf(running);

      const restarted = fixture.createRuntime({ openCodeWorkingDirectory: fixture.root, useWslForOpencode: false });
      second = await restarted.startOpenCode();

      expect(second.pid).toBe(pid);
      expect(portOf(second)).toBe(port);
      expect(await fixture.spawnedPids()).toEqual([pid]);
      expect(fixture.handoffs).toEqual([]);
      expect(alive(pid)).toBe(true);
    } finally {
      await second?.close();
      await fixture.cleanup(first, []);
      if (previousRegistry === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
      else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = previousRegistry;
    }
  }, 30_000);
});
