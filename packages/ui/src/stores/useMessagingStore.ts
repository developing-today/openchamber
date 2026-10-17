/**
 * State for the Messages panel: whether the connected OpenCode serves
 * messaging, the topics and messages the panel shows, the person's inbox, and
 * the current session's chain and log.
 *
 * OpenCode owns all of it. The store reads on demand, and re-reads what is on
 * screen when the event stream announces a new message (`applyCreated`). Each
 * slice remembers which request its data answers (`key`), so a view shows data
 * only for what it asked; only the newest read of a slice may commit; and a
 * failed read keeps the data already shown and records the error instead of
 * replacing it with an empty list.
 *
 * The panel remounts whenever the context panel switches surfaces, so where
 * the user was (tab, open topic, filters) lives here too. A runtime switch
 * resets everything.
 */

import { create } from 'zustand';

import { OpencodeApiError } from '@/lib/opencode/client';
import {
  changeMessagingVisibility,
  getMessagingChain,
  getMessagingTopic,
  inspectMessagingMessage,
  listMessagingSessions,
  listMessagingTopics,
  probeMessaging,
  queryMessaging,
  readMessagingLog,
  sendMessagingMessage,
  subscribeMessagingTopic,
  updateMessagingTopicSettings,
  type MessagingChain,
  type MessagingCreated,
  type MessagingDelivery,
  type MessagingLog,
  type MessagingLogPart,
  type MessagingMatchMode,
  type MessagingMessage,
  type MessagingModelStatus,
  type MessagingQueryResult,
  type MessagingSendResult,
  type MessagingSessionNode,
  type MessagingTopic,
  type MessagingWriteMode,
  type MessagingWriter,
} from '@/lib/opencode/messaging';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

export type MessagingTab = 'inbox' | 'topics' | 'sessions';
type MessagingTopicScope = 'session' | 'all';
export type MessagingLogOp = 'tail' | 'head' | 'grep' | 'search';

type MessagingSupport =
  | { kind: 'unknown' }
  | { kind: 'checking' }
  | { kind: 'supported' }
  | { kind: 'unsupported' }
  | { kind: 'failed'; error: string };

/** Data for one request. `data` belongs to `key`; it stays while a newer read of the same key runs or fails. */
type MessagingSlice<T> = {
  key: string | null;
  data: T | null;
  loading: boolean;
  error: string | null;
};

type MessagingThread = { messages: MessagingMessage[]; more: boolean };

type Slices = {
  topics: MessagingSlice<MessagingTopic[]>;
  topic: MessagingSlice<MessagingTopic>;
  thread: MessagingSlice<MessagingThread>;
  inbox: MessagingSlice<MessagingMessage[]>;
  search: MessagingSlice<MessagingQueryResult>;
  chain: MessagingSlice<MessagingChain>;
  log: MessagingSlice<MessagingLog>;
  sessions: MessagingSlice<MessagingSessionNode[]>;
};

type SliceName = keyof Slices;

/** Where the user is in the panel; kept across remounts. */
type MessagingView = {
  tab: MessagingTab;
  topicScope: MessagingTopicScope;
  openTopic: string | null;
  /** The message to scroll to and mark when a topic opens from a search hit or a notice. */
  focusSeq: number | null;
  showHidden: boolean;
  searchOpen: boolean;
  searchQuery: string;
  searchMatch: MessagingMatchMode;
  chainDetail: boolean;
  logOp: MessagingLogOp;
  logParts: MessagingLogPart[];
  logQuery: string;
  findQuery: string;
};

/** What a write reports back to the view that started it. */
export type MessagingWriteOutcome =
  | { kind: 'sent'; result: MessagingSendResult }
  /** A soft write limit refused it; `policy` is OpenCode's explanation. Sending again with `force` writes anyway. */
  | { kind: 'refused'; policy: string }
  | { kind: 'failed'; error: string };

