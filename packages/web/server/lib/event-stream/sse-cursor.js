// The resume cursor of one proxied SSE stream: the `id:` of the last complete block the proxy
// forwarded. The id is opaque here. OpenCode decides what it means (`<instance>:<sequence>`, per
// packages/server/src/event-feed.ts), and OpenChamber only hands it back as Last-Event-ID when the
// upstream connection is re-established.
//
// Per the SSE spec an `id:` line sets the last event id, even to an empty value, so a block
// carrying an empty `id:` clears the cursor. A `server.resync` block says the cursor is no longer
// usable (OpenCode did not know the id, or it came from another instance): the client has to
// refetch. OpenCode sends it with the head id of its own feed, so the cursor restarts there.

export const SSE_RESYNC_PAYLOAD_TYPE = 'server.resync';

export function parseSseBlock(block) {
  let id;
  let event;
  const data = [];
  for (const line of block.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'id') id = value;
    else if (name === 'event') event = value;
    else if (name === 'data') data.push(value);
  }
  return { id, event, data: data.join('\n') };
}

export function isResyncBlock({ data }) {
  if (!data.includes(SSE_RESYNC_PAYLOAD_TYPE)) return false;
  try {
    return JSON.parse(data)?.type === SSE_RESYNC_PAYLOAD_TYPE;
  } catch {
    return false;
  }
}

export function createSseCursor(initialLastEventId = '') {
  let lastEventId = initialLastEventId;
  let pending = '';

  return {
    lastEventId() {
      return lastEventId;
    },
    // Feeds decoded text and returns the complete blocks it closed, in stream order. Text that
    // does not end a block is held until the next call.
    observe(text) {
      pending = `${pending}${text}`.replace(/\r\n/g, '\n');
      const blocks = [];
      for (let end = pending.indexOf('\n\n'); end !== -1; end = pending.indexOf('\n\n')) {
        const block = parseSseBlock(pending.slice(0, end));
        pending = pending.slice(end + 2);
        if (block.id !== undefined) lastEventId = block.id;
        const resync = isResyncBlock(block);
        if (resync && block.id === undefined) lastEventId = '';
        blocks.push({ ...block, resync });
      }
      return blocks;
    },
  };
}
