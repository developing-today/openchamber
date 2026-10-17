/**
 * Inter-session messaging from OpenCode's `/api/messaging/*` routes: topics,
 * messages, session chains and logs, template variables and the local
 * embedding model, translated into the shapes the Messages panel, the chat
 * notices and Settings → Messaging read.
 *
 * The routes come from the OpenCode build this fork pairs with. The pinned
 * `@opencode/client` predates them, so this module calls them through
 * `runtimeFetch` and parses every response with zod; it is the only place
 * that knows their wire shapes. The routes are global: they take no directory
 * and start no location.
 *
 * A server without the routes answers 404 to the model status probe, which
 * `probeMessaging` reports as `unsupported`. Every other failure throws an
 * `OpencodeApiError` that keeps the HTTP status and OpenCode's message; a
 * failed read is never an empty result.
 */

import { z } from "zod"

import { OpencodeApiError, normalizeOpencodeError, validateRuntimeResponse } from "./client"
import type { Message } from "./model"
import { runtimeFetch } from "@/lib/runtime-fetch"

export type MessagingDelivery = "none" | "inbox" | "wake"
export type MessagingWriteMode = "open" | "readonly" | "limited"
export type MessagingMatchMode = "exact" | "regex" | "fuzzy" | "semantic" | "hybrid" | "advanced"
type MessagingHiddenMode = "exclude" | "include" | "only"
export type MessagingLogPart =
  | "user"
  | "output"
  | "thinking"
  | "tools"
  | "results"
  | "system"
  | "synthetic"
  | "shell"
  | "events"
  | "compaction"

export const MESSAGING_MATCH_MODES: readonly MessagingMatchMode[] = ["hybrid", "semantic", "fuzzy", "exact", "regex", "advanced"]
export const MESSAGING_DELIVERIES: readonly MessagingDelivery[] = ["none", "inbox", "wake"]
/** Log parts in the order the panel offers them. */
export const MESSAGING_LOG_PARTS: readonly MessagingLogPart[] = [
  "user",
  "output",
  "thinking",
  "tools",
  "results",
  "system",
  "synthetic",
  "shell",
  "compaction",
  "events",
]

/** The writer OpenCode records for messages a person sends through the API. */
export const MESSAGING_USER = "user"

const deliverySchema = z.enum(["none", "inbox", "wake"])
const writeModeSchema = z.enum(["open", "readonly", "limited"])
const matchSchema = z.enum(["exact", "regex", "fuzzy", "semantic", "hybrid", "advanced"])
const logPartSchema = z.enum(["user", "output", "thinking", "tools", "results", "system", "synthetic", "shell", "events", "compaction"])

/**
 * OpenCode encodes a non-finite number as a string. Optional times read such a
 * value as absent instead of failing the whole record.
 */
const optionalTime = z.number().optional().catch(undefined)

const writerSchema = z.object({
  session: z.string(),
  children: z.boolean().optional(),
  ancestors: z.boolean().optional(),
})
export type MessagingWriter = z.infer<typeof writerSchema>

const participantSchema = z.object({
  session: z.string(),
  title: z.string().optional(),
  reads: z.number(),
  writes: z.number(),
  first: optionalTime,
  last: optionalTime,
})

const windowSchema = z.object({
  total: z.number(),
  first: z.array(participantSchema),
  latest: z.array(participantSchema),
})

const topicSchema = z.object({
  name: z.string(),
  exists: z.boolean(),
  kind: z.string(),
  preset: z.string().optional(),
  owner: z.string().optional(),
  creator: z.string().optional(),
  description: z.string().optional(),
  mode: writeModeSchema,
  writers: z.array(writerSchema),
  policy: z.string(),
  messages: z.number(),
  created: optionalTime,
  last: optionalTime,
  unread: z.number().optional(),
  subscribed: deliverySchema.optional(),
  writersWindow: windowSchema.optional(),
  readersWindow: windowSchema.optional(),
  allowedWindow: windowSchema.optional(),
})
export type MessagingTopic = z.infer<typeof topicSchema>

const opSchema = z.object({
  seq: z.number(),
  kind: z.string(),
  writer: z.string(),
  time: z.number(),
  viewers: z.array(z.string()),
  reason: z.string().optional(),
})
export type MessagingOp = z.infer<typeof opSchema>

