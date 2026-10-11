import type { RelayTunnelWebSocket } from "@/lib/relay/tunnel-client"

/** A relay tunnel socket the test drives by hand: the test delivers frames through `onmessage`. */
export function createFakeSocket(): RelayTunnelWebSocket {
  let readyState = 1
  return {
    get readyState() { return readyState },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: () => undefined,
    close: () => { readyState = 3 },
  }
}
