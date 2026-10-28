// Managed-server registry read for external tooling (design #612 phase 2,
// issue #525).
//
// OpenChamber instances record every OpenCode server they spawn in the
// managed-process registry, one file per process. This module turns those
// records, plus the hosting instance's own lifecycle state, into the
// GET /api/managed-servers response. Discovery comes from the registry
// alone: liveness is a signal-0 probe of a pid the registry already
// recorded, the same check the orphan reaper uses, and no process table
// is ever scanned for servers nobody recorded.
//
// The projection is an explicit allowlist. A server entry carries exactly
// the keys built below, in this order, and nothing else: the managed
// state file holds the managed password and the agent-tool token, and
// neither those nor the launch fingerprint, args, binary, or owner pid
// may reach this read. Unknown fields are null, never a fabricated value:
// a server this instance cannot verify reports status "unknown".

const isText = (value) => Object.prototype.toString.call(value) === '[object String]';
const textOrNull = (value) => (isText(value) && value.length > 0 ? value : null);
const portOrNull = (value) => (Number.isInteger(value) && value > 0 ? value : null);
const countOrNull = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/**
 * Build the { version, serverTime, servers } response.
 *
 * - registryEntries: records from the managed-process registry reader
 *   ({ pid, port, startedAt } are the only fields read).
 * - drainingRecords: records from the draining registry readers; a pid
 *   listed here is a replaced server still finishing its sessions.
 * - own: this instance's own server, or null when it manages none:
 *   { pid, port, directory, version, ready, startedAt, sessionCount }.
 * - isPidAlive: signal-0 liveness for a recorded pid. An entry whose pid
 *   is gone leaves the list, so a stopped server disappears on the next
 *   read instead of lingering as a zombie.
 */
export const buildManagedServersResponse = ({ registryEntries = [], drainingRecords = [], own = null, isPidAlive = () => true, now = Date.now() } = {}) => {
  const byPid = new Map();

  for (const entry of Array.isArray(registryEntries) ? registryEntries : []) {
    if (!Number.isInteger(entry?.pid)) continue;
    byPid.set(entry.pid, {
      pid: entry.pid,
      port: portOrNull(entry.port),
      directory: null,
      version: null,
      status: 'unknown',
      startedAt: textOrNull(entry.startedAt),
      sessionCount: null,
    });
  }

  for (const record of Array.isArray(drainingRecords) ? drainingRecords : []) {
    if (!Number.isInteger(record?.pid)) continue;
    const existing = byPid.get(record.pid);
    if (existing) {
      existing.status = 'draining';
      if (existing.port === null) existing.port = portOrNull(record.port);
    } else {
      byPid.set(record.pid, {
        pid: record.pid,
        port: portOrNull(record.port),
        directory: null,
        version: null,
        status: 'draining',
        startedAt: null,
        sessionCount: null,
      });
    }
  }

  if (own && Number.isInteger(own.pid)) {
    const existing = byPid.get(own.pid);
    byPid.set(own.pid, {
      pid: own.pid,
      port: portOrNull(own.port) ?? existing?.port ?? null,
      directory: textOrNull(own.directory),
      version: textOrNull(own.version),
      status: existing?.status === 'draining' ? 'draining' : (own.ready ? 'ready' : 'starting'),
      startedAt: textOrNull(own.startedAt) ?? existing?.startedAt ?? null,
      sessionCount: countOrNull(own.sessionCount),
    });
  }

  const servers = [...byPid.values()]
    .filter((server) => isPidAlive(server.pid))
    .sort((left, right) => left.pid - right.pid);

  return { version: 1, serverTime: now, servers };
};
