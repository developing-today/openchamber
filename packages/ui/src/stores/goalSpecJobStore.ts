import { create } from 'zustand';
import { z } from 'zod';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { AttachedFile } from './types/sessionTypes';
import { createInputHistoryIdentity, createInputHistorySubmission, useInputHistoryStore } from './useInputHistoryStore';
import {
    serverAttachmentSchema,
    serverContextPartSchema,
    toAttachedFile,
    toServerItemInput,
    type QueuedContextPart,
    type QueuedMessageInput,
    type QueuedMessageSendConfig,
} from './messageQueueStore';

// Goal writer jobs. A send that goes through the goal writer is a job the web
// server owns (packages/web/server/lib/session-goal/spec-jobs.js): it writes
// the spec, waits for review or sends the message itself, whether or not any
// window shows the session. This store is the client's view of those jobs,
// one per session, kept in the server's revision order: the snapshot on load
// and on every reconnect, then `openchamber:goal-spec-job.updated` from the
// control stream. Nothing is persisted; the server is the authority.

const sendModeSchema = z.enum(['with-message', 'goal-as-message']);

const jobSchema = z.object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    directory: z.string(),
    status: z.enum(['writing', 'ready', 'failed', 'sent', 'cancelled']),
    trigger: z.enum(['armed', 'auto-create']),
    review: z.boolean(),
    sendMode: sendModeSchema,
    tokenBudget: z.number().nullable(),
    // The projection names the files and counts the context; `claim` and
    // `edit` hand back the payloads.
    message: z.object({
        content: z.string(),
        text: z.string(),
        agentMention: z.string().optional(),
        attachments: z.array(z.object({ id: z.string(), filename: z.string(), mimeType: z.string(), size: z.number() })),
        contextCount: z.number(),
    }),
    /** Attachments or attached context: the server cannot send it, a window does. */
    composerOnly: z.boolean(),
    spec: z.string().nullable(),
    /** Who writes: the model picked in Settings, the session's model, or the small model; the model that answered once written. */
    writer: z.object({
        source: z.enum(['settings', 'session', 'small-model']),
        providerID: z.string().nullable(),
        modelID: z.string().nullable(),
        variant: z.string().nullable(),
    }),
    sendConfig: z.object({
        providerID: z.string().min(1),
        modelID: z.string().min(1),
        agent: z.string().optional(),
        variant: z.string().optional(),
    }),
    error: z.string().nullable(),
    /** The step `error` comes from: writing the spec, or sending the message. Absent from servers before it existed. */
    failedStep: z.enum(['write', 'send']).nullable().optional(),
    /** The goal reminder could not be sent; the message went out without it. */
    warning: z.string().nullable().optional(),
    /** The server, or a window that claimed it, is sending the message now. */
    sending: z.boolean(),
    /**
     * The server sends it once the agent's turn is over: the user's follow-up
     * setting is queue and the agent was working. Absent from servers before it existed.
     */
    waiting: z.boolean().optional(),
    /**
     * The claim of the window sending it, while it waits or is being sent;
     * only that window sends it. Absent from servers before it existed.
     */
    claimId: z.string().nullable().optional(),
    /** The user message a sent job sent, when OpenCode or the sending window named it. Absent from servers before it existed. */
    messageId: z.string().nullable().optional(),
    /** The composer made the session from a new-session draft for this job. Absent from servers before it existed. */
    newSession: z.boolean().optional(),
    outcome: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('spec'), sendMode: sendModeSchema }),
        z.object({ kind: z.literal('original'), withGoal: z.boolean() }),
    ]).nullable(),
    attempt: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

export type GoalSpecJob = z.infer<typeof jobSchema>;
type GoalSpecJobSendMode = z.infer<typeof sendModeSchema>;

/** Writing, waiting for the user, or failed: not sent and not taken back. */
export const isOpenGoalSpecJob = (job: GoalSpecJob): boolean => (
    job.status === 'writing' || job.status === 'ready' || job.status === 'failed'
);

/** What the user picked on the card. */
export type GoalSpecJobChoice =
    | { kind: 'spec'; sendMode: GoalSpecJobSendMode; spec: string }
    /** The message as typed, without a spec. */
    | { kind: 'original' };

type GoalSpecJobOutcome = NonNullable<GoalSpecJob['outcome']>;

/**
 * How a claimed send went: its outcome (with the spec as sent and the id of the
 * user message it created), or null with the reason it failed.
 */
type GoalSpecJobSettlement = { outcome: GoalSpecJobOutcome | null; spec?: string; messageId?: string; error?: string };

