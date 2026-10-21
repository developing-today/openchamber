// Goal writer jobs. A send that goes through the goal writer becomes a job the
// server owns: it writes the spec, waits on the user while review is on, and
// with review off sets the goal and sends the message itself, whether or not
// any window shows the session. Clients follow the jobs on the control stream
// (`openchamber:goal-spec-job.updated`) and show one card per session.
// Structural template: the message queue (server-owned, persisted,
// revisioned, broadcast; VS Code has neither, since it has no goal loop).
//
// The server sends a job's text, its agent mention and the instructions
// derived from the text. A message that carries attachments or attached
// context waits on the card and goes out through the session's composer:
// the job hands the captured message back (`claim`) and is told the outcome
// (`settle`).
//
// A send in flight, the server's or a composer's, is written to the file
// before anything goes out (`delivery`). A restart cannot tell whether such a
// message went out, so the job goes back to review and waits for the user.
//
// A send into a session whose agent is still working follows the user's
// follow-up setting, as a message sent from the composer does: steer joins
// the running turn, queue (the default) waits on the job (`waiting`) until
// the turn is over and then sends once. A composer's claim waits the same
// way and is handed to that composer when the turn is over. The wait is the
// message queue's: idle events arm a look, and the look asks OpenCode.

import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { parseQueuedItemInput } from '../message-queue/runtime.js';
import { writeFileAtomic } from '../opencode/atomic-write.js';
import { assertPromptResponse } from '../opencode/prompt-response.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { readMergedSettingsSync } from '../opencode/settings-files.js';
import { isAutoModel } from '../routing/defaults.js';
import { parseModelRef } from '../small-model/index.js';
import { buildGoalIntroText, createSessionGoal } from './create.js';
import { readGoalWriterSettings, writeGoalSpec } from './spec-writer.js';

const JOBS_FILE_NAME = 'goal-spec-jobs.json';
const JOBS_FILE_VERSION = 1;
// Messages are conversation content: readable by the owner only.
const JOBS_FILE_MODE = 0o600;
const SETTINGS_FILE_NAME = 'settings.json';

const MAX_JOBS = 50;
// A sent card stays until it is dismissed, the session starts another job, or
// a day has passed. The sweep runs hourly, so a card goes within the next hour.
const SETTLED_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
// A composer that claimed a job and went away (closed tab, lost connection)
// must not hold it forever.
const CLAIM_TTL_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
// A message waiting for the turn to end uses the message queue's timings: an
// idle event is acted on after a quiet moment, a running subagent is looked at
// again after 5 s, and a session OpenCode could not answer for after 2 s
// doubling to 60 s.
const TURN_QUIET_MS = 500;
const SUBAGENT_RECHECK_MS = 5_000;
const TURN_RETRY_BASE_MS = 2_000;
const TURN_RETRY_MAX_MS = 60_000;

const RESTART_REASON = 'the server restarted while the message was being sent; check the session before sending it again';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
const OPEN_STATUSES = new Set(['writing', 'ready', 'failed']);
const HANDLED_EVENT_TYPES = new Set([
  'session.deleted',
  'session.updated',
  'openchamber:session-archived',
  'session.status',
  'message.updated',
]);

// A cancelled job leaves the map before it is written, so the file never holds one.
const storedStatusSchema = z.enum(['writing', 'ready', 'failed', 'sent']);
const triggerSchema = z.enum(['armed', 'auto-create']);
const sendModeSchema = z.enum(['with-message', 'goal-as-message']);
const writerSourceSchema = z.enum(['settings', 'session', 'small-model']);
/** The step `error` comes from: writing the spec, or sending the message. */
const failedStepSchema = z.enum(['write', 'send']);

const writerInputSchema = z.object({
  conversation: z.string().optional(),
  openItems: z.string().optional(),
});

const tokenBudgetSchema = z.number().int().positive().nullable();

const createInputSchema = z.object({
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  directory: z.string().trim().min(1),
  trigger: triggerSchema,
  review: z.boolean(),
  sendMode: sendModeSchema,
  tokenBudget: tokenBudgetSchema.optional().transform((value) => value ?? null),
  writerInput: writerInputSchema.optional().transform((value) => value ?? {}),
  // The composer made the session from a new-session draft for this job.
  newSession: z.boolean().optional().transform((value) => value ?? false),
  message: z.unknown(),
  sendConfig: z.unknown(),
});

/** What the user picked on the card. */
const choiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spec'), sendMode: sendModeSchema, spec: z.string().trim().min(1) }),
  z.object({ kind: z.literal('original') }),
]);

const claimInputSchema = z.object({ kind: z.enum(['spec', 'original']) });

const outcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spec'), sendMode: sendModeSchema }),
  z.object({ kind: z.literal('original'), withGoal: z.boolean() }),
]);

const settleInputSchema = z.object({
  outcome: outcomeSchema.nullable(),
  // The spec as it was sent, edits on the card included.
  spec: z.string().trim().min(1).optional().catch(undefined),
  // The id of the user message the composer sent.
  messageId: z.string().trim().min(1).optional().catch(undefined),
  error: z.string().optional().catch(undefined),
});

const writerSchema = z.object({
  source: writerSourceSchema,
  providerID: z.string().nullable(),
  modelID: z.string().nullable(),
  variant: z.string().nullable(),
});

/**
 * A send in flight: the server's own, or a composer's after `claim`. A
 * composer's names its claim, so only the composer that claimed it sends it.
 */
const deliverySchema = z.object({
  by: z.enum(['server', 'composer']),
  startedAt: z.number(),
  claimId: z.string().min(1).optional(),
});

/**
 * A send chosen while the agent was working, waiting for its turn to end: the
 * server's own (the choice it then sends), or a composer's claim (handed to
 * that composer then).
 */
const waitingSchema = z.union([
  z.object({ choice: choiceSchema, since: z.number() }),
  z.object({ claimId: z.string().min(1), since: z.number() }),
]);

const storedJobSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  directory: z.string().min(1),
  status: storedStatusSchema,
  trigger: triggerSchema,
  review: z.boolean(),
  sendMode: sendModeSchema,
  tokenBudget: tokenBudgetSchema,
  message: z.unknown(),
  sendConfig: z.unknown(),
  writerInput: writerInputSchema,
  spec: z.string().nullable(),
  writer: writerSchema,
  error: z.string().nullable(),
  // Files written before these fields existed read as none.
  failedStep: failedStepSchema.nullable().default(null),
  warning: z.string().nullable().default(null),
  delivery: deliverySchema.nullable().default(null),
  waiting: waitingSchema.nullable().default(null),
  messageId: z.string().min(1).nullable().default(null),
  newSession: z.boolean().default(false),
  outcome: outcomeSchema.nullable(),
  attempt: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const storedFileSchema = z.object({
  version: z.literal(JOBS_FILE_VERSION),
  revision: z.number().int().nonnegative(),
  jobs: z.array(z.unknown()),
});

