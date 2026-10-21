import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { OpenCode } from '@opencode/client'
import { opencodeClient } from '@/lib/opencode/client'
import type { Message } from '@/lib/opencode/model'
import { getRuntimeKey } from '@/lib/runtime-switch'
import { useGoalSpecJobStore, type GoalSpecJob } from '@/stores/goalSpecJobStore'
import { SyncProvider, useDirectoryStore } from '@/sync/sync-context'
import { installHookTestDom } from '../session/sidebar/test-utils/testDom'
import { hasUserMessageAfterSentJob, useSentGoalSpecJobOvertaken } from './goalSpecJobOvertaken'

// A sent goal writer card is the transcript's last row. Once the user sends
// another message it would sit under turns it has nothing to do with, so it
// hides. The job's own message is told apart by the id the server recorded:
// OpenCode stamps a user message with the time it reached the session, which
// can be after the job was marked sent.

const CURRENT_DIR = '/workspace'
const DIR = '/repo'
const SESSION_ID = 'ses_card'
const SENT_AT = 1_000

const user = (id: string, created: number): Message => ({ id, sessionID: SESSION_ID, role: 'user', time: { created } })
const assistant = (id: string, created: number): Message => ({
  id,
  sessionID: SESSION_ID,
  role: 'assistant',
  time: { created },
  agent: 'build',
  providerID: 'anthropic',
  modelID: 'claude',
})
const synthetic = (id: string, created: number): Message => ({ id, sessionID: SESSION_ID, role: 'synthetic', time: { created }, text: 'context' })

describe('hasUserMessageAfterSentJob', () => {
  const sent = { messageId: 'msg_job', updatedAt: SENT_AT }

  test('the job\'s own message with replies after it is not overtaken', () => {
    expect(hasUserMessageAfterSentJob([user('msg_job', 900), synthetic('msg_s', 950), assistant('msg_a', 1_100)], sent)).toBe(false)
  })

  test('its own message reaching the session after the send is not a later message', () => {
    // A message sent into a working session reaches it at the next step.
    expect(hasUserMessageAfterSentJob([assistant('msg_a', 800), user('msg_job', 1_500), assistant('msg_b', 1_600)], sent)).toBe(false)
  })

  test('a user message after the job\'s own one overtakes it', () => {
    expect(hasUserMessageAfterSentJob([user('msg_job', 900), assistant('msg_a', 1_100), user('msg_next', 2_000)], sent)).toBe(true)
  })

  test('a user message sent before the job\'s own one, though stamped after the send, does not', () => {
    expect(hasUserMessageAfterSentJob([user('msg_earlier', 1_200), user('msg_job', 1_300), assistant('msg_a', 1_400)], sent)).toBe(false)
  })

  test('without its own message in the transcript, a user message after the send overtakes it', () => {
    expect(hasUserMessageAfterSentJob([assistant('msg_a', 1_100), user('msg_next', 2_000)], sent)).toBe(true)
    expect(hasUserMessageAfterSentJob([user('msg_before', 500), assistant('msg_a', 1_100)], sent)).toBe(false)
    expect(hasUserMessageAfterSentJob([user('msg_next', 2_000)], { messageId: null, updatedAt: SENT_AT })).toBe(true)
  })
})

const createSdk = () => OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
    }
    const body = path.endsWith('/location')
      ? { directory: CURRENT_DIR, project: { id: 'project', directory: CURRENT_DIR, canonical: CURRENT_DIR } }
      : path.endsWith('/session/active') ? {}
      : { data: [] }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  },
})

const job = (overrides: Partial<GoalSpecJob> = {}): GoalSpecJob => ({
  id: 'job-1',
  sessionId: SESSION_ID,
  directory: DIR,
  status: 'sent',
  trigger: 'armed',
  review: true,
  sendMode: 'with-message',
  tokenBudget: null,
  message: { content: 'Add dark mode', text: 'Add dark mode', attachments: [], contextCount: 0 },
  composerOnly: false,
  spec: 'Spec',
  writer: { source: 'session', providerID: 'p', modelID: 'm', variant: null },
  sendConfig: { providerID: 'p', modelID: 'm' },
  error: null,
  sending: false,
  messageId: 'msg_job',
  outcome: { kind: 'spec', sendMode: 'with-message' },
  attempt: 1,
  createdAt: 1,
  updatedAt: SENT_AT,
  ...overrides,
})

let store: ReturnType<typeof useDirectoryStore> | null = null
let overtaken: boolean | null = null

const Probe = () => {
  store = useDirectoryStore(DIR, { bootstrap: false })
  overtaken = useSentGoalSpecJobOvertaken(SESSION_ID, DIR)
  return null
}

describe('useSentGoalSpecJobOvertaken', () => {
  let dom: ReturnType<typeof installHookTestDom>
  let root: Root
  let restoreSpies: Array<() => void>
  let previousSurface: typeof window.__OPENCHAMBER_SURFACE__
  let revision = 0

  const showJob = (value: GoalSpecJob | null) => act(async () => {
    revision += 1
    useGoalSpecJobStore.getState().applyServerJob(SESSION_ID, value, revision, getRuntimeKey())
  })
  const seed = (messages: Message[]) => act(async () => store!.setState({ message: { [SESSION_ID]: messages } }))

  beforeEach(async () => {
    dom = installHookTestDom()
    previousSurface = window.__OPENCHAMBER_SURFACE__
    window.__OPENCHAMBER_SURFACE__ = 'desktop'
    const spies = [
      spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home' }),
      spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home'),
      spyOn(opencodeClient, 'getLocation').mockResolvedValue({
        directory: CURRENT_DIR,
        project: { id: 'project', directory: CURRENT_DIR, canonical: CURRENT_DIR },
      }),
      spyOn(opencodeClient, 'getConfig').mockResolvedValue({}),
      spyOn(opencodeClient, 'listProjects').mockResolvedValue([]),
    ]
    restoreSpies = spies.map((spy) => () => spy.mockRestore())
    useGoalSpecJobStore.getState().resetForRuntimeSwitch()
    revision = 0
    store = null
    overtaken = null
    root = createRoot(dom.container)
    await act(async () => root.render(
      <SyncProvider sdk={createSdk()} directory="">
        <Probe />
      </SyncProvider>,
    ))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    restoreSpies.forEach((restore) => restore())
    useGoalSpecJobStore.getState().resetForRuntimeSwitch()
    window.__OPENCHAMBER_SURFACE__ = previousSurface
    dom.restore()
  })

  test('a sent card is overtaken once the user sends another message in its session', async () => {
    await showJob(job())
    await seed([user('msg_job', 900), assistant('msg_a', 1_100)])
    expect(overtaken).toBe(false)

    await seed([user('msg_job', 900), assistant('msg_a', 1_100), user('msg_next', 2_000)])
    expect(overtaken).toBe(true)
  })

  test('a job that is not sent is never overtaken', async () => {
    await seed([user('msg_job', 900), assistant('msg_a', 1_100), user('msg_next', 2_000)])
    expect(overtaken).toBe(false)

    await showJob(job({ status: 'ready', messageId: null, outcome: null }))
    expect(overtaken).toBe(false)
  })
})