const messageSchema = z.object({
  id: z.number(),
  topic: z.string(),
  seq: z.number(),
  kind: z.string(),
  type: z.string(),
  writer: z.string(),
  time: z.number(),
  data: z.string(),
  reply: z.number().optional(),
  hidden: z.boolean().default(false),
  score: z.number().optional(),
  ops: z.array(opSchema).optional(),
})
export type MessagingMessage = z.infer<typeof messageSchema>

const sendResultSchema = z.object({
  topic: z.string(),
  seq: z.number(),
  created: z.boolean(),
  forced: z.boolean().default(false),
  delivered: z.array(z.object({ session: z.string(), delivery: deliverySchema })),
})
export type MessagingSendResult = z.infer<typeof sendResultSchema>

const visibilityResultSchema = z.object({
  topic: z.string(),
  seq: z.number(),
  targets: z.array(z.number()),
  viewers: z.array(z.string()),
  default: z.boolean(),
})

const sessionBriefSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  agent: z.string().optional(),
  status: z.enum(["running", "idle"]),
  created: optionalTime,
  updated: optionalTime,
})

const sessionNodeSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  parentID: z.string().optional(),
  depth: z.number(),
  agent: z.string().optional(),
  model: z.string().optional(),
  directory: z.string(),
  status: z.enum(["running", "idle"]),
  project: z.string().optional(),
  original: z.string().optional(),
  created: optionalTime,
  updated: optionalTime,
  outcome: z.string().optional(),
  children: z.number().optional(),
  descendants: z.number().optional(),
  messages: z.number().optional(),
  cost: z.number().optional(),
  tokens: z.number().optional(),
  topics: z.number().optional(),
  childWindow: z.object({ total: z.number(), first: z.array(sessionBriefSchema), latest: z.array(sessionBriefSchema) }).optional(),
})
export type MessagingSessionNode = z.infer<typeof sessionNodeSchema>

const chainSchema = z.object({ chain: z.array(sessionNodeSchema), root: z.string(), depth: z.number() })
export type MessagingChain = z.infer<typeof chainSchema>

const logEntrySchema = z.object({
  session: z.string(),
  message: z.string(),
  index: z.number(),
  part: logPartSchema,
  time: z.number(),
  text: z.string(),
  tool: z.string().optional(),
  match: z.boolean().optional(),
  score: z.number().optional(),
})
export type MessagingLogEntry = z.infer<typeof logEntrySchema>

const varSchema = z.object({
  name: z.string(),
  kind: z.enum(["constant", "context", "time", "custom"]),
  description: z.string(),
  template: z.string().optional(),
  value: z.string().optional(),
  scope: z.string().optional(),
})
export type MessagingVar = z.infer<typeof varSchema>

const presetSchema = z.object({
  name: z.string(),
  template: z.string(),
  description: z.string(),
  policy: z.string(),
  value: z.string().optional(),
})

const modelTierSchema = z.object({
  name: z.string(),
  model: z.string(),
  size: z.string(),
  hardware: z.string(),
  available: z.boolean(),
})

const modelStatusSchema = z.object({
  state: z.enum(["off", "unavailable", "pending", "downloading", "starting", "ready", "error"]),
  tier: z.string().optional(),
  model: z.string().optional(),
  dimensions: z.number().optional(),
  path: z.string().optional(),
  source: z.string().optional(),
  server: z.string().optional(),
  endpoint: z.string().optional(),
  remote: z.boolean().default(false),
  progress: z.array(z.object({ file: z.string(), received: z.number(), total: z.number().optional() })).default([]),
  error: z.string().optional(),
  indexed: z.number().optional(),
  pending: z.number().optional(),
  tiers: z.array(modelTierSchema).default([]),
})
export type MessagingModelStatus = z.infer<typeof modelStatusSchema>

/**
 * Parses a list item by item, so one record OpenCode wrote in a shape this
 * build does not know drops out alone instead of failing the whole list.
 */
const listOf = <T extends z.ZodType>(schema: T) =>
  z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      const parsed = schema.safeParse(item)
      return parsed.success ? [parsed.data] : []
    }),
  )