type MessagingStore = Slices & MessagingView & {
  support: MessagingSupport;
  model: MessagingModelStatus | null;

  checkSupport: (options?: { force?: boolean }) => Promise<MessagingSupport>;
  /** Registers a visible Messages view; releasing the last one suspends background refreshes. */
  mountView: () => () => void;
  setView: (patch: Partial<MessagingView>) => void;
  /** Opens a topic in the Topics tab, optionally at one message. */
  openTopicAt: (topic: string, seq?: number | null) => void;
  reset: () => void;

  loadTopics: (sessionID: string | null) => Promise<void>;
  loadTopic: (topic: string) => Promise<void>;
  loadThread: (topic: string, options?: { more?: boolean }) => Promise<void>;
  loadInbox: () => Promise<void>;
  runSearch: () => Promise<void>;
  loadChain: (sessionID: string) => Promise<void>;
  loadLog: (sessionID: string) => Promise<void>;
  findSessions: () => Promise<void>;

  sendToTopic: (topic: string, text: string, options?: { force?: boolean; reply?: number }) => Promise<MessagingWriteOutcome>;
  sendToSession: (sessionID: string, text: string, deliver: MessagingDelivery, options?: { force?: boolean }) => Promise<MessagingWriteOutcome>;
  /** Resolves false when OpenCode refused or failed; the thread is re-read either way. */
  setHidden: (topic: string, seq: number, hidden: boolean, forEveryone: boolean) => Promise<boolean>;
  inspect: (topic: string, seq: number) => Promise<MessagingMessage>;
  saveTopicSettings: (topic: string, settings: { mode: MessagingWriteMode; writers: MessagingWriter[]; description: string }) => Promise<boolean>;
  subscribe: (sessionID: string, topic: string, delivery: MessagingDelivery | null) => Promise<boolean>;

  /** Re-reads whatever on screen a new message changes. */
  applyCreated: (event: MessagingCreated) => void;
};

const emptySlice = <T>(): MessagingSlice<T> => ({ key: null, data: null, loading: false, error: null });

const emptySlices = (): Slices => ({
  topics: emptySlice(),
  topic: emptySlice(),
  thread: emptySlice(),
  inbox: emptySlice(),
  search: emptySlice(),
  chain: emptySlice(),
  log: emptySlice(),
  sessions: emptySlice(),
});

const DEFAULT_LOG_PARTS: MessagingLogPart[] = ['user', 'output', 'tools'];

const defaultView = (): MessagingView => ({
  tab: 'inbox',
  topicScope: 'session',
  openTopic: null,
  focusSeq: null,
  showHidden: false,
  searchOpen: false,
  searchQuery: '',
  searchMatch: 'hybrid',
  chainDetail: false,
  logOp: 'tail',
  logParts: DEFAULT_LOG_PARTS,
  logQuery: '',
  findQuery: '',
});

/** How many messages a thread page holds. */
const THREAD_PAGE = 50;
/** Batches the re-reads a burst of new messages causes. */
const REFRESH_DELAY_MS = 400;

const failureText = (error: Error): string => (error instanceof OpencodeApiError ? error.detail : error.message);

const SLICE_NAMES: readonly SliceName[] = ['topics', 'topic', 'thread', 'inbox', 'search', 'chain', 'log', 'sessions'];

const generations = {
  topics: 0,
  topic: 0,
  thread: 0,
  inbox: 0,
  search: 0,
  chain: 0,
  log: 0,
  sessions: 0,
} satisfies Record<SliceName, number>;

let supportCheck: Promise<MessagingSupport> | null = null;
let runtimeGeneration = 0;
let views = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const pendingRefresh = new Set<SliceName>();
/** The session the topic list was last read for; `undefined` before the first read. */
let topicsSession: string | null | undefined;