const messageRecordSchema = z.record(z.string(), z.unknown()).catch({});

/** An attachment as clients see it, and as a sent job keeps it: its name, never its bytes. */
const attachmentSummarySchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
});

const sentMessageSchema = z.object({
  attachments: z.array(attachmentSummarySchema),
  contextCount: z.number().int().nonnegative().optional(),
});

const errorCodeSchema = z.object({ code: z.string() });
const deletedSessionSchema = z.object({
  type: z.literal('session.deleted'),
  properties: z.object({
    info: z.object({ id: z.string().min(1) }).optional().catch(undefined),
    sessionID: z.string().min(1).optional().catch(undefined),
  }),
});
// OpenChamber's own archive broadcast; `archivedAt: null` is an unarchive and ends nothing.
const archivedSessionSchema = z.object({
  type: z.literal('openchamber:session-archived'),
  properties: z.object({ sessionID: z.string().min(1), archivedAt: z.number() }),
});
const movedSessionSchema = z.object({
  type: z.literal('session.updated'),
  properties: z.object({
    info: z.object({ id: z.string().min(1), directory: z.string().trim().min(1) }),
  }),
});
const sessionStatusSchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({ sessionID: z.string().min(1), status: z.object({ type: z.string().min(1) }) }),
});
const finishedReplySchema = z.object({
  type: z.literal('message.updated'),
  properties: z.object({
    info: z.object({ role: z.literal('assistant'), sessionID: z.string().min(1), time: z.object({ completed: z.number() }) }),
  }),
});
const hubStatusSchema = z.object({ type: z.string() });
// v2 answers a prompt with the inbox item it recorded.
const queuedMessageSchema = z.object({ id: z.string().trim().min(1) });
// v2 lists a session's records newest first, in a page that keeps its envelope.
const recordPageSchema = z.object({ data: z.array(z.unknown()) });
// A reply still streaming has no `completed` time.
const replyRecordSchema = z.object({
  type: z.literal('assistant'),
  time: z.object({
    created: z.number().optional().catch(undefined),
    completed: z.number().optional().catch(undefined),
  }).catch({}),
});
const followUpSettingsSchema = z.object({
  followUpBehavior: z.enum(['steer', 'queue', 'immediate']).optional().catch(undefined),
  queueModeEnabled: z.boolean().optional().catch(undefined),
});

const httpError = (message, status) => Object.assign(new Error(message), { status });

const describeError = (error, fallback) => (error instanceof Error && error.message ? error.message : fallback);

const turnRetryDelay = (failures) => Math.min(TURN_RETRY_BASE_MS * 2 ** Math.max(failures - 1, 0), TURN_RETRY_MAX_MS);

/**
 * The user's follow-up setting (Settings → Chat), which the composer applies
 * to a message sent while the agent works: `queue` unless `steer` was
 * picked. The removed `immediate` and the legacy `queueModeEnabled: false`
 * read as steer, as the settings parsers read them.
 */
const readFollowUpBehaviorFrom = (settingsFilePath) => {
  const { followUpBehavior, queueModeEnabled } = followUpSettingsSchema.parse(readMergedSettingsSync({ fs, path, settingsFilePath }));
  if (followUpBehavior) return followUpBehavior === 'queue' ? 'queue' : 'steer';
  return queueModeEnabled === false ? 'steer' : 'queue';
};

/**
 * The captured message and its send settings, validated like a queued
 * message: a job must never hold a message nobody could send. The writer
 * works from the text, so a job without text is refused.
 */
const parseJobMessage = (message, sendConfig) => {
  const raw = messageRecordSchema.parse(message);
  // Provenance belongs to the message queue's scheduled sends; it would also
  // let a message through without the model a job sends with.
  if (raw.scheduledTask) throw new TypeError('scheduledTask is server-owned');
  const item = parseQueuedItemInput({ ...raw, sendConfig });
  if (!item.text.trim()) throw new TypeError('the goal writer needs the message text');
  const captured = { content: item.content, text: item.text, attachments: item.attachments, context: item.context };
  if (item.agentMention) captured.agentMention = item.agentMention;
  return { message: captured, sendConfig: item.sendConfig };
};

const summarizeAttachment = (attachment) => ({
  id: attachment.id,
  filename: attachment.filename,
  mimeType: attachment.mimeType,
  size: attachment.size,
});

/** Attached context items; the instructions derived from the text are not among them. */
const contextCountOf = (message) => message.contextCount
  ?? message.context.filter((part) => part.kind !== 'instruction').length;

/**
 * A sent message keeps what its card shows: the text, the attachment names,
 * how many context items went with it, and the instructions derived from the
 * text. The attachment bytes and the attached context are never needed again.
 */
const toSentMessage = (message) => {
  const sent = {
    content: message.content,
    text: message.text,
    attachments: message.attachments.map(summarizeAttachment),
    context: message.context.filter((part) => part.kind === 'instruction'),
    contextCount: contextCountOf(message),
  };
  if (message.agentMention) sent.agentMention = message.agentMention;
  return sent;
};

/** A sent job's message: checked as an open one is, with attachment names in place of payloads. */
const parseSentJobMessage = (message, sendConfig) => {
  const raw = messageRecordSchema.parse(message);
  const { attachments, contextCount } = sentMessageSchema.parse(raw);
  const parsed = parseJobMessage({ ...raw, attachments: [] }, sendConfig);
  return { message: toSentMessage({ ...parsed.message, attachments, contextCount }), sendConfig: parsed.sendConfig };
};

/**
 * Attachments and attached context items go out through the session's
 * composer; the server sends text, the agent mention and the instructions
 * derived from the text.
 */
const isComposerOnly = (job) => job.message.attachments.length > 0 || contextCountOf(job.message) > 0;

/**
 * Which model writes the spec, as the writer resolves it: the model picked in
 * Settings with its effort, else the session's own model at its default,
 * else (a session on Auto) the small model. The writer reports the model
 * that answered, which replaces the model named here.
 */
const describeWriter = (settings, sendConfig) => {
  const picked = parseModelRef(settings?.model);
  if (picked) {
    return { source: 'settings', providerID: picked.providerID, modelID: picked.modelID, variant: settings?.variant ?? null };
  }
  if (!isAutoModel({ providerID: sendConfig.providerID, modelID: sendConfig.modelID })) {
    return { source: 'session', providerID: sendConfig.providerID, modelID: sendConfig.modelID, variant: null };
  }
  return { source: 'small-model', providerID: null, modelID: null, variant: null };
};

