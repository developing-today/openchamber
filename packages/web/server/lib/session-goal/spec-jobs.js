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

import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { parseQueuedItemInput } from '../message-queue/runtime.js';
import { assertPromptResponse } from '../opencode/prompt-response.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { isAutoModel } from '../routing/defaults.js';
import { parseModelRef } from '../small-model/index.js';
import { buildGoalIntroText, createSessionGoal } from './create.js';
import { readGoalWriterSettings, writeGoalSpec } from './spec-writer.js';

const JOBS_FILE_NAME = 'goal-spec-jobs.json';
const JOBS_FILE_VERSION = 1;

const MAX_JOBS = 50;
// A sent card stays until it is dismissed, the session starts another job, or
// a day has passed.
const SETTLED_JOB_TTL_MS = 24 * 60 * 60 * 1000;
// A composer that claimed a job and went away (closed tab, lost connection)
// must not hold it forever.
const CLAIM_TTL_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
const OPEN_STATUSES = new Set(['writing', 'ready', 'failed']);

const statusSchema = z.enum(['writing', 'ready', 'failed', 'sent', 'cancelled']);
const triggerSchema = z.enum(['armed', 'auto-create']);
const sendModeSchema = z.enum(['with-message', 'goal-as-message']);
const writerSourceSchema = z.enum(['settings', 'session', 'small-model']);
const optionalText = z.string().optional().catch(undefined);
const nullableText = z.string().nullable().catch(null);

const writerInputSchema = z.object({
  conversation: optionalText,
  openItems: optionalText,
}).catch({});

const tokenBudgetSchema = z.number().int().positive().nullable().catch(null);

const createInputSchema = z.object({
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  directory: z.string().trim().min(1),
  trigger: triggerSchema,
  review: z.boolean(),
  sendMode: sendModeSchema,
  tokenBudget: tokenBudgetSchema.optional().transform((value) => value ?? null),
  writerInput: writerInputSchema.optional().transform((value) => value ?? {}),
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
  error: z.string().optional().catch(undefined),
});

const writerSchema = z.object({
  source: writerSourceSchema,
  providerID: nullableText,
  modelID: nullableText,
  variant: nullableText,
});

const storedJobSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  directory: z.string().min(1),
  status: statusSchema,
  trigger: triggerSchema,
  review: z.boolean(),
  sendMode: sendModeSchema,
  tokenBudget: tokenBudgetSchema,
  message: z.unknown(),
  sendConfig: z.unknown(),
  writerInput: writerInputSchema,
  spec: nullableText,
  writer: writerSchema,
  error: nullableText,
  outcome: outcomeSchema.nullable().catch(null),
  attempt: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const storedFileSchema = z.object({
  revision: z.number().int().nonnegative().catch(0),
  jobs: z.array(z.unknown()).catch([]),
});

const errorCodeSchema = z.object({ code: z.string() });
const deletedSessionSchema = z.object({
  type: z.literal('session.deleted'),
  properties: z.object({
    info: z.object({ id: z.string().min(1) }).optional().catch(undefined),
    sessionID: z.string().min(1).optional().catch(undefined),
  }),
});
const hubStatusSchema = z.object({ type: z.string() });

const httpError = (message, status) => Object.assign(new Error(message), { status });

const describeError = (error, fallback) => (error instanceof Error && error.message ? error.message : fallback);

/**
 * The captured message and its send settings, validated like a queued
 * message: a job must never hold a message nobody could send. The writer
 * works from the text, so a job without text is refused.
 */
const parseJobMessage = (message, sendConfig) => {
  const item = parseQueuedItemInput({ ...z.record(z.string(), z.unknown()).catch({}).parse(message), sendConfig });
  if (!item.text.trim()) throw new TypeError('the goal writer needs the message text');
  const captured = { content: item.content, text: item.text, attachments: item.attachments, context: item.context };
  if (item.agentMention) captured.agentMention = item.agentMention;
  return { message: captured, sendConfig: item.sendConfig };
};

