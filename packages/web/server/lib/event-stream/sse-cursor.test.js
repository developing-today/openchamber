import { describe, expect, it } from 'vitest';

import { createSseCursor, isResyncBlock, parseSseBlock } from './sse-cursor.js';

describe('SSE cursor', () => {
  it('tracks the id of the last complete block and reports every block in order', () => {
    const cursor = createSseCursor();

    const blocks = cursor.observe('id: ws:1\ndata: {"n":1}\n\nid: ws:2\ndata: {"n":2}\n\n');

    expect(blocks.map((block) => [block.id, block.data])).toEqual([
      ['ws:1', '{"n":1}'],
      ['ws:2', '{"n":2}'],
    ]);
    expect(cursor.lastEventId()).toBe('ws:2');
  });

  it('holds a block that is split across chunks until its boundary arrives', () => {
    const cursor = createSseCursor('ws:0');

    expect(cursor.observe('id: ws:1\ndata: {"n"')).toEqual([]);
    expect(cursor.lastEventId()).toBe('ws:0');

    const blocks = cursor.observe(':1}\n\n');
    expect(blocks.map((block) => block.data)).toEqual(['{"n":1}']);
    expect(cursor.lastEventId()).toBe('ws:1');
  });

  it('does not move the cursor on a block without an id, such as a heartbeat comment', () => {
    const cursor = createSseCursor('ws:4');

    cursor.observe(':heartbeat\n\ndata: {"n":5}\n\n');

    expect(cursor.lastEventId()).toBe('ws:4');
  });

  it('joins a CRLF pair split across chunks, so a boundary is not missed', () => {
    const cursor = createSseCursor();

    cursor.observe('id: ws:1\r\ndata: x\r');
    const blocks = cursor.observe('\n\r\n');

    expect(blocks).toHaveLength(1);
    expect(cursor.lastEventId()).toBe('ws:1');
  });

  it('clears the cursor on an empty id, as the SSE spec does', () => {
    const cursor = createSseCursor('ws:3');

    cursor.observe('id:\ndata: reset\n\n');

    expect(cursor.lastEventId()).toBe('');
  });

  it('restarts the cursor from the head id that OpenCode puts on its server.resync frame', () => {
    const cursor = createSseCursor('inst1:9');

    const [block] = cursor.observe('id: inst2:0\ndata: {"id":"evt_1","type":"server.resync","data":{}}\n\n');

    expect(block.resync).toBe(true);
    expect(cursor.lastEventId()).toBe('inst2:0');
  });

  it('restarts the cursor from nothing when a resync frame carries no id', () => {
    const cursor = createSseCursor('ws:3');

    const [block] = cursor.observe('data: {"type":"server.resync","data":{}}\n\n');

    expect(block.resync).toBe(true);
    expect(cursor.lastEventId()).toBe('');
  });

  it('starts from the id the browser already holds', () => {
    expect(createSseCursor('ws:7').lastEventId()).toBe('ws:7');
  });
});

describe('SSE block parsing', () => {
  it('reads id, event and data fields, joining multi-line data', () => {
    expect(parseSseBlock('id: a:1\nevent: message\ndata: one\ndata: two')).toEqual({
      id: 'a:1',
      event: 'message',
      data: 'one\ntwo',
    });
  });

  it('recognises only the server.resync payload type, as OpenCode sends it', () => {
    expect(isResyncBlock({ event: undefined, data: '{"id":"evt_1","type":"server.resync","data":{}}' })).toBe(true);
    expect(isResyncBlock({ event: undefined, data: '{"type":"session.updated"}' })).toBe(false);
    expect(isResyncBlock({ event: undefined, data: '{"type":"server.resync_required"}' })).toBe(false);
    expect(isResyncBlock({ event: 'resync', data: '' })).toBe(false);
    expect(isResyncBlock({ event: undefined, data: 'server.resync but not JSON' })).toBe(false);
  });
});