export function createGoalSpecJobRuntime({
  globalEventHub = null,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastGlobalUiEvent,
  // Writes the goal record the way every other server-created goal does.
  persistSessionGoal,
  sessionKnowledgeRuntime = null,
  // Resolves the `openchamber/auto` sentinel into a real model and agent.
  resolveAutoSelection = null,
  onPromptSent = null,
  dataDir,
  writeSpec = writeGoalSpec,
  readWriterSettings = readGoalWriterSettings,
  // The follow-up setting is read when a send is decided, as the writer's
  // settings are read when a write starts.
  readFollowUpBehavior = () => readFollowUpBehaviorFrom(path.join(dataDir, SETTINGS_FILE_NAME)),
  createGoal = createSessionGoal,
  fetchImpl = fetch,
  now = Date.now,
  claimTtlMs = CLAIM_TTL_MS,
  turnQuietMs = TURN_QUIET_MS,
  subagentRecheckMs = SUBAGENT_RECHECK_MS,
  turnRetryDelayMs = turnRetryDelay,
}) {
  const filePath = path.join(dataDir, JOBS_FILE_NAME);

  /** jobId → job; at most one job per session. */
  const jobs = new Map();
  let revision = 0;
  let loadPromise = null;
  // The chain of file writes, which never rejects, and the newest write in
  // it, which rejects when that write failed: a send waits for its record.
  let writePromise = Promise.resolve();
  let latestWrite = Promise.resolve();
  let stopped = false;
  let pruneTimer = null;
  // A reply left unfinished before this server started belongs to a run that
  // died with the previous one; it never finishes, so it must not hold a
  // waiting message forever (the message queue's rule).
  const runtimeStartedAt = now();

  // In memory only. A send in flight is on the job itself (`delivery`), and
  // so is a send waiting for the turn to end (`waiting`).
  const writers = new Map(); // jobId → AbortController
  const claimTimers = new Map(); // jobId → timeout that ends a composer's claim
  const turnTimers = new Map(); // jobId → timeout that looks at a waiting job's session again
  const turnLooks = new Set(); // jobIds whose session is being looked at from a timer
  const turnFailures = new Map(); // jobId → looks in a row OpenCode did not answer
  const work = new Set(); // background writes and sends, for `whenIdle`

  const track = (promise) => {
    work.add(promise);
    const forget = () => work.delete(promise);
    void promise.then(forget, forget);
    return promise;
  };

  // --- persistence ---------------------------------------------------------

  const serialize = () => ({
    version: JOBS_FILE_VERSION,
    revision,
    jobs: Array.from(jobs.values()),
  });

  const parseStoredJob = (value) => {
    const parsed = storedJobSchema.safeParse(value);
    if (!parsed.success) return null;
    const sent = parsed.data.status === 'sent';
    try {
      const { message, sendConfig } = (sent ? parseSentJobMessage : parseJobMessage)(parsed.data.message, parsed.data.sendConfig);
      // A sent job is past its send; only an open one can have been cut off
      // mid-send. A send that started is no longer waiting.
      const delivery = sent ? null : parsed.data.delivery;
      return { ...parsed.data, message, sendConfig, delivery, waiting: sent || delivery ? null : parsed.data.waiting };
    } catch {
      return null;
    }
  };

  /**
   * Keeps the bytes of a file this version cannot use, so no write replaces
   * them. A rename that fails fails the load, and every change is refused
   * until a load succeeds.
   */
  const setAside = async (reason) => {
    const backup = `${filePath}.corrupt-${now()}`;
    await fs.promises.rename(filePath, backup);
    console.warn(`[goal-spec-jobs] ${reason}; the jobs file was moved to ${backup}`);
  };

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (errorCodeSchema.safeParse(error).data?.code === 'ENOENT') return { revision: 0, jobs: [], rewrite: false };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Malformed is a failure, not an empty list: keep the bytes for the
      // user and start over rather than overwriting them on the next write.
      await setAside(`the jobs file is not JSON (${describeError(error, 'invalid JSON')})`);
      return { revision: 0, jobs: [], rewrite: false };
    }
    const stored = storedFileSchema.safeParse(parsed);
    if (!stored.success) {
      // An unknown version may be a newer release's file: it is kept as it is.
      await setAside('the jobs file has an unknown version or shape');
      return { revision: 0, jobs: [], rewrite: false };
    }
    const kept = [];
    for (const value of stored.data.jobs) {
      const job = parseStoredJob(value);
      if (job && !kept.some((other) => other.id === job.id || other.sessionId === job.sessionId)) kept.push(job);
    }
    const dropped = stored.data.jobs.length - kept.length;
    if (dropped === 0) return { revision: stored.data.revision, jobs: kept, rewrite: false };
    // One bad job does not cost the others: they stay, and the original
    // bytes, the bad job included, are kept beside the file.
    await setAside(`${dropped} job(s) in the jobs file failed validation`);
    return { revision: stored.data.revision, jobs: kept, rewrite: kept.length > 0 };
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const job of stored.jobs) jobs.set(job.id, job);
          revision = Math.max(revision, stored.revision);
          // The file was moved aside: its valid jobs are written back at once.
          if (stored.rewrite) void persist();
          for (const job of Array.from(jobs.values())) {
            if (job.delivery) releaseDelivery(job, RESTART_REASON);
          }
        })
        .catch((error) => {
          // A read failure must not read as "no jobs": the next write would
          // clobber the file, so writes wait for a later load that succeeds.
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const writeJobsFile = async (payload) => {
    await fs.promises.mkdir(dataDir, { recursive: true });
    // `writeFileAtomic` keeps the mode of the file it replaces, so the file
    // is created owner-only before its first write.
    if (!fs.existsSync(filePath)) fs.closeSync(fs.openSync(filePath, 'a', JOBS_FILE_MODE));
    writeFileAtomic(filePath, payload);
  };

  /** Chains one write of the jobs as they are now; the answer rejects when that write failed. */
  const persist = () => {
    const payload = JSON.stringify(serialize());
    const written = writePromise.then(() => writeJobsFile(payload));
    writePromise = written.catch((error) => {
      console.warn('[goal-spec-jobs] failed to persist jobs:', describeError(error, 'write failed'));
    });
    return written;
  };

  // --- views ---------------------------------------------------------------

  const jobForSession = (sessionId) => {
    for (const job of jobs.values()) {
      if (job.sessionId === sessionId) return job;
    }
    return null;
  };

  // What clients see: the attachment payloads and the context stay on the
  // server, as they do for queued messages; the composer that sends the job
  // gets them back with `claim`.
  const toPublicJob = (job) => {
    const message = {
      content: job.message.content,
      text: job.message.text,
      attachments: job.message.attachments.map(summarizeAttachment),
      contextCount: contextCountOf(job.message),
    };
    if (job.message.agentMention) message.agentMention = job.message.agentMention;
    return {
      id: job.id,
      sessionId: job.sessionId,
      directory: job.directory,
      status: job.status,
      trigger: job.trigger,
      review: job.review,
      sendMode: job.sendMode,
      tokenBudget: job.tokenBudget,
      message,
      composerOnly: isComposerOnly(job),
      spec: job.spec,
      writer: { ...job.writer },
      sendConfig: { ...job.sendConfig },
      error: job.error,
      failedStep: job.failedStep,
      warning: job.warning,
      sending: job.delivery !== null,
      waiting: job.waiting !== null,
      // A composer's claim, waiting or handed over: its composer sends it, no other.
      claimId: job.waiting?.claimId ?? job.delivery?.claimId ?? null,
      // The user message a sent job sent, when OpenCode or the composer named it.
      messageId: job.messageId,
      // The session was made from a new-session draft for this job.
      newSession: job.newSession,
      outcome: job.outcome,
      attempt: job.attempt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  };

  const snapshot = () => ({ revision, jobs: Array.from(jobs.values()).map(toPublicJob) });

  /** Every change goes through here: bump, persist, broadcast. */
  const publish = (sessionId, job) => {
    revision += 1;
    latestWrite = persist();
    broadcastGlobalUiEvent?.({
      type: 'openchamber:goal-spec-job.updated',
      properties: { revision, sessionId, job: job ? toPublicJob(job) : null },
    });
    return { revision, job: job ? toPublicJob(job) : null };
  };

  const touch = (job) => {
    job.updatedAt = Math.max(now(), job.updatedAt + 1);
  };

  const clearClaimTimer = (jobId) => {
    clearTimeout(claimTimers.get(jobId));
    claimTimers.delete(jobId);
  };

  const clearTurnTimer = (jobId) => {
    clearTimeout(turnTimers.get(jobId));
    turnTimers.delete(jobId);
  };

  /** Ends an open job without sending it; the broadcast carries the cancelled state once. */
  const cancel = (job) => {
    stopWriter(job.id);
    clearClaimTimer(job.id);
    clearTurnTimer(job.id);
    turnFailures.delete(job.id);
    jobs.delete(job.id);
    job.status = 'cancelled';
    job.delivery = null;
    job.waiting = null;
    touch(job);
    return publish(job.sessionId, job);
  };

  const remove = (job) => {
    jobs.delete(job.id);
    return publish(job.sessionId, null);
  };

  /** An open job is cancelled, a sent card removed. */
  const end = (job) => (OPEN_STATUSES.has(job.status) ? cancel(job) : remove(job));

  const prune = () => {
    const cutoff = now() - SETTLED_JOB_TTL_MS;
    for (const job of Array.from(jobs.values())) {
      if (!OPEN_STATUSES.has(job.status) && job.updatedAt < cutoff) remove(job);
    }
  };

  /** At the cap the sent card, else the open job, that changed longest ago makes room; a send under way never does. */
  const makeRoom = () => {
    const byAge = (left, right) => left.updatedAt - right.updatedAt;
    const idle = Array.from(jobs.values()).filter((job) => !job.delivery);
    const oldest = idle.filter((job) => !OPEN_STATUSES.has(job.status)).sort(byAge)[0]
      ?? idle.filter((job) => OPEN_STATUSES.has(job.status)).sort(byAge)[0];
    if (!oldest) throw httpError('too many goal specs are being sent', 409);
    end(oldest);
  };

  const requireJob = (jobId) => {
    const job = jobs.get(jobId);
    if (!job) throw httpError('goal writer job not found', 404);
    return job;
  };

  const requireNotSending = (job) => {
    if (job.delivery) throw httpError('the message is being sent', 409);
  };

  /** A send waiting for the turn to end is taken back with "Back to edit"; nothing else changes it. */
  const requireNotWaiting = (job) => {
    if (job.waiting) throw httpError('the message waits for the agent to finish its turn', 409);
  };

  const requireOpen = (job) => {
    if (!OPEN_STATUSES.has(job.status)) throw httpError('the message was already sent', 409);
  };

  // --- writing -------------------------------------------------------------

  const readSettings = () => {
    try {
      return readWriterSettings();
    } catch (error) {
      console.warn('[goal-spec-jobs] could not read the goal writer settings:', describeError(error, 'read failed'));
      return {};
    }
  };

  const stopWriter = (jobId) => {
    writers.get(jobId)?.abort();
    writers.delete(jobId);
  };

  /** With review off, a written spec goes out at once, unless the composer has to send it or a send is under way. */
  const sendsByItself = (job) => job.status === 'ready' && !job.review && !job.delivery && !isComposerOnly(job);

  const runWriter = (job, settings) => {
    stopWriter(job.id);
    const controller = new AbortController();
    writers.set(job.id, controller);
    return track((async () => {
      let written = null;
      let failure = null;
      try {
        written = await writeSpec({
          request: job.message.text,
          conversation: job.writerInput.conversation,
          openItems: job.writerInput.openItems,
          directory: job.directory,
          providerID: job.sendConfig.providerID,
          modelID: job.sendConfig.modelID,
          signal: controller.signal,
          settings,
        });
      } catch (error) {
        failure = error;
      }
      if (writers.get(job.id) === controller) writers.delete(job.id);
      // Every redo, send of the original, cancel and stop aborts this write
      // first, so an aborted write's answer is never applied.
      const current = jobs.get(job.id);
      if (stopped || controller.signal.aborted || !current || current.status !== 'writing') return;
      if (failure) {
        current.status = 'failed';
        current.error = describeError(failure, 'the goal writer failed');
        current.failedStep = 'write';
        touch(current);
        publish(current.sessionId, current);
        return;
      }
      current.status = 'ready';
      current.spec = written.spec;
      current.writer = { ...current.writer, providerID: written.providerID, modelID: written.modelID };
      current.error = null;
      current.failedStep = null;
      touch(current);
      publish(current.sessionId, current);
      if (sendsByItself(current)) {
        await sendWhenFree(current, { kind: 'spec', sendMode: current.sendMode, spec: current.spec }).catch(() => undefined);
      }
    })());
  };

  // --- sending -------------------------------------------------------------

  // Session routes resolve the session's own location, so no directory goes along.
  const postToSession = async (sessionId, route, body) => {
    const fetchPath = `/api/session/${encodeURIComponent(sessionId)}/${route}`;
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', ...getOpenCodeAuthHeaders() };
    const response = await fetchImpl(buildOpenCodeUrl(fetchPath, ''), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw httpError(`OpenCode POST ${fetchPath} failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, response.status);
    }
    await assertPromptResponse(response, 'OpenCode dispatch');
    return unwrapOpenCodeResponse(await response.json().catch(() => null));
  };

  /**
   * The text the user chose, with its goal. Auto is resolved first, as the
   * OpenChamber session service does, and the session is switched onto the
   * model and agent before the goal is saved, so a send that cannot switch
   * leaves no goal behind. Then the goal (objective file and goal record, as
   * every server-created goal), the instructions derived from the text, the
   * project knowledge the session still owes and the goal reminder, and last
   * the prompt. The ones before the prompt are synthetic messages that start
   * no turn, as the composer sends them: the prompt starts one turn that
   * reads them all. A reminder sent after the prompt reached the agent in
   * the middle of that turn and was answered in a second one. The directory
   * is read at each step, since the session can move while the message goes
   * out.
   *
   * Answers the id OpenCode gave the prompt, which becomes the id of the
   * user message, and a warning or null: a goal reminder that cannot be sent
   * does not stop the message, which goes out without it.
   */
  const deliver = async (job, choice) => {
    const { sessionId, sendConfig } = job;
    const withGoal = choice.kind === 'spec' || job.trigger === 'armed';
    const text = choice.kind === 'spec' && choice.sendMode === 'goal-as-message' ? choice.spec : job.message.text;

    let model = { id: sendConfig.modelID, providerID: sendConfig.providerID };
    if (sendConfig.variant) model.variant = sendConfig.variant;
    let agent = sendConfig.agent;
    // The sentinel must never reach OpenCode.
    if (!resolveAutoSelection && isAutoModel(model)) throw new Error('Auto routing is not available on this server');
    const routed = await resolveAutoSelection?.({ sessionId, directory: job.directory, model, agent, requestText: text });
    if (routed) {
      model = routed.model;
      agent = routed.agent ?? agent;
    }
    // v2 selects model and agent on the session, not per prompt.
    await postToSession(sessionId, 'model', { model });
    if (agent) await postToSession(sessionId, 'agent', { agent });

    if (withGoal) {
      await createGoal({
        sessionID: sessionId,
        directory: job.directory,
        objective: choice.kind === 'spec' ? choice.spec : job.message.text,
        tokenBudget: job.tokenBudget,
        providerID: model.providerID,
        modelID: model.id,
        persistSessionGoal,
        // The writer wrote this objective, or the user chose their own text
        // over it: "rewrite every goal" leaves it alone, as in the UI.
        goalWriterSettings: { rewriteAll: false },
      });
    }

    const knowledge = sessionKnowledgeRuntime
      ? await sessionKnowledgeRuntime.resolvePendingForSession(sessionId, job.directory)
        .catch(() => ({ text: '', signature: '' }))
      : { text: '', signature: '' };
    const preamble = job.message.context
      .filter((part) => part.kind === 'instruction' && part.text.trim())
      .map((part) => ({ text: part.text, resume: false }));
    if (knowledge.text) preamble.push({ text: knowledge.text, resume: false });
    for (const synthetic of preamble) await postToSession(sessionId, 'synthetic', synthetic);

    let warning = null;
    if (withGoal) {
      // With the message sent as typed next to a spec, the reminder carries
      // the spec; a message that is the objective needs none.
      const briefing = choice.kind === 'spec' && choice.sendMode === 'with-message' ? choice.spec : null;
      await postToSession(sessionId, 'synthetic', { text: buildGoalIntroText(job.tokenBudget, briefing), resume: false })
        .catch((error) => {
          warning = `the goal reminder was not sent: ${describeError(error, 'request failed')}`;
        });
    }

    const prompt = { text };
    if (job.message.agentMention) prompt.agents = [{ name: job.message.agentMention }];
    const queued = queuedMessageSchema.safeParse(await postToSession(sessionId, 'prompt', prompt));
    // No item means nothing is queued, so the send must not count as done.
    if (!queued.success) throw new Error('OpenCode accepted the prompt but returned no queued message');

    if (knowledge.text && sessionKnowledgeRuntime) {
      // After the send is accepted, so a rejected send carries it again.
      await sessionKnowledgeRuntime.recordDelivered(sessionId, job.directory, knowledge.signature).catch(() => undefined);
    }
    try {
      onPromptSent?.(sessionId);
    } catch {
      // bookkeeping only
    }
    return { messageId: queued.data.id, warning };
  };

  const outcomeOf = (job, choice) => (choice.kind === 'spec'
    ? { kind: 'spec', sendMode: choice.sendMode }
    : { kind: 'original', withGoal: job.trigger === 'armed' });

  /**
   * A write the send stopped cannot resume, so an unsent job without a spec
   * has failed; the reason is the send's, whatever the status reads.
   */
  const settleOpenJob = (job, reason) => {
    if (job.status === 'writing' && !writers.has(job.id)) job.status = job.spec ? 'ready' : 'failed';
    job.error = reason;
    job.failedStep = 'send';
    touch(job);
  };

  /**
   * Puts the send on record before anything goes out: a restart that finds
   * it cannot tell whether the message went out. Throws when the record
   * could not be written; the caller then releases the job. A send that
   * waited for the turn to end stops waiting in the same record. `sender` is
   * `{ by: 'server' }`, or a composer with its claim.
   */
  const startDelivery = async (job, sender) => {
    job.delivery = { ...sender, startedAt: now() };
    job.waiting = null;
    clearTurnTimer(job.id);
    turnFailures.delete(job.id);
    touch(job);
    publish(job.sessionId, job);
    await latestWrite;
  };

  /** A send that did not go out, or may not have: the job waits for the user with the reason. */
  const releaseDelivery = (job, reason) => {
    clearClaimTimer(job.id);
    job.delivery = null;
    job.review = true;
    settleOpenJob(job, reason);
    return publish(job.sessionId, job);
  };

  /**
   * A sent job keeps what its card shows, and the id of the user message it
   * sent when OpenCode or the composer named it; the writer input and the
   * message payloads go. A send still waiting for the turn ends too: a
   * composer's late report that the message went out must not be followed by
   * the server's.
   */
  const markSent = (job, { outcome, spec, messageId, warning }) => {
    clearClaimTimer(job.id);
    clearTurnTimer(job.id);
    job.status = 'sent';
    job.outcome = outcome;
    if (spec) job.spec = spec;
    job.error = null;
    job.failedStep = null;
    job.warning = warning;
    job.messageId = messageId ?? null;
    job.delivery = null;
    job.waiting = null;
    job.message = toSentMessage(job.message);
    job.writerInput = {};
    touch(job);
  };

  /**
   * Sends the job from the server, once it is decided the message goes now
   * (`sendWhenFree`, or the look that found the turn over). A failure before
   * OpenCode queued the prompt leaves the job open with the reason and review
   * on, so nothing goes out again until the user decides; a goal already
   * saved stays, as it does for any send that fails after it.
   */
  const sendJob = async (job, choice) => {
    let sent;
    try {
      await startDelivery(job, { by: 'server' });
      sent = await deliver(job, choice);
    } catch (error) {
      const reason = describeError(error, 'the message could not be sent');
      console.warn(`[goal-spec-jobs] send to ${job.sessionId} failed:`, reason);
      const current = jobs.get(job.id);
      if (current) releaseDelivery(current, reason);
      throw httpError(reason, 502);
    }
    if (sent.warning) console.warn(`[goal-spec-jobs] message sent to ${job.sessionId}, but ${sent.warning}`);
    const current = jobs.get(job.id);
    // The session was deleted while the message went out.
    if (!current) return { revision, job: null };
    markSent(current, { outcome: outcomeOf(current, choice), spec: choice.kind === 'spec' ? choice.spec : null, ...sent });
    return publish(current.sessionId, current);
  };

  // --- waiting for the turn to end -------------------------------------------

  const activityProbe = createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs: FETCH_TIMEOUT_MS, fetchImpl });

  /** The follow-up setting; one that cannot be read is the default, queue. */
  const followUpBehavior = () => {
    try {
      return readFollowUpBehavior();
    } catch (error) {
      console.warn('[goal-spec-jobs] could not read the follow-up setting:', describeError(error, 'read failed'));
      return 'queue';
    }
  };

  /** The session's newest record in a list, or null when OpenCode could not be asked. */
  const fetchNewestRecords = async (job) => {
    const fetchPath = `/api/session/${encodeURIComponent(job.sessionId)}/message`;
    const query = new URLSearchParams({ limit: '1', directory: job.directory });
    try {
      const response = await fetchImpl(`${buildOpenCodeUrl(fetchPath, '')}?${query}`, {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const page = recordPageSchema.safeParse(await response.json());
      return page.success ? page.data.data : null;
    } catch {
      return null;
    }
  };

  /**
   * A reply still streaming is a turn OpenCode does not list as running, as
   * after a missed event. One begun before this server started never ends.
   */
  const isStreamingReply = (record) => {
    const reply = replyRecordSchema.safeParse(record);
    if (!reply.success || reply.data.time.completed !== undefined) return false;
    const { created } = reply.data.time;
    return created === undefined || created >= runtimeStartedAt;
  };

  /**
   * Where the session's turn stands, checked as the message queue checks
   * before it sends: `running` while OpenCode lists the session or its newest
   * reply still streams, `subagents` while a subagent of it works (the
   * session runs again on the subagent's result), else `over`. Null when
   * OpenCode could not be asked: unknown is never over.
   */
  const readTurn = async (job) => {
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!statuses) return null;
    if (statuses[job.sessionId]) return 'running';
    const records = await fetchNewestRecords(job);
    if (!records) return null;
    if (isStreamingReply(records[0])) return 'running';
    const subagents = await activityProbe.hasWorkingDescendants(job.sessionId, statuses);
    if (subagents === null) return null;
    return subagents ? 'subagents' : 'over';
  };

  /** Still waiting with this choice: not taken back, replaced, ended or already going out. */
  const stillWaiting = (job, waiting) => !stopped && jobs.get(job.id) === job && job.waiting === waiting;

  /** Looks at the session again after `delayMs`; a newer arm replaces a pending one. */
  const armTurnLook = (job, delayMs = turnQuietMs) => {
    clearTurnTimer(job.id);
    const timer = setTimeout(() => {
      turnTimers.delete(job.id);
      track(lookAtTurn(job));
    }, Math.max(0, delayMs));
    timer.unref?.();
    turnTimers.set(job.id, timer);
  };

  /**
   * A turn still going. The session's next idle event looks again while it
   * runs; a working subagent is looked at again after a while; a look
   * OpenCode did not answer is retried with backoff.
   */
  const waitOn = (job, turn) => {
    if (turn === null) {
      const failures = (turnFailures.get(job.id) ?? 0) + 1;
      turnFailures.set(job.id, failures);
      armTurnLook(job, turnRetryDelayMs(failures));
      return;
    }
    turnFailures.delete(job.id);
    if (turn === 'subagents') armTurnLook(job, subagentRecheckMs);
  };

  /**
   * One look for a waiting job. Once the turn is over the server sends its
   * own choice, and a composer's claim is handed to that composer.
   */
  const lookAtTurn = async (job) => {
    const { waiting } = job;
    if (!waiting || !stillWaiting(job, waiting)) return;
    // An idle event that lands during a look must not be lost: that look may
    // have seen the session running a moment before.
    if (turnLooks.has(job.id)) {
      armTurnLook(job);
      return;
    }
    turnLooks.add(job.id);
    try {
      const turn = await readTurn(job);
      if (!stillWaiting(job, waiting)) return;
      if (turn !== 'over') waitOn(job, turn);
      else if (waiting.claimId) await handOver(job, waiting.claimId).catch(() => undefined);
      else await sendJob(job, waiting.choice).catch(() => undefined);
    } finally {
      turnLooks.delete(job.id);
    }
  };

  /**
   * Sends what the user chose, or a written spec that sends itself, the way
   * a message from the composer goes out: into an idle session at once, and
   * into a working one as the user's follow-up setting says. Steer sends now
   * and joins the running turn. Queue, the default, keeps the choice on the
   * job (`waiting`, written to the file, so a restart keeps it) and sends it
   * once the turn is over. The choice is on the job before OpenCode is asked,
   * so no second send of the job can start meanwhile.
   */
  const sendWhenFree = async (job, choice) => {
    // Sending the original stops a write still running, before anything else.
    stopWriter(job.id);
    if (followUpBehavior() === 'steer') return sendJob(job, choice);
    const waiting = { choice, since: now() };
    job.waiting = waiting;
    const turn = await readTurn(job);
    if (!stillWaiting(job, waiting)) return { revision, job: jobs.get(job.id) === job ? toPublicJob(job) : null };
    if (turn === 'over') return sendJob(job, choice);
    touch(job);
    const result = publish(job.sessionId, job);
    waitOn(job, turn);
    return result;
  };

  // --- claims: the composer sends ------------------------------------------

  const holdClaim = (job) => {
    clearClaimTimer(job.id);
    const timer = setTimeout(() => {
      claimTimers.delete(job.id);
      const current = jobs.get(job.id);
      if (current?.delivery?.by === 'composer') releaseDelivery(current, 'the message was not sent');
    }, claimTtlMs);
    timer.unref?.();
    claimTimers.set(job.id, timer);
  };

  /**
   * The composer that claimed the job sends it now: the send goes on record
   * with the claim's id, which the projection names, so no other composer
   * takes it for its own. Its time to report starts here, so a claim that
   * waited for the turn never expires while it waits.
   */
  const handOver = async (job, claimId) => {
    holdClaim(job);
    try {
      await startDelivery(job, { by: 'composer', claimId });
    } catch (error) {
      const reason = describeError(error, 'the send could not be recorded');
      if (jobs.get(job.id) === job && job.delivery?.by === 'composer') releaseDelivery(job, reason);
      throw httpError(reason, 500);
    }
  };

  // --- public operations ---------------------------------------------------

  const create = async (input) => {
    const parsed = createInputSchema.parse(input);
    const { message, sendConfig } = parseJobMessage(parsed.message, parsed.sendConfig);
    await load();
    prune();
    const existing = jobForSession(parsed.sessionId);
    // A new job replaces the session's last one, unless that one is going out right now.
    if (existing) {
      requireNotSending(existing);
      end(existing);
    }
    if (jobs.size >= MAX_JOBS) makeRoom();
    const settings = readSettings();
    const createdAt = now();
    const job = {
      id: `goal-spec-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
      sessionId: parsed.sessionId,
      directory: parsed.directory,
      status: 'writing',
      trigger: parsed.trigger,
      review: parsed.review,
      sendMode: parsed.sendMode,
      tokenBudget: parsed.tokenBudget,
      message,
      sendConfig,
      writerInput: parsed.writerInput,
      spec: null,
      writer: describeWriter(settings, sendConfig),
      error: null,
      failedStep: null,
      warning: null,
      delivery: null,
      waiting: null,
      messageId: null,
      newSession: parsed.newSession,
      outcome: null,
      attempt: 1,
      createdAt,
      updatedAt: createdAt,
    };
    jobs.set(job.id, job);
    const result = publish(job.sessionId, job);
    runWriter(job, settings);
    return result;
  };

  const send = async (jobId, input) => {
    const choice = choiceSchema.parse(input);
    await load();
    const job = requireJob(jobId);
    requireNotSending(job);
    requireNotWaiting(job);
    requireOpen(job);
    if (isComposerOnly(job)) throw httpError('this message is sent from the session\'s composer', 409);
    if (choice.kind === 'spec' && job.status !== 'ready') throw httpError('the goal spec is not ready', 409);
    return sendWhenFree(job, choice);
  };

  const redo = async (jobId) => {
    await load();
    const job = requireJob(jobId);
    requireNotSending(job);
    requireNotWaiting(job);
    requireOpen(job);
    if (job.status === 'writing') throw httpError('the goal spec is still being written', 409);
    // Settings may have changed since the last write.
    const settings = readSettings();
    job.status = 'writing';
    job.attempt += 1;
    job.spec = null;
    job.error = null;
    job.failedStep = null;
    job.writer = describeWriter(settings, job.sendConfig);
    touch(job);
    const result = publish(job.sessionId, job);
    runWriter(job, settings);
    return result;
  };

  /** "Back to edit": the job ends and its message, payloads included, goes back to the composer. */
  const edit = async (jobId) => {
    await load();
    const job = requireJob(jobId);
    requireNotSending(job);
    requireOpen(job);
    return { ...cancel(job), message: job.message };
  };

  /**
   * The composer takes the full message to send it, and sends it the way a
   * message from the composer goes out: into an idle session at once, and
   * into a working one as the user's follow-up setting says. Steer hands it
   * over now. Queue, the default, keeps the claim on the job (`waiting`, so
   * nothing else sends it meanwhile) and hands it over once the turn is over;
   * the composer keeps the message until then. The answer names the claim
   * (`claimId`) and says whether it waits.
   */
  const claim = async (jobId, input) => {
    const { kind } = claimInputSchema.parse(input);
    await load();
    const job = requireJob(jobId);
    requireNotSending(job);
    requireNotWaiting(job);
    requireOpen(job);
    if (kind === 'spec' && job.status !== 'ready') throw httpError('the goal spec is not ready', 409);
    if (kind === 'original') stopWriter(job.id);
    const claimId = `claim-${now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    if (followUpBehavior() === 'queue') {
      const waiting = { claimId, since: now() };
      job.waiting = waiting;
      const turn = await readTurn(job);
      // Taken back, replaced or reported sent while OpenCode was asked.
      if (!stillWaiting(job, waiting)) throw httpError('the message was taken back or sent meanwhile', 409);
      if (turn !== 'over') {
        touch(job);
        const result = publish(job.sessionId, job);
        waitOn(job, turn);
        return { ...result, message: job.message };
      }
    }
    await handOver(job, claimId);
    // The session can be deleted while the record is written.
    if (jobs.get(job.id) !== job) throw httpError('goal writer job not found', 404);
    return { revision, job: toPublicJob(job), message: job.message };
  };

  /**
   * The composer reports its send: sent, or not sent with the reason. A
   * message the composer sent is out whether or not its claim is still held
   * (it expired, or the server restarted), so that report is taken for any
   * open job no send is under way for.
   */
  const settle = async (jobId, input) => {
    const { outcome, spec, messageId, error } = settleInputSchema.parse(input);
    await load();
    const job = requireJob(jobId);
    const claimed = job.delivery?.by === 'composer';
    const lateSuccess = !job.delivery && outcome !== null && OPEN_STATUSES.has(job.status);
    if (!claimed && !lateSuccess) throw httpError('the message is not being sent from a composer', 409);
    if (!outcome) return releaseDelivery(job, error ?? 'the message was not sent');
    markSent(job, { outcome, spec: outcome.kind === 'spec' ? spec : null, messageId, warning: null });
    return publish(job.sessionId, job);
  };

  /** Removes a sent card. An open job ends through a send or "Back to edit", never silently. */
  const dismiss = async (jobId) => {
    await load();
    const job = requireJob(jobId);
    if (OPEN_STATUSES.has(job.status)) throw httpError('the message has not been sent; send it or take it back to edit', 409);
    return remove(job);
  };

  // --- events and lifecycle --------------------------------------------------

  /** The session a payload ends: deleted in OpenCode, or archived in OpenChamber. */
  const endedSessionId = (value) => {
    const deleted = deletedSessionSchema.safeParse(value);
    if (deleted.success) return deleted.data.properties.info?.id ?? deleted.data.properties.sessionID ?? null;
    return archivedSessionSchema.safeParse(value).data?.properties.sessionID ?? null;
  };

  /** The waiting job of a session, if it has one. */
  const waitingJobFor = (sessionId) => {
    const job = jobForSession(sessionId);
    return job?.waiting ? job : null;
  };

  /**
   * A waiting job looks at its session when the session goes idle, and when a
   * reply finishes, which also covers an idle event that was missed. A busy
   * session drops the pending look; its next idle event arms another.
   */
  const noteTurnEvent = (value) => {
    const status = sessionStatusSchema.safeParse(value);
    if (status.success) {
      const job = waitingJobFor(status.data.properties.sessionID);
      if (!job) return;
      if (status.data.properties.status.type === 'idle') armTurnLook(job);
      else clearTurnTimer(job.id);
      return;
    }
    const reply = finishedReplySchema.safeParse(value);
    const job = reply.success ? waitingJobFor(reply.data.properties.info.sessionID) : null;
    if (job && !turnTimers.has(job.id)) armTurnLook(job);
  };

  /**
   * OpenCode events from the hub, and OpenChamber's archive broadcast: a job
   * ends with its session, an open job follows its session to another
   * directory, so the writer, Auto routing, the goal and the knowledge use
   * the current one, and a waiting job hears when the turn may be over.
   */
  const processPayload = (value) => {
    if (stopped || jobs.size === 0 || !HANDLED_EVENT_TYPES.has(value?.type)) return;
    if (value.type === 'session.status' || value.type === 'message.updated') {
      noteTurnEvent(value);
      return;
    }
    const moved = movedSessionSchema.safeParse(value);
    if (moved.success) {
      const { id, directory } = moved.data.properties.info;
      const job = jobForSession(id);
      if (!job || !OPEN_STATUSES.has(job.status) || job.directory === directory) return;
      job.directory = directory;
      touch(job);
      publish(job.sessionId, job);
      return;
    }
    const sessionId = endedSessionId(value);
    const job = sessionId ? jobForSession(sessionId) : null;
    if (job) end(job);
  };

  /**
   * Writes cut off by a restart start again, a written spec that sends itself
   * goes out, and a send waiting for the turn to end looks at the session.
   * A job with a send under way is never touched: its stopped write stays
   * stopped, and its message goes out once.
   */
  const resume = () => {
    if (stopped) return;
    for (const job of jobs.values()) {
      if (job.delivery) continue;
      if (job.waiting) {
        armTurnLook(job);
      } else if (job.status === 'writing' && !writers.has(job.id)) {
        runWriter(job, readSettings());
      } else if (sendsByItself(job)) {
        track(sendWhenFree(job, { kind: 'spec', sendMode: job.sendMode, spec: job.spec }).catch(() => undefined));
      }
    }
  };

  // Resumed work goes through OpenCode, so it waits for the event stream to
  // connect: at startup the server runs before OpenCode can be reached.
  const isOpenCodeConnected = () => globalEventHub === null || globalEventHub.isConnected?.() === true;

  const warnLoadFailed = (error) => {
    console.warn('[goal-spec-jobs] failed to load jobs:', describeError(error, 'read failed'));
  };

  const start = () => {
    const unsubscribeEvent = globalEventHub?.subscribeEvent((event) => {
      // The hub translates v2 wire events into the server's vocabulary once.
      for (const payload of event?.translated?.() ?? []) processPayload(payload);
    }) ?? (() => undefined);
    const unsubscribeStatus = globalEventHub?.subscribeStatus((status) => {
      if (hubStatusSchema.safeParse(status).data?.type === 'connect') void load().then(resume, warnLoadFailed);
    }) ?? (() => undefined);
    clearInterval(pruneTimer);
    pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
    pruneTimer.unref?.();
    void load()
      .then(() => {
        prune();
        if (isOpenCodeConnected()) resume();
      })
      .catch(warnLoadFailed);
    return () => {
      unsubscribeEvent();
      unsubscribeStatus();
    };
  };

  /** Stops writes, claims, waits and the sweep; answers once the last file write has finished, so shutdown can wait for it. */
  const stop = () => {
    stopped = true;
    clearInterval(pruneTimer);
    pruneTimer = null;
    for (const controller of writers.values()) controller.abort();
    writers.clear();
    for (const timer of claimTimers.values()) clearTimeout(timer);
    claimTimers.clear();
    for (const timer of turnTimers.values()) clearTimeout(timer);
    turnTimers.clear();
    return writePromise;
  };

  return {
    load,
    snapshot,
    create,
    send,
    redo,
    edit,
    claim,
    settle,
    dismiss,
    processPayload,
    start,
    stop,
    /** Waits for background writes and sends; tests use it. */
    whenIdle: async () => {
      while (work.size > 0) await Promise.allSettled(Array.from(work));
    },
    /** Drains the pending file write; tests use it. */
    flush: () => writePromise,
  };
}

export function registerGoalSpecJobRoutes(app, runtime) {
  const respondError = (res, error, fallback) => {
    const status = error instanceof TypeError || error instanceof z.ZodError
      ? 400
      : (Number.isInteger(error?.status) ? error.status : 500);
    if (status >= 500 && status !== 502) console.error(`[goal-spec-jobs] ${fallback}:`, error);
    res.status(status).json({ error: error instanceof z.ZodError ? 'invalid request' : describeError(error, fallback) });
  };
  const handle = (fallback, run) => async (req, res) => {
    try {
      res.json(await run(req));
    } catch (error) {
      respondError(res, error, fallback);
    }
  };

  app.get('/api/goals/spec-jobs', handle('Failed to load goal writer jobs', async () => {
    await runtime.load();
    return runtime.snapshot();
  }));
  app.post('/api/goals/spec-jobs', handle('Failed to start the goal writer', (req) => runtime.create(req.body)));
  app.post('/api/goals/spec-jobs/:jobId/send', handle('Failed to send the message', (req) => runtime.send(req.params.jobId, req.body)));
  app.post('/api/goals/spec-jobs/:jobId/redo', handle('Failed to write the goal spec again', (req) => runtime.redo(req.params.jobId)));
  app.post('/api/goals/spec-jobs/:jobId/edit', handle('Failed to take the message back', (req) => runtime.edit(req.params.jobId)));
  app.post('/api/goals/spec-jobs/:jobId/claim', handle('Failed to take the message to send', (req) => runtime.claim(req.params.jobId, req.body)));
  app.post('/api/goals/spec-jobs/:jobId/settle', handle('Failed to record the send', (req) => runtime.settle(req.params.jobId, req.body)));
  app.delete('/api/goals/spec-jobs/:jobId', handle('Failed to dismiss the goal spec', (req) => runtime.dismiss(req.params.jobId)));
}
