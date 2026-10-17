export const resolveStartupUrlProbePlan = ({ development, packagedUi, skipLocalServer }) => ({
  probeHmrApi: development === true && packagedUi !== true && skipLocalServer !== true,
  probeHmrUi: development === true && packagedUi !== true,
});

export const shouldIgnoreLoopbackConnectionLimit = ({ development, packagedUi }) => (
  development !== true || packagedUi === true
);

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The server this app should treat as its own Local server when it starts none
 * itself (OPENCHAMBER_SKIP_LOCAL_SERVER=1): an OPENCHAMBER_SERVER_URL on this
 * machine's loopback interface, e.g. an `openchamber serve` run by a service
 * manager for the same user. Returns its origin, or null for any other target.
 */
export const resolveAttachedLocalServerUrl = ({ skipLocalServer, serverUrl }) => {
  if (skipLocalServer !== true || typeof serverUrl !== 'string' || !serverUrl.trim()) return null;
  let parsed;
  try {
    parsed = new URL(serverUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // A sub-path deployment is a proxy in front of a server, not this machine's own.
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return null;
  return parsed.origin;
};
