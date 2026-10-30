import { renameWithRetry } from '../shared/atomic-rename.js';

export const createManagedTunnelConfigRuntime = (deps) => {
  const {
    fsPromises,
    path,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    constants,
  } = deps;

  const {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
  } = constants;

  let persistManagedRemoteTunnelConfigLock = Promise.resolve();

  // Chain on both outcomes: one failed persist must not wedge every later
  // update behind a rejected lock promise.
  const enqueuePersistLock = (fn) => {
    persistManagedRemoteTunnelConfigLock = persistManagedRemoteTunnelConfigLock.then(fn, fn);
    return persistManagedRemoteTunnelConfigLock;
  };

  const emptyConfig = () => ({ version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] });

  const isEnoent = (error) => Boolean(error) && typeof error === 'object' && error.code === 'ENOENT';

  const sanitizeManagedRemoteTunnelConfigEntries = (value) => {
    if (!Array.isArray(value)) {
      return [];
    }

    const result = [];
    const seenIds = new Set();
    const seenHostnames = new Set();
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const hostname = normalizeManagedRemoteTunnelHostname(entry.hostname);
      const token = typeof entry.token === 'string' ? entry.token.trim() : '';
      const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now();

      if (!id || !name || !hostname || !token) {
        continue;
      }
      if (seenIds.has(id) || seenHostnames.has(hostname)) {
        continue;
      }

      seenIds.add(id);
      seenHostnames.add(hostname);
      result.push({ id, name, hostname, token, updatedAt });
    }

    return result;
  };

  // A torn or otherwise unparseable config file holds tunnel tokens, not an
  // empty store: move its bytes aside before any later write can overwrite
  // them, and name the preserved copy so the loss is recoverable. The suffix
  // is collision-proof (pid + random, existence-checked): rename would
  // silently replace an earlier preserved copy on a bare-timestamp collision.
  const preserveCorruptFile = async (error) => {
    let preservedPath = null;
    for (let attempt = 0; attempt < 10 && preservedPath === null; attempt += 1) {
      const candidate = `${CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH}.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await fsPromises.stat(candidate);
      } catch {
        preservedPath = candidate;
      }
    }
    if (preservedPath === null) {
      console.warn('Failed to read managed remote tunnel config file:', error);
      console.warn('Failed to preserve the unreadable managed remote tunnel config file: every preserved-file name collided');
      return false;
    }
    try {
      await renameWithRetry((from, to) => fsPromises.rename(from, to), CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, preservedPath);
      console.warn(`Failed to read managed remote tunnel config file: preserved the unreadable file at ${preservedPath}:`, error);
      return true;
    } catch (preserveError) {
      console.warn('Failed to read managed remote tunnel config file:', error);
      console.warn(`Failed to preserve the unreadable managed remote tunnel config file at ${preservedPath}:`, preserveError);
      return false;
    }
  };

  const configFromRaw = (raw) => {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Managed remote tunnel config file does not contain a config object');
    }
    return {
      version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
      tunnels: sanitizeManagedRemoteTunnelConfigEntries(parsed.tunnels),
    };
  };

  const readRawConfigFile = async () => {
    try {
      return { raw: await fsPromises.readFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, 'utf8') };
    } catch (error) {
      return { error };
    }
  };

  const writeManagedRemoteTunnelConfigToDisk = async (data) => {
    await fsPromises.mkdir(path.dirname(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH), { recursive: true });
    const tempPath = `${CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await fsPromises.writeFile(tempPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
      await renameWithRetry((from, to) => fsPromises.rename(from, to), tempPath, CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH);
    } catch (error) {
      try {
        await fsPromises.unlink(tempPath);
      } catch {
        // The write/rename error is the one the caller needs; a failed temp
        // cleanup must not mask it.
      }
      throw error;
    }
  };

  const migrateManagedRemoteTunnelConfigFromLegacyFile = async () => {
    try {
      const legacyRaw = await fsPromises.readFile(CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(legacyRaw);
      const tunnels = sanitizeManagedRemoteTunnelConfigEntries(parsed?.tunnels);
      const migrated = {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels,
      };
      await writeManagedRemoteTunnelConfigToDisk(migrated);
      return migrated;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
      }
      console.warn('Failed to migrate legacy named tunnel config file:', error);
      return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
    }
  };

  const readManagedRemoteTunnelConfigFromDisk = async () => {
    const { raw, error } = await readRawConfigFile();
    if (error) {
      if (isEnoent(error)) {
        return migrateManagedRemoteTunnelConfigFromLegacyFile();
      }
      console.warn('Failed to read managed remote tunnel config file:', error);
      return emptyConfig();
    }
    try {
      return configFromRaw(raw);
    } catch (parseError) {
      // The bytes above are stale the moment the read returns: a concurrent
      // update may already have preserved the corrupt file and saved valid
      // state in its place, and renaming the path now would move that saved
      // state aside. Re-validate under the persist lock before preserving
      // anything; if an update landed in between, its state is the answer.
      return enqueuePersistLock(async () => {
        const current = await readRawConfigFile();
        if (current.error) {
          if (isEnoent(current.error)) {
            return migrateManagedRemoteTunnelConfigFromLegacyFile();
          }
          console.warn('Failed to read managed remote tunnel config file:', current.error);
          return emptyConfig();
        }
        if (current.raw !== raw) {
          try {
            return configFromRaw(current.raw);
          } catch {
            // Still corrupt under the lock: preserve those bytes below.
          }
        }
        await preserveCorruptFile(parseError);
        return emptyConfig();
      });
    }
  };

  // Read on the update path, already serialized under the persist lock: a
  // corrupt file is preserved before the mutation overwrites it, and if it
  // cannot be preserved the update refuses rather than discarding tokens.
  const readConfigForUpdate = async () => {
    const { raw, error } = await readRawConfigFile();
    if (error) {
      if (isEnoent(error)) {
        return migrateManagedRemoteTunnelConfigFromLegacyFile();
      }
      console.warn('Failed to read managed remote tunnel config file:', error);
      return emptyConfig();
    }
    try {
      return configFromRaw(raw);
    } catch (parseError) {
      const preserved = await preserveCorruptFile(parseError);
      if (!preserved) {
        throw new Error(
          `Refusing to overwrite the unreadable managed remote tunnel config file at ${CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH}: it could not be preserved`,
          { cause: parseError },
        );
      }
      return emptyConfig();
    }
  };

  const updateManagedRemoteTunnelConfig = async (mutate) =>
    enqueuePersistLock(async () => {
      const current = await readConfigForUpdate();
      const next = mutate({
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(current.tunnels),
      });

      await writeManagedRemoteTunnelConfigToDisk({
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(next?.tunnels),
      });
    });

  const syncManagedRemoteTunnelConfigWithPresets = async (presets) => {
    const sanitizedPresets = normalizeManagedRemoteTunnelPresets(presets) || [];

    await updateManagedRemoteTunnelConfig((current) => {
      const byId = new Map(current.tunnels.map((entry) => [entry.id, entry]));
      const byHostname = new Map(current.tunnels.map((entry) => [entry.hostname, entry]));

      const nextTunnels = [];
      for (const preset of sanitizedPresets) {
        const existing = byId.get(preset.id) || byHostname.get(preset.hostname) || null;
        if (!existing) {
          continue;
        }

        nextTunnels.push({
          ...existing,
          id: preset.id,
          name: preset.name,
          hostname: preset.hostname,
        });
      }

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: nextTunnels,
      };
    });
  };

  const upsertManagedRemoteTunnelToken = async ({ id, name, hostname, token }) => {
    if (typeof id !== 'string' || typeof name !== 'string' || typeof hostname !== 'string' || typeof token !== 'string') {
      return;
    }
    const normalizedId = id.trim();
    const normalizedName = name.trim();
    const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
    const normalizedToken = token.trim();
    if (!normalizedId || !normalizedName || !normalizedHostname || !normalizedToken) {
      return;
    }

    await updateManagedRemoteTunnelConfig((current) => {
      const withoutConflicts = current.tunnels.filter((entry) => entry.id !== normalizedId && entry.hostname !== normalizedHostname);
      withoutConflicts.push({
        id: normalizedId,
        name: normalizedName,
        hostname: normalizedHostname,
        token: normalizedToken,
        updatedAt: Date.now(),
      });

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: withoutConflicts,
      };
    });
  };

  const resolveManagedRemoteTunnelToken = async ({ presetId, hostname }) => {
    const normalizedPresetId = typeof presetId === 'string' ? presetId.trim() : '';
    const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
    const config = await readManagedRemoteTunnelConfigFromDisk();

    if (normalizedPresetId) {
      const byId = config.tunnels.find((entry) => entry.id === normalizedPresetId);
      if (byId?.token) {
        return byId.token;
      }
    }

    if (normalizedHostname) {
      const byHostname = config.tunnels.find((entry) => entry.hostname === normalizedHostname);
      if (byHostname?.token) {
        return byHostname.token;
      }
    }

    return '';
  };

  return {
    readManagedRemoteTunnelConfigFromDisk,
    syncManagedRemoteTunnelConfigWithPresets,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelToken,
  };
};
