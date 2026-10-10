import { beforeEach, describe, expect, test } from 'bun:test';

import type { RelayTunnelWebSocket } from './relay/tunnel-client';
import {
  buildPersistentPtyConnectPath,
  encodePersistentPtyInputFrame,
  openPersistentPtyInput,
} from './persistentPtyInput';
import { configureRuntimeUrlResolver } from './runtime-url';

const decode = (frame: Uint8Array) => {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    type: view.getUint8(0),
    cols: view.getUint16(1),
    rows: view.getUint16(3),
    payload: new TextDecoder().decode(frame.subarray(5)),
  };
};

interface FakeSocket extends RelayTunnelWebSocket {
  readyState: number;
  open(): void;
  deliver(data: string | ArrayBuffer): void;
}

const fakeSocket = () => {
  const sent: Uint8Array[] = [];
  const socket: FakeSocket = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data) {
      if (typeof data === 'string') throw new Error('expected framed binary input');
      sent.push(ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data));
    },
    close() {
      socket.readyState = 3;
    },
    open() {
      socket.readyState = 1;
    },
    deliver(data) {
      socket.onmessage?.({ data });
    },
  };
  return { socket, sent };
};

describe('encodePersistentPtyInputFrame', () => {
  test('writes the input type and big-endian size before the payload', () => {
    const decoded = decode(encodePersistentPtyInputFrame('ls\r', { cols: 120, rows: 40 }));
    expect(decoded).toEqual({ type: 1, cols: 120, rows: 40, payload: 'ls\r' });
  });

  test('clamps dimensions to the 16-bit range the server reads', () => {
    const decoded = decode(encodePersistentPtyInputFrame('', { cols: 0, rows: 70000 }));
    expect(decoded.cols).toBe(1);
    expect(decoded.rows).toBe(0xffff);
  });

  test('encodes multibyte text as UTF-8', () => {
    const decoded = decode(encodePersistentPtyInputFrame('é', { cols: 80, rows: 24 }));
    expect(decoded.payload).toBe('é');
  });
});

describe('buildPersistentPtyConnectPath', () => {
  test('escapes the terminal id', () => {
    expect(buildPersistentPtyConnectPath('pty a/b')).toBe('/api/experimental/persistent-pty/pty%20a%2Fb/connect');
  });
});

describe('openPersistentPtyInput', () => {
  beforeEach(() => {
    configureRuntimeUrlResolver({ currentHref: () => 'http://localhost:3000/' });
  });

  test('holds input until replay completes, then flushes it in order', () => {
    const { socket, sent } = fakeSocket();
    const urls: string[] = [];
    const channel = openPersistentPtyInput({
      ptyID: 'pty_1',
      directory: '/work/project',
      size: { cols: 100, rows: 30 },
      openSocket: (url) => {
        urls.push(url);
        return socket;
      },
    });

    expect(urls[0]).toContain('/api/experimental/persistent-pty/pty_1/connect');
    expect(urls[0]).toContain('role=controller');
    expect(urls[0]).toContain('input_protocol=1');
    expect(urls[0]).toContain('location%5Bdirectory%5D=%2Fwork%2Fproject');

    socket.open();
    expect(channel.send('first')).toBe(true);
    channel.send('second');
    expect(sent).toHaveLength(0);

    socket.deliver(new Uint8Array([1, 2, 3]).buffer);
    socket.deliver(JSON.stringify({ type: 'attached' }));
    expect(sent).toHaveLength(0);

    socket.deliver(JSON.stringify({ type: 'replay_complete', endOffset: 0 }));
    expect(sent.map((frame) => decode(frame).payload)).toEqual(['first', 'second']);

    channel.send('third');
    expect(sent.map((frame) => decode(frame).payload)).toEqual(['first', 'second', 'third']);
  });

  test('reports close and refuses further input', () => {
    const { socket } = fakeSocket();
    let closed = 0;
    const channel = openPersistentPtyInput({
      ptyID: 'pty_2',
      directory: null,
      size: { cols: 80, rows: 24 },
      onClose: (code) => { closed += 1; expect(code).toBe(4404); },
      openSocket: () => socket,
    });

    socket.onclose?.({ code: 4404, reason: 'terminal unavailable', wasClean: true });
    expect(closed).toBe(1);
    expect(channel.isOpen).toBe(false);
    expect(channel.send('x')).toBe(false);
  });
});