const topicListSchema = z.object({ topics: listOf(topicSchema), total: z.number() })
const queryResultSchema = z.object({
  messages: listOf(messageSchema),
  more: z.boolean(),
  match: matchSchema.optional(),
  note: z.string().optional(),
})
export type MessagingQueryResult = z.infer<typeof queryResultSchema>
const sessionListSchema = z.object({ sessions: listOf(sessionNodeSchema), total: z.number() })
type MessagingSessionList = z.infer<typeof sessionListSchema>
const logSchema = z.object({
  entries: listOf(logEntrySchema),
  total: z.number(),
  more: z.boolean(),
  match: matchSchema.optional(),
  note: z.string().optional(),
})
export type MessagingLog = z.infer<typeof logSchema>
const varsSchema = z.object({ presets: listOf(presetSchema), vars: listOf(varSchema), rendered: z.string().optional() })
export type MessagingVars = z.infer<typeof varsSchema>

/** Every messaging route wraps its answer in `{ data }`. */
const envelopeSchema = z.object({ data: z.unknown() })

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const ROOT = "/api/messaging"

const errorBodySchema = z.object({ _tag: z.string().optional(), message: z.string().optional(), ref: z.string().optional() })

const send = async (operation: string, path: string, init: { method: "GET" | "POST" | "PUT"; body?: object }): Promise<Response> => {
  let response: Response
  try {
    response = validateRuntimeResponse(await runtimeFetch(`${ROOT}${path}`, {
      method: init.method,
      headers: init.body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
    }))
  } catch (error) {
    throw normalizeOpencodeError(operation, error)
  }
  if (response.ok) return response
  // The status comes from the response: the generated client's tag table does
  // not know the messaging error tags.
  const body = errorBodySchema.safeParse(await response.json().catch(() => null))
  throw new OpencodeApiError(operation, body.data?.message ?? body.data?._tag ?? `HTTP ${response.status}`, {
    status: response.status,
    tag: body.data?._tag,
    ref: body.data?.ref,
  })
}

const read = async <T extends z.ZodType>(operation: string, path: string, schema: T, init: { method: "GET" | "POST"; body?: object }) => {
  const response = await send(operation, path, init)
  const envelope = envelopeSchema.safeParse(await response.json().catch(() => undefined))
  const parsed = schema.safeParse(envelope.success ? envelope.data.data : undefined)
  if (!parsed.success) {
    throw new OpencodeApiError(operation, "OpenCode answered in a form this version does not read", { status: response.status, cause: parsed.error })
  }
  return parsed.data
}

export type MessagingProbe =
  | { kind: "supported"; model: MessagingModelStatus }
  | { kind: "unsupported" }

/**
 * Whether the connected OpenCode serves messaging, read from the model status
 * route every messaging build has. A 404, or a web page where an API answer
 * belongs, means the routes are missing; anything else that fails throws.
 */
