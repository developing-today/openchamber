import { renameWithRetry } from '../shared/atomic-rename.js';
import { sessionKeyFor, withHashedSessionKeys } from './session-key.js';

const PUSH_SUBSCRIPTIONS_VERSION = 1;
const UI_VISIBILITY_TTL_MS = 30_000;

const isLoopbackHttpOrigin = (value) => {
  if (typeof value !== 'string') {
    return false;
  }

  return value.startsWith('http://localhost')
    || value.startsWith('http://127.0.0.1')
    || value.startsWith('http://[::1]');
};

export const createPushRuntime = (deps) => {
  const {
    fsPromises,
    path,
    // Resolves the web-push module; it is loaded on first use, not with the server.
    loadWebPush,
    PUSH_SUBSCRIPTIONS_FILE_PATH,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
  } = deps;

  let persistPushSubscriptionsLock = Promise.resolve();
  let pushInitialized = false;
  let legacyKeysScrubQueued = false;

  const uiVisibilityByToken = new Map();
  const pruneUiVisibility = (now = Date.now()) => {
    for (const [token, state] of uiVisibilityByToken) {
      if (!state || now - state.updatedAt > UI_VISIBILITY_TTL_MS) {
        uiVisibilityByToken.delete(token);
      }
    }
  };

  // A torn or otherwise unparseable file is subscription state, not an
  // empty store: move its bytes aside before any later write can overwrite
  // them, and name the preserved copy so the loss is recoverable.
  const preserveCorruptPushSubscriptionsFile = async (error) => {
    const preservedPath = `${PUSH_SUBSCRIPTIONS_FILE_PATH}.corrupt-${Date.now()}`;
    try {
      await renameWithRetry((from, to) => fsPromises.rename(from, to), PUSH_SUBSCRIPTIONS_FILE_PATH, preservedPath);
      console.warn(`Failed to read push subscriptions file: preserved the unreadable file at ${preservedPath}:`, error);
      return true;
    } catch (preserveError) {
      console.warn('Failed to read push subscriptions file:', error);
      console.warn(`Failed to preserve the unreadable push subscriptions file at ${preservedPath}:`, preserveError);
      return false;
    }
  };

  const handleCorruptPushSubscriptionsFile = async (error, { serialized = false } = {}) => {
    if (serialized) {
      // Already under the persist lock, so preserving inline cannot race
      // an in-process write. A mutation must never overwrite bytes whose
      // preservation just failed: abort instead; the caller can retry
      // once the file is movable.
      const preserved = await preserveCorruptPushSubscriptionsFile(error);
      if (!preserved) {
        throw new Error('Failed to preserve the unreadable push subscriptions file; refusing to overwrite it', { cause: error });
      }
      return;
    }
    // Unlocked reader (the send path): the bytes it read are stale the
    // moment the read returns — a concurrent persist may already have
    // preserved the corrupt file and saved valid state in its place, and
    // renaming the file now would move that saved state aside. Re-validate
    // under the persist lock before preserving anything.
    const run = async () => {
      let currentRaw;
      try {
        currentRaw = await fsPromises.readFile(PUSH_SUBSCRIPTIONS_FILE_PATH, 'utf8');
      } catch {
        return;
      }
      try {
        JSON.parse(currentRaw);
      } catch {
        await preserveCorruptPushSubscriptionsFile(error);
      }
    };
    persistPushSubscriptionsLock = persistPushSubscriptionsLock.then(run, run);
    await persistPushSubscriptionsLock;
  };

  const readPushSubscriptionsFromDisk = async ({ serialized = false } = {}) => {
    let raw;
    try {
      raw = await fsPromises.readFile(PUSH_SUBSCRIPTIONS_FILE_PATH, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
      }
      console.warn('Failed to read push subscriptions file:', error);
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      await handleCorruptPushSubscriptionsFile(error, { serialized });
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
    }
    try {
      if (!parsed || typeof parsed !== 'object') {
        return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
      }
      if (typeof parsed.version !== 'number' || parsed.version !== PUSH_SUBSCRIPTIONS_VERSION) {
        return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
      }

      const stored =
        parsed.subscriptionsBySession && typeof parsed.subscriptionsBySession === 'object'
          ? parsed.subscriptionsBySession
          : {};
      const { bySession: subscriptionsBySession, changed } = withHashedSessionKeys(stored);
      if (changed && !legacyKeysScrubQueued) {
        // Rewrite once so raw tokens leave the disk without waiting for the
        // next subscription change.
        legacyKeysScrubQueued = true;
        void persistPushSubscriptionUpdate((current) => current).catch((error) => {
          console.warn('Failed to rewrite push subscriptions with hashed keys:', error);
        });
      }

      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession };
    } catch (error) {
      console.warn('Failed to read push subscriptions file:', error);
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
    }
  };

  const writePushSubscriptionsToDisk = async (data) => {
    await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
    const tempPath = `${PUSH_SUBSCRIPTIONS_FILE_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await fsPromises.writeFile(tempPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
      await renameWithRetry((from, to) => fsPromises.rename(from, to), tempPath, PUSH_SUBSCRIPTIONS_FILE_PATH);
    } catch (error) {
      try {
        // rm is the current removal call; fall back to unlink for fs
        // shims that only implement the older surface.
        await (fsPromises.rm?.(tempPath, { force: true }) ?? fsPromises.unlink(tempPath));
      } catch {
        // The write/rename error is the one the caller needs; a failed
        // temp cleanup must not mask it.
      }
      throw error;
    }
  };

  const persistPushSubscriptionUpdate = async (mutate) => {
    const run = async () => {
      await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
      const current = await readPushSubscriptionsFromDisk({ serialized: true });
      const next = mutate({
        version: PUSH_SUBSCRIPTIONS_VERSION,
        subscriptionsBySession: current.subscriptionsBySession || {},
      });
      await writePushSubscriptionsToDisk(next);
      return next;
    };
    // The failing caller still sees the rejection through the returned
    // promise, but the queue itself must recover: chaining later updates
    // onto a rejected lock would wedge every subsequent registration and
    // removal behind one preservation failure (Codex, PR #890).
    const result = persistPushSubscriptionsLock.then(run, run);
    persistPushSubscriptionsLock = result.catch(() => {});
    return result;
  };

  const getOrCreateVapidKeys = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const existing = settings?.vapidKeys;
    if (existing && typeof existing.publicKey === 'string' && typeof existing.privateKey === 'string') {
      return { publicKey: existing.publicKey, privateKey: existing.privateKey };
    }

    const webPush = await loadWebPush();
    const generated = webPush.generateVAPIDKeys();
    const next = {
      ...settings,
      vapidKeys: {
        publicKey: generated.publicKey,
        privateKey: generated.privateKey,
      },
    };

    await writeSettingsToDisk(next);
    return { publicKey: generated.publicKey, privateKey: generated.privateKey };
  };

  const normalizePushSubscriptions = (record) => {
    if (!Array.isArray(record)) return [];
    return record
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const endpoint = entry.endpoint;
        const p256dh = entry.p256dh;
        const auth = entry.auth;
        if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
          return null;
        }
        return {
          endpoint,
          p256dh,
          auth,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
          platform: typeof entry.platform === 'string' ? entry.platform : undefined,
        };
      })
      .filter(Boolean);
  };

  const addOrUpdatePushSubscription = async (uiSessionToken, subscription, userAgent, platform) => {
    if (!uiSessionToken) {
      return;
    }
    const sessionKey = sessionKeyFor(uiSessionToken);

    await ensurePushInitialized();

    const now = Date.now();

    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      const existing = Array.isArray(subsBySession[sessionKey]) ? subsBySession[sessionKey] : [];

      const filtered = existing.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== subscription.endpoint);

      const previous = existing.find((entry) => entry && entry.endpoint === subscription.endpoint);
      filtered.unshift({
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        createdAt: now,
        lastSeenAt: now,
        userAgent: typeof userAgent === 'string' && userAgent.length > 0 ? userAgent : undefined,
        // Platform lets the sender route mobile PWA push through the same presence gate as APNs.
        platform:
          typeof platform === 'string' && platform
            ? platform
            : typeof previous?.platform === 'string'
              ? previous.platform
              : undefined,
      });

      subsBySession[sessionKey] = filtered.slice(0, 10);

      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const removePushSubscription = async (uiSessionToken, endpoint) => {
    if (!uiSessionToken || !endpoint) return;
    const sessionKey = sessionKeyFor(uiSessionToken);

    await ensurePushInitialized();

    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      const existing = Array.isArray(subsBySession[sessionKey]) ? subsBySession[sessionKey] : [];
      const filtered = existing.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== endpoint);
      if (filtered.length === 0) {
        delete subsBySession[sessionKey];
      } else {
        subsBySession[sessionKey] = filtered;
      }
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const removePushSubscriptionFromAllSessions = async (endpoint) => {
    if (!endpoint) return;

    await ensurePushInitialized();

    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      for (const [token, entries] of Object.entries(subsBySession)) {
        if (!Array.isArray(entries)) continue;
        const filtered = entries.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== endpoint);
        if (filtered.length === 0) {
          delete subsBySession[token];
        } else {
          subsBySession[token] = filtered;
        }
      }
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const sendPushToSubscription = async (sub, payload) => {
    await ensurePushInitialized();
    const body = JSON.stringify(payload);

    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
    };

    try {
      const webPush = await loadWebPush();
      await webPush.sendNotification(pushSubscription, body);
    } catch (error) {
      const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : null;
      if (statusCode === 410 || statusCode === 404) {
        await removePushSubscriptionFromAllSessions(sub.endpoint);
        return;
      }
      console.warn('[Push] Failed to send notification:', error);
    }
  };

  const sendPushToAllUiSessions = async (payload, options = {}) => {
    const requireNoSse = options.requireNoSse === true;
    const store = await readPushSubscriptionsFromDisk();
    const sessions = store.subscriptionsBySession || {};
    const subscriptionsByEndpoint = new Map();

    for (const record of Object.values(sessions)) {
      const subscriptions = normalizePushSubscriptions(record);
      if (subscriptions.length === 0) continue;

      for (const sub of subscriptions) {
        if (!subscriptionsByEndpoint.has(sub.endpoint)) {
          subscriptionsByEndpoint.set(sub.endpoint, sub);
        }
      }
    }

    await Promise.all(Array.from(subscriptionsByEndpoint.values()).map(async (sub) => {
      if (requireNoSse) {
        // Mobile PWA subscriptions follow the same presence model as native push: suppress only
        // when an interactive (desktop/web) client is visible. The phone PWA's own foreground is
        // handled in the service worker (focused-client check), so it won't double-notify.
        // Non-mobile (desktop/web) subscriptions keep the existing any-visible gate.
        const suppressed = isMobilePlatform(sub.platform) ? isAnyInteractiveClientVisible() : isAnyUiVisible();
        if (suppressed) return;
      }
      await sendPushToSubscription(sub, payload);
    }));
  };

  // A client is "mobile" if it reports a native mobile platform. Anything else (web, desktop,
  // vscode, or an older client that doesn't report a platform) is treated as interactive — i.e.
  // a surface where the user would actually see the in-app notification.
  const MOBILE_PLATFORMS = new Set(['ios', 'android']);
  const isMobilePlatform = (platform) => typeof platform === 'string' && MOBILE_PLATFORMS.has(platform);

  const updateUiVisibility = (token, visible, platform) => {
    if (!token) return;
    const now = Date.now();
    const nextVisible = Boolean(visible);
    const existing = uiVisibilityByToken.get(token);
    // Keep the last known platform if this beacon didn't carry one (e.g. a heartbeat).
    const nextPlatform = typeof platform === 'string' && platform ? platform : existing?.platform;
    uiVisibilityByToken.set(token, { visible: nextVisible, updatedAt: now, platform: nextPlatform });
  };

  const isAnyUiVisible = () => {
    const now = Date.now();
    pruneUiVisibility(now);
    for (const state of uiVisibilityByToken.values()) {
      if (state.visible === true && now - state.updatedAt <= UI_VISIBILITY_TTL_MS) {
        return true;
      }
    }
    return false;
  };

  // True when at least one NON-mobile client (desktop/web/vscode) is currently visible. Used to
  // suppress native push to the phone: an active desktop already shows the notification, so the
  // phone doesn't need it. Deliberately based on the desktop's visibility (reliable), never the
  // phone's own (a backgrounded WKWebView can't report "hidden" before iOS suspends it).
  const isAnyInteractiveClientVisible = () => {
    const now = Date.now();
    pruneUiVisibility(now);
    for (const state of uiVisibilityByToken.values()) {
      if (
        state.visible === true &&
        now - state.updatedAt <= UI_VISIBILITY_TTL_MS &&
        !isMobilePlatform(state.platform)
      ) {
        return true;
      }
    }
    return false;
  };

  const isUiVisible = (token) => {
    const now = Date.now();
    pruneUiVisibility(now);
    const state = uiVisibilityByToken.get(token);
    return state?.visible === true && now - state.updatedAt <= UI_VISIBILITY_TTL_MS;
  };

  const resolveVapidSubject = async () => {
    const configured = process.env.OPENCHAMBER_VAPID_SUBJECT;
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return configured.trim();
    }

    const originEnv = process.env.OPENCHAMBER_PUBLIC_ORIGIN;
    if (typeof originEnv === 'string' && originEnv.trim().length > 0) {
      const trimmed = originEnv.trim();
      if (isLoopbackHttpOrigin(trimmed)) {
        return 'mailto:openchamber@localhost';
      }
      return trimmed;
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const stored = settings?.publicOrigin;
      if (typeof stored === 'string' && stored.trim().length > 0) {
        const trimmed = stored.trim();
        if (isLoopbackHttpOrigin(trimmed)) {
          return 'mailto:openchamber@localhost';
        }
        return trimmed;
      }
    } catch {
    }

    return 'mailto:openchamber@localhost';
  };

  const ensurePushInitialized = async () => {
    if (pushInitialized) return;
    const keys = await getOrCreateVapidKeys();
    const subject = await resolveVapidSubject();

    if (subject === 'mailto:openchamber@localhost') {
      console.warn('[Push] No public origin configured for VAPID; set OPENCHAMBER_VAPID_SUBJECT or enable push once from a real origin.');
    }

    const webPush = await loadWebPush();
    webPush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    pushInitialized = true;
  };

  const setPushInitialized = (value) => {
    pushInitialized = value === true;
  };

  return {
    getOrCreateVapidKeys,
    addOrUpdatePushSubscription,
    removePushSubscription,
    sendPushToAllUiSessions,
    updateUiVisibility,
    isAnyUiVisible,
    isAnyInteractiveClientVisible,
    isUiVisible,
    ensurePushInitialized,
    setPushInitialized,
  };
};