/** The captured message in full, as `claim` and `edit` hand it back. */
export interface GoalSpecJobMessage {
    content: string;
    text: string;
    agentMention?: string;
    attachments: AttachedFile[];
    context: QueuedContextPart[];
}

/**
 * A window's claim on a job: the full message, and the claim's id. While the
 * agent works and the follow-up setting is queue, the server holds the claim
 * (`waiting`) and hands it over once the turn is over.
 */
interface GoalSpecJobClaim {
    message: GoalSpecJobMessage;
    claimId: string | null;
    waiting: boolean;
}

interface GoalSpecJobStart {
    sessionId: string;
    directory: string;
    trigger: GoalSpecJob['trigger'];
    review: boolean;
    sendMode: GoalSpecJobSendMode;
    tokenBudget: number | null;
    /** The conversation and open work, for a goal from the next message. */
    writerInput: { conversation?: string; openItems?: string } | null;
    /** The session was just made from a new-session draft for this message. */
    newSession: boolean;
    message: QueuedMessageInput;
    sendConfig: QueuedMessageSendConfig;
}

const fullMessageSchema = z.object({
    content: z.string(),
    text: z.string(),
    agentMention: z.string().optional(),
    attachments: z.array(serverAttachmentSchema),
    context: z.array(serverContextPartSchema),
});

const mutationResponseSchema = z.object({ revision: z.number(), job: jobSchema.nullable() });
const handBackResponseSchema = mutationResponseSchema.extend({ message: fullMessageSchema });
// Jobs are read one by one, so one this window cannot read never hides the others.
const snapshotResponseSchema = z.object({ revision: z.number(), jobs: z.array(z.unknown()) });
const errorResponseSchema = z.object({ error: z.string().min(1) });

export const goalSpecJobUpdatedEventSchema = z.object({
    type: z.literal('openchamber:goal-spec-job.updated'),
    properties: z.object({ revision: z.number(), sessionId: z.string().min(1), job: jobSchema.nullable() }),
});

export type GoalSpecJobUpdatedEvent = z.infer<typeof goalSpecJobUpdatedEventSchema>;

const JOBS_PATH = '/api/goals/spec-jobs';
const SNAPSHOT_TIMEOUT_MS = 15_000;

const jobPath = (jobId: string, action?: string): string => (
    action ? `${JOBS_PATH}/${encodeURIComponent(jobId)}/${action}` : `${JOBS_PATH}/${encodeURIComponent(jobId)}`
);

/** `POST /api/goals/spec-jobs`; a missing `writerInput` means none. */
interface StartJobBody {
    sessionId: string;
    directory: string;
    trigger: GoalSpecJob['trigger'];
    review: boolean;
    sendMode: GoalSpecJobSendMode;
    tokenBudget: number | null;
    writerInput?: { conversation?: string; openItems?: string };
    newSession: boolean;
    message: ReturnType<typeof toServerItemInput>;
    sendConfig: QueuedMessageSendConfig;
}

type JobRequestBody = StartJobBody | GoalSpecJobChoice | { kind: GoalSpecJobChoice['kind'] } | GoalSpecJobSettlement;

const jsonInit = (method: string, body?: JobRequestBody): RequestInit => (
    body === undefined
        ? { method }
        : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
);

/** The server's answer, or an error carrying the reason it gave. */
const requestJson = async <T,>(schema: z.ZodType<T>, path: string, init?: RequestInit): Promise<T> => {
    const response = await runtimeFetch(path, init);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const failure = errorResponseSchema.safeParse(payload);
        throw new Error(failure.success ? failure.data.error : `HTTP ${response.status}`);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new Error('The server sent a goal writer answer this window cannot read');
    return parsed.data;
};

const toJobMessage = (message: z.infer<typeof fullMessageSchema>): GoalSpecJobMessage => {
    const result: GoalSpecJobMessage = {
        content: message.content,
        text: message.text,
        attachments: message.attachments.map(toAttachedFile),
        context: message.context,
    };
    if (message.agentMention) result.agentMention = message.agentMention;
    return result;
};

/** Server revision last applied per session; an older event never replaces it. */
const appliedRevisions = new Map<string, number>();
/** A full snapshot also stands for the sessions it leaves out. */
let snapshotRevision = -1;
let generation = 0;
let hydration: { runtimeKey: string; promise: Promise<void> } | null = null;
let resyncRequested = false;

interface GoalSpecJobState {
    /** Session id to its job, for the active runtime. */
    jobs: Record<string, GoalSpecJob>;
    /** Spec text edited on a card, by job id, for the write it was edited on. */
    specEdits: Record<string, { attempt: number; spec: string }>;
}

