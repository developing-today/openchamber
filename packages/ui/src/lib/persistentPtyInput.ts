import { openRuntimeWebSocket } from './relay/runtime-socket';
import type { RelayTunnelWebSocket } from './relay/tunnel-client';
import { getRuntimeUrlResolver } from './runtime-url';

const FRAME_HEADER_BYTES = 5;
const INPUT_FRAME_TYPE = 1;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;
const MAX_TERMINAL_DIMENSION = 0xffff;

interface PersistentPtySize {
  cols: number;
  rows: number;
}

export interface PersistentPtyInputChannel {
  readonly isOpen: boolean;
  send(text: string): boolean;
  close(): void;
}

interface OpenPersistentPtyInputOptions {
  ptyID: string;
  directory: string | null | undefined;
  size: PersistentPtySize;
  onClose?: (code: number) => void;
  openSocket?: (url: string) => RelayTunnelWebSocket;
}

const clampDimension = (value: number): number => Math.min(MAX_TERMINAL_DIMENSION, Math.max(1, Math.floor(value)));

export const encodePersistentPtyInputFrame = (text: string, size: PersistentPtySize): Uint8Array => {
  const payload = new TextEncoder().encode(text);
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, INPUT_FRAME_TYPE);
  view.setUint16(1, clampDimension(size.cols));
  view.setUint16(3, clampDimension(size.rows));
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
};

export const buildPersistentPtyConnectPath = (ptyID: string): string =>
  `/api/experimental/persistent-pty/${encodeURIComponent(ptyID)}/connect`;

const isReplayComplete = (data: string | ArrayBuffer): boolean => {
  if (typeof data !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null && 'type' in parsed && parsed.type === 'replay_complete';
  } catch {
    return false;
  }
};

/**
 * A controller attachment to one persistent PTY, used only to type into it.
 * Output the server replays or streams is discarded: the terminal view reads
 * snapshots. Input waits for `replay_complete`, because the server drops input
 * that arrives before the attachment is active.
 */
export const openPersistentPtyInput = ({
  ptyID,
  directory,
  size,
  onClose,
  openSocket = openRuntimeWebSocket,
}: OpenPersistentPtyInputOptions): PersistentPtyInputChannel => {
  const query = directory
    ? { role: 'controller', input_protocol: '1', 'location[directory]': directory }
    : { role: 'controller', input_protocol: '1' };
  const url = getRuntimeUrlResolver().websocket(buildPersistentPtyConnectPath(ptyID), query);
  const socket = openSocket(url);

  let ready = false;
  let closed = false;
  const pending: string[] = [];

  const finish = (code: number) => {
    if (closed) return;
    closed = true;
    pending.length = 0;
    onClose?.(code);
  };

  const flush = () => {
    while (pending.length > 0 && socket.readyState === SOCKET_OPEN) {
      socket.send(encodePersistentPtyInputFrame(pending.shift() ?? '', size));
    }
  };

  socket.onmessage = (event) => {
    if (ready || !isReplayComplete(event.data)) return;
    ready = true;
    flush();
  };
  socket.onclose = (event) => finish(event.code);
  socket.onerror = () => finish(1006);

  return {
    get isOpen() {
      return !closed && socket.readyState !== SOCKET_CLOSING && socket.readyState !== SOCKET_CLOSED;
    },
    send(text) {
      if (closed) return false;
      pending.push(text);
      if (ready) flush();
      return true;
    },
    close() {
      if (closed) return;
      socket.close(1000);
      finish(1000);
    },
  };
};
