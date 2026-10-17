/** Routing failures shared by the generated client and narrow SDK-gap adapters. */
export class RuntimeRoutingResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'RuntimeRoutingResponseError'
  }
}

export const validateRuntimeResponse = (response: Response): Response => {
  const unavailable = response.headers.get('x-openchamber-error') === 'runtime-unavailable'
  const html = response.ok && (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')
  if (!unavailable && !html) return response
  void response.body?.cancel().catch(() => undefined)
  throw new RuntimeRoutingResponseError(response.status, unavailable
    ? 'runtime_unavailable'
    : 'the runtime returned a web page instead of an API response')
}
