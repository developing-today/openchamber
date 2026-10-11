import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// The systemd socket unit holds 127.0.0.1:<port> for the life of the service and never accepts on it.
// listener-holder.fixture.py stands in for that unit: it holds the listening socket, starts and stops
// the service with the socket as fd 3, and sets LISTEN_FDS and LISTEN_PID as systemd does.
const here = path.dirname(fileURLToPath(import.meta.url));
const holderPath = path.join(here, 'listener-holder.fixture.py');
const fixturePath = path.join(here, 'listener-service.fixture.mjs');

const hasPython = spawnSync('python3', ['--version']).status === 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A fresh connection per request, so a stopped service's pooled socket cannot answer for its successor.
const requestPid = (port) => new Promise((resolve, reject) => {
  const request = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => resolve(JSON.parse(body).pid));
  });
  request.once('error', reject);
});

const startHolder = async () => {
  const child = spawn('python3', [holderPath, fixturePath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: child.stdout });
  const nextLine = () => new Promise((resolve) => lines.once('line', resolve));
  const portLine = await nextLine();
  const port = Number(portLine.replace(/^port /, ''));
  const command = async (name) => {
    const reply = nextLine();
    child.stdin.write(`${name}\n`);
    const line = await reply;
    return Number(line.split(' ')[1]);
  };
  return {
    port,
    start: () => command('start'),
    stop: () => command('stop'),
    close: async () => {
      child.stdin.write('quit\n');
      await new Promise((resolve) => child.once('exit', resolve));
      lines.close();
    },
  };
};

describe.skipIf(!hasPython)('listener handoff through socket activation', () => {
  let holder = null;

  afterEach(async () => {
    await holder?.close();
    holder = null;
  });

  it('serves on the socket the unit holds, inherited as fd 3 with LISTEN_PID naming the service', async () => {
    holder = await startHolder();
    const servicePid = await holder.start();

    expect(await requestPid(holder.port)).toBe(servicePid);
  });

  it('queues a request that arrives while no service is accepting, and the successor answers it', async () => {
    holder = await startHolder();
    const firstPid = await holder.start();
    expect(await requestPid(holder.port)).toBe(firstPid);

    // The old service stops. The holder still owns the socket, so a request made now waits in the
    // kernel's accept backlog instead of being refused.
    await holder.stop();
    let settled = false;
    const during = requestPid(holder.port).finally(() => { settled = true; });
    await sleep(300);
    expect(settled).toBe(false);

    const successorPid = await holder.start();
    expect(await during).toBe(successorPid);
    expect(successorPid).not.toBe(firstPid);
  });

  it('keeps the port held across a stop and start, so a connect never meets a closed port', async () => {
    holder = await startHolder();
    await holder.start();
    await holder.stop();

    // Nothing accepts now, but a plain TCP connect still completes: the listening socket is still open.
    const connected = await new Promise((resolve, reject) => {
      const socket = net.connect(holder.port, '127.0.0.1', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', reject);
    });
    expect(connected).toBe(true);

    const successorPid = await holder.start();
    expect(await requestPid(holder.port)).toBe(successorPid);
  });
});