export async function probeMessaging(): Promise<MessagingProbe> {
  let response: Response
  try {
    response = await runtimeFetch(`${ROOT}/model`, { headers: { Accept: "application/json" }, cache: "no-store" })
  } catch (error) {
    throw normalizeOpencodeError("messaging.model.status", error)
  }
  const html = (response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")
  if (response.status === 404 || (response.ok && html)) {
    void response.body?.cancel().catch(() => undefined)
    return { kind: "unsupported" }
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new OpencodeApiError("messaging.model.status", `HTTP ${response.status}`, { status: response.status })
  }
  const envelope = envelopeSchema.safeParse(await response.json().catch(() => undefined))
  const parsed = modelStatusSchema.safeParse(envelope.success ? envelope.data.data : undefined)
  if (!parsed.success) {
    throw new OpencodeApiError("messaging.model.status", "OpenCode answered in a form this version does not read", { status: response.status, cause: parsed.error })
  }
  return { kind: "supported", model: parsed.data }
}

export const getMessagingModelStatus = (): Promise<MessagingModelStatus> =>
  read("messaging.model.status", "/model", modelStatusSchema, { method: "GET" })

/**
 * Selects the model for the running server. A tier replaces a configured URL
 * or path; omitting all three keeps the configured model, so `{ start: true }`
 * only starts it. The selection lasts until OpenCode applies its config again.
 */
export const configureMessagingModel = (input: { tier?: string; url?: string; path?: string; start?: boolean }): Promise<MessagingModelStatus> =>
  read("messaging.model.configure", "/model", modelStatusSchema, { method: "POST", body: input })

type MessagingTopicsInput = {
  as?: string
  topics?: string[]
  sessions?: string[]
  role?: "any" | "reader" | "writer" | "subscriber"
  kinds?: string[]
  search?: string
  standard?: boolean
  sort?: "created" | "last"
  order?: "asc" | "desc"
  limit?: number
  offset?: number
  expand?: number
}

export const listMessagingTopics = (input: MessagingTopicsInput): Promise<{ topics: MessagingTopic[]; total: number }> =>
  read("messaging.topics", "/topics", topicListSchema, { method: "POST", body: input })

export const getMessagingTopic = (input: { as?: string; topic: string; expand?: number }): Promise<MessagingTopic> =>
  read("messaging.topic", "/topic", topicSchema, { method: "POST", body: input })

type MessagingQueryInput = {
  as?: string
  topics?: string[]
  query?: string
  match?: MessagingMatchMode
  from?: string[]
  types?: string[]
  kinds?: string[]
  since?: string
  until?: string
  after?: number
  before?: number
  hidden?: MessagingHiddenMode
  hiddenBy?: string[]
  /** Only messages addressed to the person: those written to sessions' user topics. */
  inbox?: boolean
  limit?: number
  order?: "asc" | "desc"
  markRead?: boolean
}

export const queryMessaging = (input: MessagingQueryInput): Promise<MessagingQueryResult> =>
  read("messaging.query", "/query", queryResultSchema, { method: "POST", body: input })

type MessagingSendInput = {
  as?: string
  topic?: string
  to?: string
  text: string
  type?: string
  reply?: number
  force?: boolean
  deliver?: MessagingDelivery
}

/** A soft write limit refuses with 409 (`ConflictError`); `force` writes anyway. */
export const sendMessagingMessage = (input: MessagingSendInput): Promise<MessagingSendResult> =>
  read("messaging.send", "/message", sendResultSchema, { method: "POST", body: input })

export const inspectMessagingMessage = (input: { as?: string; topic: string; seq: number }): Promise<MessagingMessage> =>
  read("messaging.inspect", "/inspect", messageSchema, { method: "POST", body: input })

/** Hides or restores messages, or the topic default when `seqs` is omitted. `for` defaults to the actor; `*` is everyone. */
export const changeMessagingVisibility = (input: {
  as?: string
  topic: string
  action: "hide" | "restore"
  seqs?: number[]
  for?: string[]
  reason?: string
}): Promise<{ seq: number; targets: number[] }> =>
  read("messaging.visibility", "/visibility", visibilityResultSchema, { method: "POST", body: input })

export const updateMessagingTopicSettings = (input: {
  as?: string
  topic: string
  mode?: MessagingWriteMode
  writers?: MessagingWriter[]
  description?: string
}): Promise<MessagingTopic> =>
  read("messaging.settings", "/settings", topicSchema, { method: "POST", body: input })

/** Subscribes a session to a topic, or removes its subscription. */
export const subscribeMessagingTopic = (input: { as: string; topic: string; delivery?: MessagingDelivery; remove?: boolean }): Promise<MessagingTopic> =>
  read("messaging.subscribe", "/subscribe", topicSchema, { method: "POST", body: input })

export const getMessagingChain = (input: { session: string; depth?: "self" | "parent" | "all"; detail?: "brief" | "full"; expand?: number }): Promise<MessagingChain> =>
  read("messaging.chain", "/chain", chainSchema, { method: "POST", body: input })

export const listMessagingSessions = (input: {
  search?: string
  active?: boolean
  parent?: string
  ancestor?: string
  agent?: string
  sort?: "created" | "updated"
  order?: "asc" | "desc"
  limit?: number
  detail?: "brief" | "full"
}): Promise<MessagingSessionList> =>
  read("messaging.sessions", "/sessions", sessionListSchema, { method: "POST", body: input })

type MessagingLogInput = {
  sessions: string[]
  op?: "head" | "tail" | "grep" | "search" | "pull"
  include?: MessagingLogPart[]
  query?: string
  match?: MessagingMatchMode
  context?: number
  scope?: "all" | "context"
  limit?: number
  offset?: number
  chars?: number
}

export const readMessagingLog = (input: MessagingLogInput): Promise<MessagingLog> =>
  read("messaging.log", "/log", logSchema, { method: "POST", body: input })

export const listMessagingVars = (input: { as?: string; values?: boolean; render?: string }): Promise<MessagingVars> =>
  read("messaging.vars", "/vars", varsSchema, { method: "POST", body: input })

/** Sets a custom variable, or removes it when `value` is omitted. `scope` is a session ID (inherited by its subsessions) or `global`. */
export async function setMessagingVar(input: { scope: string; name: string; value?: string }): Promise<void> {
  const response = await send("messaging.setVar", "/vars", { method: "PUT", body: input })
  void response.body?.cancel().catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Events and chat notices
// ---------------------------------------------------------------------------

/** A message written to any topic, announced on OpenCode's global event stream. */
export type MessagingCreated = {
  topic: string
  seq: number
  kind: string
  type: string
  writer: string
  time: number
  /** The first 200 characters of the message. */
  preview: string
  /** Addressed to the person: written to a session's user topic. */
  inbox: boolean
}

/**
 * The `messaging.message.created` payload on the event stream. The sync
 * pipeline parses with it; `data` is a `MessagingCreated`.
 */
export const messagingCreatedEvent = z.object({
  type: z.literal("messaging.message.created"),
  data: z.object({
    topic: z.string(),
    seq: z.number(),
    kind: z.string(),
    type: z.string(),
    writer: z.string(),
    time: z.number(),
    preview: z.string(),
    inbox: z.boolean().default(false),
  }),
})

/**
 * A message OpenCode delivered into a session's transcript: a synthetic
 * message whose metadata names `source: "messaging"`. Its text wraps the body
 * in a `<message …>` envelope for the model; `body` is the text without it.
 */
export type MessagingNotice = {
  topic: string
  seq: number
  /** Session ID of the writer, or `user`. */
  from: string
  /** The writer's session title, when the envelope carries one. */
  fromTitle?: string
  type: string
  /** Sent up to the person. Only those notices carry an audience; the type is a free label any writer sets. */
  toYou: boolean
  /** False for a message to the person that OpenCode keeps out of the model's context. */
  agentSees: boolean
  body: string
}

const noticeMetadataSchema = z.object({
  source: z.literal("messaging"),
  topic: z.string(),
  seq: z.number(),
  from: z.string(),
  type: z.string().optional(),
  audience: z.enum(["user", "all"]).optional(),
})

// Attribute values escape `"` but not `>`, so the tag end skips quoted values.
const ENVELOPE = /^\s*<message\b((?:[^>"]|"[^"]*")*)>\n?([\s\S]*?)\n?<\/message>\s*$/
const FROM_TITLE = /\sfrom_title="([^"]*)"/

const unescapeAttribute = (value: string): string => value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&amp;", "&")

export function readMessagingNotice(message: Message): MessagingNotice | undefined {
  if (message.role !== "synthetic") return undefined
  const parsed = noticeMetadataSchema.safeParse(message.metadata ?? {})
  if (!parsed.success) return undefined
  const envelope = message.text.match(ENVELOPE)
  const notice: MessagingNotice = {
    topic: parsed.data.topic,
    seq: parsed.data.seq,
    from: parsed.data.from,
    type: parsed.data.type ?? "message",
    toYou: parsed.data.audience !== undefined,
    agentSees: parsed.data.audience !== "user",
    // Bodies escape message tags so they cannot close the envelope; show them as written.
    body: (envelope ? envelope[2] : message.text).replace(/&lt;(\/?message\b)/gi, "<$1"),
  }
  const title = envelope?.[1].match(FROM_TITLE)?.[1]
  if (title) notice.fromTitle = unescapeAttribute(title)
  return notice
}

/** Whether a writer is a session, as opposed to the person using the API. */
export const isMessagingSession = (writer: string): boolean => writer.startsWith("ses")