/**
 * Attachments and attached context items go out through the session's
 * composer; the server sends text, the agent mention and the instructions
 * derived from the text.
 */
const isComposerOnly = (job) => job.message.attachments.length > 0
  || job.message.context.some((part) => part.kind !== 'instruction');

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
  createGoal = createSessionGoal,
  fetchImpl = fetch,
  now = Date.now,
  claimTtlMs = CLAIM_TTL_MS,
}) {
  const filePath = path.join(dataDir, JOBS_FILE_NAME);

  /** jobId → job; at most one job per session. */
  const jobs = new Map();
  let revision = 0;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  let stopped = false;

  // In memory only: a restart has no write, send or claim in flight.
  const writers = new Map(); // jobId → AbortController
  const sending = new Set(); // jobId: the server is sending it
  const claims = new Map(); // jobId → { expiresAt, timer }: a composer is sending it
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
    try {
      const { message, sendConfig } = parseJobMessage(parsed.data.message, parsed.data.sendConfig);
      return { ...parsed.data, message, sendConfig };
    } catch {
      return null;
    }
  };

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (errorCodeSchema.safeParse(error).data?.code === 'ENOENT') return { revision: 0, jobs: [] };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Malformed is a failure, not an empty list: keep the bytes for the
      // user and start over rather than overwriting them on the next write.
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      console.warn(`[goal-spec-jobs] jobs file was unreadable and moved to ${backup}: ${describeError(error, 'invalid JSON')}`);
      return { revision: 0, jobs: [] };
    }
    const stored = storedFileSchema.catch({ revision: 0, jobs: [] }).parse(parsed);
    return { revision: stored.revision, jobs: stored.jobs.map(parseStoredJob).filter(Boolean) };
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const job of stored.jobs) {
            if (!jobForSession(job.sessionId)) jobs.set(job.id, job);
          }
          revision = Math.max(revision, stored.revision);
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

  const persist = () => {
    const payload = JSON.stringify(serialize());
    writePromise = writePromise
      .then(async () => {
        await fs.promises.mkdir(dataDir, { recursive: true });
        const tmpPath = `${filePath}.${process.pid}.tmp`;
        // Messages are conversation content: readable by the owner only.
        await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
        await fs.promises.rename(tmpPath, filePath);
      })
      .catch((error) => {
        console.warn('[goal-spec-jobs] failed to persist jobs:', describeError(error, 'write failed'));
      });
    return writePromise;
  };

  // --- views ---------------------------------------------------------------

  const jobForSession = (sessionId) => {
    for (const job of jobs.values()) {
      if (job.sessionId === sessionId) return job;
    }
    return null;
  };

  const isClaimed = (jobId) => claims.has(jobId);

  // What clients see: the attachment payloads and the context stay on the
  // server, as they do for queued messages; the composer that sends the job
  // gets them back with `claim`.
  const toPublicJob = (job) => {
    const message = {
      content: job.message.content,
      text: job.message.text,
      attachments: job.message.attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
      })),
      contextCount: job.message.context.filter((part) => part.kind !== 'instruction').length,
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
      sending: sending.has(job.id) || isClaimed(job.id),
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
    void persist();
    broadcastGlobalUiEvent?.({
      type: 'openchamber:goal-spec-job.updated',
      properties: { revision, sessionId, job: job ? toPublicJob(job) : null },
    });
    return { revision, job: job ? toPublicJob(job) : null };
  };

  const touch = (job) => {
    job.updatedAt = Math.max(now(), job.updatedAt + 1);
  };

  /** Ends an open job without sending it; the broadcast carries the cancelled state once. */
  const cancel = (job) => {
    stopWriter(job.id);
    releaseClaim(job.id);
    jobs.delete(job.id);
    job.status = 'cancelled';
    touch(job);
    return publish(job.sessionId, job);
  };

  const remove = (job) => {
    jobs.delete(job.id);
    return publish(job.sessionId, null);
  };

  const prune = () => {
    const cutoff = now() - SETTLED_JOB_TTL_MS;
    for (const job of Array.from(jobs.values())) {
      if (!OPEN_STATUSES.has(job.status) && job.updatedAt < cutoff) remove(job);
    }
  };

  const requireJob = (jobId) => {
    const job = jobs.get(jobId);
    if (!job) throw httpError('goal writer job not found', 404);
    return job;
  };

  const requireNotSending = (job) => {
    if (sending.has(job.id) || isClaimed(job.id)) throw httpError('the message is being sent', 409);
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

  /** With review off, a written spec goes out at once, unless the composer has to send it. */
  const sendsByItself = (job) => job.status === 'ready' && !job.review && !isComposerOnly(job);

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
        touch(current);
        publish(current.sessionId, current);
        return;
      }
      current.status = 'ready';
      current.spec = written.spec;
      current.writer = { ...current.writer, providerID: written.providerID, modelID: written.modelID };
      current.error = null;
      touch(current);
      publish(current.sessionId, current);
      if (sendsByItself(current)) {
        await sendJob(current, { kind: 'spec', sendMode: current.sendMode, spec: current.spec }).catch(() => undefined);
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
   * The text the user chose, with its goal: the objective file and the goal
   * record first (as every server-created goal), the session switched onto the
   * captured model and agent, the instructions derived from the text and the
   * project knowledge the session still owes, then the prompt and the goal
   * reminder after it ("the user message above").
   */
  const deliver = async (job, choice) => {
    const { sessionId, directory, sendConfig } = job;
    const withGoal = choice.kind === 'spec' || job.trigger === 'armed';
    const text = choice.kind === 'spec' && choice.sendMode === 'goal-as-message' ? choice.spec : job.message.text;

    if (withGoal) {
      await createGoal({
        sessionID: sessionId,
        directory,
        objective: choice.kind === 'spec' ? choice.spec : job.message.text,
        tokenBudget: job.tokenBudget,
        providerID: sendConfig.providerID,
        modelID: sendConfig.modelID,
        persistSessionGoal,
        // The writer wrote this objective, or the user chose their own text
        // over it: "rewrite every goal" leaves it alone, as in the UI.
        goalWriterSettings: { rewriteAll: false },
      });
    }

    let model = { id: sendConfig.modelID, providerID: sendConfig.providerID };
    if (sendConfig.variant) model.variant = sendConfig.variant;
    let agent = sendConfig.agent;
    const routed = await resolveAutoSelection?.({ sessionId, directory, model, agent, requestText: text });
    if (routed) {
      model = routed.model;
      agent = routed.agent ?? agent;
    }
    // v2 selects model and agent on the session, not per prompt.
    await postToSession(sessionId, 'model', { model });
    if (agent) await postToSession(sessionId, 'agent', { agent });

    const knowledge = sessionKnowledgeRuntime
      ? await sessionKnowledgeRuntime.resolvePendingForSession(sessionId, directory)
        .catch(() => ({ text: '', signature: '' }))
      : { text: '', signature: '' };
    const preamble = job.message.context
      .filter((part) => part.kind === 'instruction' && part.text.trim())
      .map((part) => ({ text: part.text, resume: false }));
    if (knowledge.text) preamble.push({ text: knowledge.text, resume: false });
    for (const synthetic of preamble) await postToSession(sessionId, 'synthetic', synthetic);

    const prompt = { text };
    if (job.message.agentMention) prompt.agents = [{ name: job.message.agentMention }];
    await postToSession(sessionId, 'prompt', prompt);

    if (withGoal) {
      // With the message sent as typed next to a spec, the reminder carries
      // the spec; a message that is the objective needs none.
      const briefing = choice.kind === 'spec' && choice.sendMode === 'with-message' ? choice.spec : null;
      await postToSession(sessionId, 'synthetic', { text: buildGoalIntroText(job.tokenBudget, briefing), resume: false });
    }
    if (knowledge.text && sessionKnowledgeRuntime) {
      // After the send is accepted, so a rejected send carries it again.
      await sessionKnowledgeRuntime.recordDelivered(sessionId, directory, knowledge.signature).catch(() => undefined);
    }
    try {
      onPromptSent?.(sessionId);
    } catch {
      // bookkeeping only
    }
  };

  const outcomeOf = (job, choice) => (choice.kind === 'spec'
    ? { kind: 'spec', sendMode: choice.sendMode }
    : { kind: 'original', withGoal: job.trigger === 'armed' });

  /**
   * Sends the job from the server. A failure leaves the job open with the
   * reason and review on, so nothing goes out again until the user decides;
   * a goal already saved stays, as it does for any send that fails after it.
   */
  const sendJob = async (job, choice) => {
    // Sending the original stops a write still running.
    stopWriter(job.id);
    sending.add(job.id);
    touch(job);
    publish(job.sessionId, job);
    try {
      await deliver(job, choice);
    } catch (error) {
      sending.delete(job.id);
      const reason = describeError(error, 'the message could not be sent');
      console.warn(`[goal-spec-jobs] send to ${job.sessionId} failed:`, reason);
      const current = jobs.get(job.id);
      if (current) {
        current.status = current.spec ? 'ready' : 'failed';
        current.review = true;
        current.error = reason;
        touch(current);
        publish(current.sessionId, current);
      }
      throw httpError(reason, 502);
    }
    sending.delete(job.id);
    const current = jobs.get(job.id);
    // The session was deleted while the message went out.
    if (!current) return { revision, job: null };
    current.status = 'sent';
    current.outcome = outcomeOf(current, choice);
    if (choice.kind === 'spec') current.spec = choice.spec;
    current.error = null;
    touch(current);
    return publish(current.sessionId, current);
  };

  // --- claims: the composer sends ------------------------------------------

  const releaseClaim = (jobId) => {
    clearTimeout(claims.get(jobId));
    claims.delete(jobId);
  };

  /** A write the claim stopped cannot resume, so an unsent job without a spec has failed. */
  const settleOpenJob = (job, reason) => {
    if (job.status === 'writing' && !writers.has(job.id)) job.status = job.spec ? 'ready' : 'failed';
    job.error = reason;
    touch(job);
  };

  const holdClaim = (job) => {
    releaseClaim(job.id);
    const timer = setTimeout(() => {
      claims.delete(job.id);
      const current = jobs.get(job.id);
      if (!current || !OPEN_STATUSES.has(current.status)) return;
      current.review = true;
      settleOpenJob(current, 'the message was not sent');
      publish(current.sessionId, current);
    }, claimTtlMs);
    timer.unref?.();
    claims.set(job.id, timer);
  };

  // --- public operations ---------------------------------------------------

  const create = async (input) => {
    const parsed = createInputSchema.parse(input);
    const { message, sendConfig } = parseJobMessage(parsed.message, parsed.sendConfig);
    await load();
    prune();
    const existing = jobForSession(parsed.sessionId);
    if (existing && OPEN_STATUSES.has(existing.status)) {
      throw httpError('the session already has a goal spec waiting', 409);
    }
    if (existing) remove(existing);
    if (jobs.size >= MAX_JOBS) {
      const settled = Array.from(jobs.values())
        .filter((job) => !OPEN_STATUSES.has(job.status))
        .sort((left, right) => left.updatedAt - right.updatedAt);
      if (settled.length === 0) throw httpError('too many goal specs are waiting', 409);
      remove(settled[0]);
    }
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
    if (isComposerOnly(job)) throw httpError('this message is sent from the session\'s composer', 409);
    if (choice.kind === 'spec' ? job.status !== 'ready' : !OPEN_STATUSES.has(job.status)) {
      throw httpError('the goal spec is not ready', 409);
    }
    return sendJob(job, choice);
  };

  const redo = async (jobId) => {
    await load();
    const job = requireJob(jobId);
    requireNotSending(job);
    if (job.status !== 'ready' && job.status !== 'failed') throw httpError('the goal spec is still being written', 409);
    // Settings may have changed since the last write.
    const settings = readSettings();
    job.status = 'writing';
    job.attempt += 1;
    job.spec = null;
    job.error = null;
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
    if (!OPEN_STATUSES.has(job.status)) throw httpError('the message was already sent', 409);
    return { ...cancel(job), message: job.message };
  };

  /** The composer takes the full message to send it; the job shows it is being sent. */
  const claim = async (jobId, input) => {
    const { kind } = claimInputSchema.parse(input);
    await load();
    const job = requireJob(jobId);
    requireNotSending(job);
    if (kind === 'spec' ? job.status !== 'ready' : !OPEN_STATUSES.has(job.status)) {
      throw httpError('the goal spec is not ready', 409);
    }
    if (kind === 'original') stopWriter(job.id);
    holdClaim(job);
    touch(job);
    return { ...publish(job.sessionId, job), message: job.message };
  };

  /** The composer reports its send: sent, or not sent with the reason. */
  const settle = async (jobId, input) => {
    const { outcome, spec, error } = settleInputSchema.parse(input);
    await load();
    const job = requireJob(jobId);
    if (!isClaimed(job.id)) throw httpError('the message is not being sent from a composer', 409);
    releaseClaim(job.id);
    if (outcome) {
      job.status = 'sent';
      job.outcome = outcome;
      if (outcome.kind === 'spec' && spec) job.spec = spec;
      job.error = null;
      touch(job);
    } else {
      job.review = true;
      settleOpenJob(job, error ?? 'the message was not sent');
    }
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

  const processPayload = (value) => {
    if (stopped) return;
    const deleted = deletedSessionSchema.safeParse(value);
    if (!deleted.success) return;
    const sessionId = deleted.data.properties.info?.id ?? deleted.data.properties.sessionID;
    const job = sessionId ? jobForSession(sessionId) : null;
    if (!job) return;
    if (OPEN_STATUSES.has(job.status)) cancel(job);
    else remove(job);
  };

  /** Writes cut off by a restart start again; a written spec that sends itself goes out. */
  const resume = () => {
    if (stopped) return;
    for (const job of jobs.values()) {
      if (job.status === 'writing' && !writers.has(job.id)) {
        runWriter(job, readSettings());
      } else if (sendsByItself(job) && !sending.has(job.id)) {
        track(sendJob(job, { kind: 'spec', sendMode: job.sendMode, spec: job.spec }).catch(() => undefined));
      }
    }
  };

  const start = () => {
    const unsubscribeEvent = globalEventHub?.subscribeEvent((event) => {
      // The hub translates v2 wire events into the server's vocabulary once.
      for (const payload of event?.translated?.() ?? []) processPayload(payload);
    }) ?? (() => undefined);
    const unsubscribeStatus = globalEventHub?.subscribeStatus((status) => {
      if (hubStatusSchema.safeParse(status).data?.type === 'connect') resume();
    }) ?? (() => undefined);
    void load()
      .then(() => {
        prune();
        resume();
      })
      .catch((error) => {
        console.warn('[goal-spec-jobs] failed to load jobs:', describeError(error, 'read failed'));
      });
    return () => {
      unsubscribeEvent();
      unsubscribeStatus();
    };
  };

  const stop = () => {
    stopped = true;
    for (const controller of writers.values()) controller.abort();
    writers.clear();
    for (const jobId of Array.from(claims.keys())) releaseClaim(jobId);
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
    /** Drains the pending file write; tests and shutdown use it. */
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