export const useMessagingStore = create<MessagingStore>()((set, get) => {
  const patch = <K extends SliceName>(name: K, slice: Slices[K]): void => {
    set((state) => ({ ...state, [name]: slice }));
  };

  /**
   * Reads one slice. Data of the same key stays on screen while the read runs
   * and when it fails; another key starts empty.
   */
  const load = async <K extends SliceName>(name: K, key: string, fetch: () => Promise<NonNullable<Slices[K]['data']>>): Promise<void> => {
    const generation = ++generations[name];
    pendingRefresh.delete(name);
    const current = get()[name];
    const kept = current.key === key ? current.data : null;
    // SAFETY: every slice is a `MessagingSlice` of its own data, and `data` is this slice's current value.
    patch(name, { key, data: kept, loading: true, error: null } as Slices[K]);
    try {
      const data = await fetch();
      if (generation !== generations[name]) return;
      // SAFETY: `data` comes from this slice's own fetcher.
      patch(name, { key, data, loading: false, error: null } as Slices[K]);
    } catch (caught) {
      if (generation !== generations[name]) return;
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const latest = get()[name];
      // SAFETY: `data` is this slice's current value.
      patch(name, { key, data: latest.key === key ? latest.data : null, loading: false, error: failureText(error) } as Slices[K]);
    }
  };

  const write = async (run: () => Promise<MessagingSendResult>): Promise<MessagingWriteOutcome> => {
    try {
      return { kind: 'sent', result: await run() };
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      if (error instanceof OpencodeApiError && error.status === 409) return { kind: 'refused', policy: error.detail };
      return { kind: 'failed', error: failureText(error) };
    }
  };

  const flushRefresh = () => {
    refreshTimer = null;
    if (views === 0) return;
    const state = get();
    const due = new Set(pendingRefresh);
    pendingRefresh.clear();
    if (due.has('thread') && state.openTopic) void state.loadThread(state.openTopic);
    if (due.has('topic') && state.openTopic) void state.loadTopic(state.openTopic);
    if (due.has('inbox') && state.inbox.key !== null) void state.loadInbox();
    if (due.has('topics') && topicsSession !== undefined) void state.loadTopics(topicsSession);
  };

  const scheduleRefresh = (what: 'topics' | 'thread' | 'inbox' | 'topic') => {
    pendingRefresh.add(what);
    if (views > 0 && refreshTimer === null) refreshTimer = setTimeout(flushRefresh, REFRESH_DELAY_MS);
  };

  return {
    ...emptySlices(),
    ...defaultView(),
    support: { kind: 'unknown' },
    model: null,

    checkSupport: async (options) => {
      const known = get().support;
      if (!options?.force && (known.kind === 'supported' || known.kind === 'unsupported')) return known;
      if (supportCheck) return supportCheck;
      const generation = runtimeGeneration;
      set({ support: { kind: 'checking' } });
      const check = probeMessaging()
        .then((probe): MessagingSupport => {
          if (generation !== runtimeGeneration) return get().support;
          if (probe.kind === 'supported') {
            set({ support: { kind: 'supported' }, model: probe.model });
            return { kind: 'supported' };
          }
          set({ support: { kind: 'unsupported' }, model: null });
          return { kind: 'unsupported' };
        })
        .catch((caught): MessagingSupport => {
          if (generation !== runtimeGeneration) return get().support;
          const support: MessagingSupport = { kind: 'failed', error: failureText(caught instanceof Error ? caught : new Error(String(caught))) };
          set({ support });
          return support;
        })
        .finally(() => {
          if (supportCheck === check) supportCheck = null;
        });
      supportCheck = check;
      return check;
    },

    mountView: () => {
      views += 1;
      if (pendingRefresh.size > 0 && refreshTimer === null) refreshTimer = setTimeout(flushRefresh, REFRESH_DELAY_MS);
      return () => {
        views -= 1;
        if (views === 0 && refreshTimer !== null) {
          clearTimeout(refreshTimer);
          refreshTimer = null;
        }
      };
    },

    setView: (view) => set(view),

    openTopicAt: (topic, seq = null) => set({ tab: 'topics', openTopic: topic, focusSeq: seq, searchOpen: false }),

    reset: () => {
      runtimeGeneration += 1;
      for (const name of SLICE_NAMES) generations[name] += 1;
      supportCheck = null;
      topicsSession = undefined;
      pendingRefresh.clear();
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = null;
      set({ ...emptySlices(), ...defaultView(), support: { kind: 'unknown' }, model: null });
    },

    loadTopics: (sessionID) => {
      topicsSession = sessionID;
      const scope = sessionID ? get().topicScope : 'all';
      const key = JSON.stringify([scope, sessionID]);
      return load('topics', key, async () => {
        const result = await listMessagingTopics(
          scope === 'session' && sessionID
            // A session's own standard topics are listed before first use, so they can be opened and written.
            ? { as: sessionID, sessions: [sessionID], standard: true, sort: 'last', order: 'desc', limit: 200 }
            : { sort: 'last', order: 'desc', limit: 200 },
        );
        return result.topics;
      });
    },

    loadTopic: (topic) => load('topic', topic, () => getMessagingTopic({ topic, expand: 5 })),

    loadThread: (topic, options) => {
      const { showHidden } = get();
      const key = JSON.stringify([topic, showHidden]);
      const shown = get().thread;
      const loaded = shown.key === key ? shown.data?.messages ?? [] : [];
      // Older pages extend the thread; a refresh reads at least as much as is shown.
      const before = options?.more ? loaded[0]?.seq : undefined;
      const limit = options?.more ? THREAD_PAGE : Math.max(THREAD_PAGE, loaded.length);
      return load('thread', key, async () => {
        const page = await queryMessaging({
          topics: [topic],
          order: 'desc',
          limit,
          before,
          hidden: showHidden ? 'include' : 'exclude',
          markRead: false,
        });
        const messages = [...page.messages].reverse();
        return { messages: before === undefined ? messages : [...messages, ...loaded], more: page.more };
      });
    },

    loadInbox: () => load('inbox', 'inbox', async () => {
      // Newest first so the limit keeps the latest; shown newest first too.
      const result = await queryMessaging({ inbox: true, order: 'desc', limit: 100, markRead: false });
      return result.messages;
    }),

    runSearch: () => {
      const { searchQuery, searchMatch, showHidden } = get();
      const query = searchQuery.trim();
      if (!query) {
        generations.search += 1;
        patch('search', emptySlice());
        return Promise.resolve();
      }
      const key = JSON.stringify([query, searchMatch, showHidden]);
      return load('search', key, () => queryMessaging({
        query,
        match: searchMatch,
        limit: 50,
        hidden: showHidden ? 'include' : 'exclude',
        markRead: false,
      }));
    },

    loadChain: (sessionID) => {
      const detail = get().chainDetail ? 'full' : 'brief';
      return load('chain', JSON.stringify([sessionID, detail]), () => getMessagingChain({ session: sessionID, depth: 'all', detail, expand: 5 }));
    },

    loadLog: (sessionID) => {
      const { logOp, logParts, logQuery } = get();
      const query = logQuery.trim();
      // Grep and search need words; without them the panel shows the tail.
      const op = (logOp === 'grep' || logOp === 'search') && !query ? 'tail' : logOp;
      const key = JSON.stringify([sessionID, op, logParts, op === 'grep' || op === 'search' ? query : '']);
      return load('log', key, () => readMessagingLog({
        sessions: [sessionID],
        op,
        include: logParts,
        query: op === 'grep' || op === 'search' ? query : undefined,
        context: op === 'grep' ? 1 : undefined,
        limit: 40,
        chars: 2000,
      }));
    },

    findSessions: () => {
      const query = get().findQuery.trim();
      return load('sessions', JSON.stringify([query]), async () => {
        const result = await listMessagingSessions({ search: query || undefined, sort: 'updated', order: 'desc', limit: 30 });
        return result.sessions;
      });
    },

    sendToTopic: async (topic, text, options) => {
      const outcome = await write(() => sendMessagingMessage({ topic, text, force: options?.force, reply: options?.reply }));
      if (outcome.kind === 'sent') {
        scheduleRefresh('thread');
        scheduleRefresh('topics');
      }
      return outcome;
    },

    sendToSession: async (sessionID, text, deliver, options) => {
      const outcome = await write(() => sendMessagingMessage({ to: sessionID, text, deliver, force: options?.force }));
      if (outcome.kind === 'sent') scheduleRefresh('topics');
      return outcome;
    },

    setHidden: async (topic, seq, hidden, forEveryone) => {
      try {
        await changeMessagingVisibility({ topic, action: hidden ? 'hide' : 'restore', seqs: [seq], for: forEveryone ? ['*'] : undefined });
        return true;
      } catch (caught) {
        console.warn('[messaging] failed to change visibility', caught);
        return false;
      } finally {
        if (get().openTopic === topic) void get().loadThread(topic);
      }
    },

    inspect: (topic, seq) => inspectMessagingMessage({ topic, seq }),

    saveTopicSettings: async (topic, settings) => {
      try {
        await updateMessagingTopicSettings({ topic, ...settings });
        void get().loadTopic(topic);
        scheduleRefresh('topics');
        return true;
      } catch (caught) {
        console.warn('[messaging] failed to save topic settings', caught);
        return false;
      }
    },

    subscribe: async (sessionID, topic, delivery) => {
      try {
        await subscribeMessagingTopic(delivery === null ? { as: sessionID, topic, remove: true } : { as: sessionID, topic, delivery });
        scheduleRefresh('topics');
        scheduleRefresh('topic');
        return true;
      } catch (caught) {
        console.warn('[messaging] failed to change the subscription', caught);
        return false;
      }
    },

    applyCreated: (event) => {
      const state = get();
      if (state.openTopic === event.topic) {
        scheduleRefresh('thread');
        scheduleRefresh('topic');
      }
      if (state.topics.key !== null) scheduleRefresh('topics');
      if (event.inbox && state.inbox.key !== null) scheduleRefresh('inbox');
    },
  };
});

subscribeRuntimeEndpointChanged(() => useMessagingStore.getState().reset());