interface GoalSpecJobActions {
    /** The server's jobs for the active runtime; shares one read with `resync`. */
    hydrate: () => Promise<void>;
    /** Read again after the control stream reconnected: events may have been missed. */
    resync: () => Promise<void>;
    /** One session's state from the server (event or answer), unless a newer one is already shown. */
    applyServerJob: (sessionId: string, job: GoalSpecJob | null, revision: number, runtimeKey: string) => void;
    resetForRuntimeSwitch: () => void;
    startJob: (input: GoalSpecJobStart) => Promise<GoalSpecJob>;
    /** The server sends the message; for a message without attachments or attached context. */
    sendJob: (job: GoalSpecJob, choice: GoalSpecJobChoice) => Promise<void>;
    redoJob: (job: GoalSpecJob) => Promise<void>;
    /** Back to edit: the job ends and its full message comes back. */
    editJob: (job: GoalSpecJob) => Promise<GoalSpecJobMessage>;
    /** A window takes the full message to send it itself, now or once the agent's turn is over. */
    claimJob: (job: GoalSpecJob, kind: GoalSpecJobChoice['kind']) => Promise<GoalSpecJobClaim>;
    settleJob: (job: GoalSpecJob, settlement: GoalSpecJobSettlement) => Promise<void>;
    /** Removes the card of a sent job. */
    dismissJob: (job: GoalSpecJob) => Promise<void>;
    setSpecEdit: (job: GoalSpecJob, spec: string) => void;
}

type GoalSpecJobStore = GoalSpecJobState & GoalSpecJobActions;

const withoutKey = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
    const { [key]: _removed, ...rest } = record;
    void _removed;
    return rest;
};

export const useGoalSpecJobStore = create<GoalSpecJobStore>()((set, get) => {
    const applyServerJob: GoalSpecJobActions['applyServerJob'] = (sessionId, job, revision, runtimeKey) => {
        if (runtimeKey !== getRuntimeKey()) return;
        if (revision < snapshotRevision) return;
        if (revision < (appliedRevisions.get(sessionId) ?? -1)) return;
        appliedRevisions.set(sessionId, revision);
        set((state) => {
            const current = state.jobs[sessionId];
            // A cancelled job is over: the server already forgot it.
            const next = job && job.status !== 'cancelled' ? job : null;
            const specEdits = current && current.id !== next?.id ? withoutKey(state.specEdits, current.id) : state.specEdits;
            return {
                jobs: next ? { ...state.jobs, [sessionId]: next } : withoutKey(state.jobs, sessionId),
                specEdits,
            };
        });
    };

    /** The server's state wins: after a failed action it is read again, never guessed. */
    const mutate = async <T extends z.infer<typeof mutationResponseSchema>,>(
        job: GoalSpecJob,
        schema: z.ZodType<T>,
        path: string,
        init: RequestInit,
    ): Promise<T> => {
        const runtimeKey = getRuntimeKey();
        try {
            const result = await requestJson(schema, path, init);
            applyServerJob(job.sessionId, result.job, result.revision, runtimeKey);
            return result;
        } catch (error) {
            void get().resync().catch(() => undefined);
            throw error;
        }
    };

    const applySnapshot = (revision: number, received: GoalSpecJob[]) => {
        if (revision < snapshotRevision) return;
        snapshotRevision = revision;
        set((state) => {
            // An event newer than this snapshot wins, listed in it or not.
            const isNewerThanSnapshot = (sessionId: string) => (appliedRevisions.get(sessionId) ?? -1) > revision;
            const jobs: Record<string, GoalSpecJob> = {};
            for (const [sessionId, job] of Object.entries(state.jobs)) {
                if (isNewerThanSnapshot(sessionId)) jobs[sessionId] = job;
            }
            for (const job of received) {
                if (isNewerThanSnapshot(job.sessionId) || job.status === 'cancelled') continue;
                appliedRevisions.set(job.sessionId, revision);
                jobs[job.sessionId] = job;
            }
            const kept = new Set(Object.values(jobs).map((job) => job.id));
            const specEdits: GoalSpecJobState['specEdits'] = {};
            for (const [jobId, edit] of Object.entries(state.specEdits)) {
                if (kept.has(jobId)) specEdits[jobId] = edit;
            }
            return { jobs, specEdits };
        });
    };

    return {
        jobs: {},
        specEdits: {},

        hydrate: () => {
            if (isVSCodeRuntime()) return Promise.resolve();
            const runtimeKey = getRuntimeKey();
            if (hydration?.runtimeKey === runtimeKey) return hydration.promise;
            const startedGeneration = generation;
            const isCurrent = () => startedGeneration === generation && runtimeKey === getRuntimeKey();
            const promise = (async () => {
                do {
                    resyncRequested = false;
                    let snapshot: z.infer<typeof snapshotResponseSchema>;
                    try {
                        snapshot = await requestJson(snapshotResponseSchema, JOBS_PATH, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
                    } catch (error) {
                        if (!isCurrent()) return;
                        // A reconnect during the failed read asks again; otherwise
                        // the cards stay as they were and the failure is reported.
                        if (resyncRequested) continue;
                        throw error;
                    }
                    if (!isCurrent()) return;
                    const received: GoalSpecJob[] = [];
                    for (const value of snapshot.jobs) {
                        const parsed = jobSchema.safeParse(value);
                        if (parsed.success) received.push(parsed.data);
                        else console.warn('[goal-spec-jobs] skipped a job this window cannot read:', parsed.error.message);
                    }
                    applySnapshot(snapshot.revision, received);
                } while (resyncRequested && isCurrent());
            })();
            const run = { runtimeKey, promise };
            hydration = run;
            const release = () => { if (hydration === run) hydration = null; };
            void promise.then(release, release);
            return promise;
        },

        resync: () => {
            // A reconnect while a read is out earns one more read after it.
            if (hydration?.runtimeKey === getRuntimeKey()) resyncRequested = true;
            return get().hydrate();
        },

        applyServerJob,

        resetForRuntimeSwitch: () => {
            generation += 1;
            hydration = null;
            resyncRequested = false;
            appliedRevisions.clear();
            snapshotRevision = -1;
            set({ jobs: {}, specEdits: {} });
        },

        startJob: async (input) => {
            const runtimeKey = getRuntimeKey();
            const message = toServerItemInput(input.message, input.sendConfig);
            const body: StartJobBody = {
                sessionId: input.sessionId,
                directory: input.directory,
                trigger: input.trigger,
                review: input.review,
                sendMode: input.sendMode,
                tokenBudget: input.tokenBudget,
                newSession: input.newSession,
                message,
                sendConfig: input.sendConfig,
            };
            if (input.writerInput) body.writerInput = input.writerInput;
            const result = await requestJson(mutationResponseSchema, JOBS_PATH, jsonInit('POST', body));
            applyServerJob(input.sessionId, result.job, result.revision, runtimeKey);
            if (!result.job) throw new Error('The server did not start the goal writer');
            // Accepted like a queued message: the prompt joins this session's input history.
            const historyIdentity = createInputHistoryIdentity(runtimeKey, input.directory, input.sessionId);
            if (historyIdentity) {
                useInputHistoryStore.getState().appendSubmissions(historyIdentity, [
                    createInputHistorySubmission(input.message.content, input.message.attachments ?? []),
                ]);
            }
            return result.job;
        },

        sendJob: async (job, choice) => {
            await mutate(job, mutationResponseSchema, jobPath(job.id, 'send'), jsonInit('POST', choice));
        },

        redoJob: async (job) => {
            await mutate(job, mutationResponseSchema, jobPath(job.id, 'redo'), jsonInit('POST'));
        },

        editJob: async (job) => {
            const result = await mutate(job, handBackResponseSchema, jobPath(job.id, 'edit'), jsonInit('POST'));
            return toJobMessage(result.message);
        },

        claimJob: async (job, kind) => {
            const result = await mutate(job, handBackResponseSchema, jobPath(job.id, 'claim'), jsonInit('POST', { kind }));
            return {
                message: toJobMessage(result.message),
                claimId: result.job?.claimId ?? null,
                waiting: result.job?.waiting === true,
            };
        },

        settleJob: async (job, settlement) => {
            await mutate(job, mutationResponseSchema, jobPath(job.id, 'settle'), jsonInit('POST', settlement));
        },

        dismissJob: async (job) => {
            await mutate(job, mutationResponseSchema, jobPath(job.id), jsonInit('DELETE'));
        },

        setSpecEdit: (job, spec) => {
            set((state) => ({ specEdits: { ...state.specEdits, [job.id]: { attempt: job.attempt, spec } } }));
        },
    };
});

/** `openchamber:goal-spec-job.updated` from the control stream. */
export const applyGoalSpecJobUpdatedEvent = (event: GoalSpecJobUpdatedEvent, runtimeKey: string): void => {
    const { sessionId, job, revision } = event.properties;
    useGoalSpecJobStore.getState().applyServerJob(sessionId, job, revision, runtimeKey);
};
