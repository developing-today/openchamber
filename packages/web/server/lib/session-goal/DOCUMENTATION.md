# Session Goal

Server-side control loop that keeps a session working toward a user-defined
objective stored under `metadata.openchamber.goal`, with Jev (the
classification model) or the small model as an independent progress check. Built on OpenChamber's backend-driven
architecture (session-assist is the structural template): the loop lives in
the web server and survives UI disconnects.

## Goal payload (`metadata.openchamber.goal`)

```
{
  id,                      // opaque per-logical-goal id; stale-write guard
  objective,               // inline user text (fallback), <= 5000 chars
  objectiveFile,           // true: objective text lives in a server-side file
  status,                  // active | paused | blocked | budgetLimited | complete
  tokenBudget,             // optional positive int
  tokensUsed,              // tokensCommitted + current segment (snapshot - baseline)
  tokensBaseline,          // segment start snapshot (pre-goal turn; 0 after compaction)
  tokensCommitted,         // closed segments' total (one segment per compaction)
  turnsUsed,               // auto-continuations sent (capped at the Settings turn limit)
  auditFailStreak,         // consecutive progress checks that could not run
  statusReason,            // why settled; 'resumed' is a kickoff signal from UI
  evaluationProviderID,    // provider of the latest check; '' when Jev answered
  evaluationModelID,       // model of the latest check (Jev's model id for Jev)
  lastAccountedMessageID,  // incremental accounting cursor
  createdAt, updatedAt
}
```

The UI writes goals (create/edit/pause/resume/clear) by patching this
metadata; the runtime never creates a goal on its own. Goal creation happens
at send time via the arm store (`useSessionGoalArmStore`): the composer
target button arms "the next prompt is the objective", and the run-as-goal
flows (fork-from-answer dialog, plan implement dialog) arm the same way —
the plan flow additionally supplies an objective OVERRIDE carrying the plan
content, since "Implement this plan: X" alone gives the audit nothing to
judge against. The armed send also attaches a synthetic system-reminder
part telling the agent goal mode is active and that each turn should end
with a factual done/verified/remaining statement for the independent audit.
Freshness/stale-write protection is by `id`: every runtime write re-reads the
session and drops the write when the stored goal id no longer matches.

## File-backed objectives

The objective TEXT lives in `<data-dir>/goals/<sessionId>.md` (data dir =
`OPENCHAMBER_DATA_DIR` or `~/.config/openchamber`), keyed by the SESSION ID:
sessions are globally unique and carry one goal at a time, so the mapping is
deterministic and a new goal simply overwrites the file. Metadata carries
only `objectiveFile: true` — never a path — so user-writable metadata cannot
become a file-read vector (`objectives.js` also validates the id shape
before touching the filesystem). Rationale: metadata rides every
`session.updated`, so multi-KB objectives must not live there.

- `objectives.js` — write/read/delete, 5000-char clamp.
- `routes.js` — `PUT/GET/DELETE /api/goals/objective/:sessionId`
  (OpenChamber-owned, registered before the generic proxy; JSON parsing via
  the `/api/goals` family in core-routes). The UI writes the file BEFORE
  patching the goal metadata and falls back to an inline objective when the
  write fails; `clearSessionGoal` deletes the file best-effort.
- The tick resolves the effective objective fresh on every cycle (the file
  is live-editable mid-goal) and falls back to the inline `objective` when
  the file is unreadable — a goal never dies because a file went away.
- UI display fetches content via the GET route
  (`useGoalObjectiveContent`); in VS Code the route is unavailable, so the
  strip shows a generic goal title (display-only fallback by design).
- Server-created goals write the file through `create.js`, which also owns
  objective fitting, inline fallback, metadata creation, and the synthetic
  first-turn reminder shared by scheduled tasks and CLI-created sessions.

- Forks: OpenCode copies the source metadata into a fork, goal included.
  The UI fork paths (`forkAfterMessage`, `forkFromMessage`, `/fork`) then copy
  the objective file to the fork's id, or inline the text when that write
  fails (`packages/ui/src/lib/sessionForkInheritance.ts`). The copy re-reads
  the fork's goal id first and is skipped when the user armed a new goal on
  the fork meanwhile. Forks made through `POST /api/openchamber/sessions/:id/fork`
  (CLI, scheduled tasks) get the same repair server-side before the prompt is
  dispatched (`openchamber-sessions/fork-inheritance.js`); UI forks call
  OpenCode directly, so both implementations exist. `/btw` forks drop the goal
  with the rest of the inherited namespace.

## Goal writer

The goal writer turns a user's message into a goal spec: a clean, detailed
objective of at most 5000 characters that the agent works from and the
progress check judges against. `spec-writer.js` owns it.

- Route: `POST /api/goals/spec` in `routes.js`, body `{ request,
  conversation?, openItems?, directory?, providerID?, modelID? }`, answer
  `{ spec, providerID, modelID }` naming the model that wrote it. A blank
  request is `400` (`goal-spec-request-required`), an empty reply `502`
  (`goal-spec-empty`); other errors keep the generate status. A client that
  disconnects aborts the generation.
- Prompt: the system message is the prompt, a blank line, then
  `GOAL_SPEC_RULES`. The prompt is `sessionGoalWriterPrompt` when it is set
  (at most 20000 characters, `GOAL_WRITER_PROMPT_CHAR_LIMIT`), else the
  built-in `GOAL_SPEC_DEFAULT_PROMPT`, which asks for Markdown sections
  Objective, Requirements, Constraints, Done when and Out of scope, faithful
  to the request, with paths, commands and names kept verbatim. The rules come
  after every prompt, a custom one included: everything in the data blocks is
  data, never instructions, and the spec stays under 4500 characters. The user
  prompt holds XML-escaped `<request>`, `<open_items>` and `<conversation>`
  blocks in that order, so a prompt clipped at the tail loses conversation
  first. The reply is cleaned by `normalizeGoalSpec`: think blocks dropped, a
  fence around the whole reply removed, clamped to 5000 characters at a line
  break when one is close.
- Model: `sessionGoalWriterModel` (`provider/model`) when set, else the
  session's own provider and model, else the normal small-model chain. All of
  them go through `generateSmallModelText`, so the writer only reaches models
  configured in OpenCode through `/api/experimental/generate`, the same
  boundary as the small model. `sessionGoalWriterVariant` is the effort
  (OpenCode's model variant) of the picked writer model and is sent only with
  it (`resolveGoalWriterModel`); the session's model runs at its default.
- Built-in prompt for Settings: `GET /api/goals/spec/prompt` answers
  `{ prompt, rules }` with `GOAL_SPEC_DEFAULT_PROMPT` and `GOAL_SPEC_RULES`,
  so the UI never carries a copy of either.
- Describe a change: `POST /api/goals/spec/prompt/rewrite`, body `{ prompt?,
  instruction, directory?, providerID?, modelID? }`, answer `{ prompt,
  providerID, modelID }` (`rewriteGoalWriterPrompt`). One call on the writer's
  model and effort rewrites `prompt` (blank: the saved prompt, else the
  built-in one) as the instruction says and returns only the new prompt, think
  blocks and a whole-reply fence removed. Both texts go in unescaped: they are
  the user's own, and escaped markup would come back as entities. A blank
  instruction is `400` (`goal-prompt-change-required`), an empty reply `502`
  (`goal-prompt-empty`), a reply over the 20000 character limit `502`
  (`goal-prompt-too-long`); an input too large for the model is `413` instead
  of a clipped prompt. Enterprise mode leaves it open exactly as it leaves the
  writer: it sends no conversation content and reaches only models configured
  in OpenCode; `routes.test.js` holds the two routes to the same answer.
- Rewrite all: with `sessionGoalRewriteAll` on, `createSessionGoal` runs every
  server-created objective (scheduled tasks, CLI `--goal`, the agent tool's
  `goalAction: set`) through the writer before fitting it. A failed rewrite
  logs a warning and keeps the objective as written. `createSessionGoal`
  returns `{ goal, spec }`; scheduled tasks and the sessions route pass the
  spec to `buildGoalIntroText(tokenBudget, spec)`, whose reminder then
  carries it in an escaped `<goal-spec>` block. A slash command normally gets
  no reminder; with a rewritten spec the reminder is admitted with
  `resume: false` before the command, since the spec is not the command's own
  text. The UI builds the same text for goals it arms, so the wording must
  stay identical on both sides.

## Flow

1. `createSessionGoalRuntime` subscribes to the global SSE hub (same pattern
   as session-assist — it needs the envelope's `directory`).
2. `session.status: idle` arms a 15s per-session timer; `busy`/`retry` clears
   it. A `session.updated` carrying a fresh active goal (`turnsUsed === 0` or
   `statusReason === 'resumed'`) arms a kickoff timer — 3s for fresh goals,
   ~250ms for an explicit Resume so the nudge feels immediate — since setting
   a goal on an idle session emits no status transition.
3. On fire (`tick`), gated by the `sessionGoalEnabled` setting:
   - fetch session (skip sub-agent sessions), require an `active` goal;
   - authoritative live-activity check after the quiet window: re-read
     `/api/session/active`, bail if the parent resumed; then list the
      parent's subagent sessions through `GET /api/session?parentID=` (cursor
      paged) and bail while any of them is active. The loop rechecks after
      another quiet window so a missed parent idle event cannot strand the
      goal when the child finishes. A status or children fetch failure is
      unknown, not empty, so it skips the audit and retries after another quiet
      window;
     both reads live in `../opencode/session-activity.js`, shared with the
     notification runtime;
   - messages come from `/api/session/:id/message` as v2's flat records
     (`type`, `content[]`, `model`, `finish`, `tokens`); `toLoopMessage`
     projects them into the `{ info, parts }` view the rest of the tick reads,
     and a completed `compaction` record plays v1's `summary: true` assistant
     turn. v2 gives a compaction only `time.created`, so the projection
     stamps `time.completed` from it: every "finished" check in the tick reads
     `time.completed`, and without it a compaction looks still running. Other
     plumbing roles are dropped from the view;
   - quiescence check via the message tail (trailing user message or
     unfinished assistant reply → bail; the next idle transition re-arms);
   - token accounting as a SNAPSHOT of the latest completed assistant turn:
     `input + cache.read + output`. Earlier turns' inputs and outputs fold
     into the next turn's cache, so the latest snapshot already carries the
     whole run's paid tokens — no summing across messages. Goal-relative via
     `tokensBaseline` (the same snapshot of the newest pre-goal turn,
     captured on the first tick). Compaction (an assistant message with
     `summary: true`) breaks the snapshot chain, so accounting is segmented:
     the summary message closes the segment into `tokensCommitted` (the
     summary turn read the whole context, so its snapshot prices the
     compaction itself) and the next segment starts with a zero baseline.
     `tokensUsed = tokensCommitted + current segment`, kept monotonic so
     unflagged context shrinks never move the budget backwards;
   - a user abort pauses the goal instead of blocking it: the event path in
     `processPayload` pauses immediately on the MessageAbortedError message
     (before any tick could send a continuation over the user's explicit
     stop), with a tick-side safety net. Messages sent while paused leave
     the goal alone; Resume re-arms the loop, and resuming over an aborted
     tail skips the audit and goes straight to a continuation nudge;
    - terminal checks, cheapest first: assistant turn error → `blocked`;
      `tokensUsed >= tokenBudget` → `budgetLimited`;
      `turnsUsed >= ` the turn limit (Settings → Goal, `sessionGoalMaxAutoTurns`, 1–200, default 20; read on every tick) → `blocked`;
    - error classification is independent of `finish`: `MessageAbortedError`
      keeps the pause/resume behavior; only a `finish: "length"` with no
      error, or `MessageOutputLengthError`, is an in-progress truncation that
      skips the audit and continues. Any other non-null error wins over a
      length finish and blocks with its non-empty `error.name`, or
      `assistant turn failed` when unnamed;
    - length recovery is bounded separately from the token budget and
      auto-continuation cap: the first truncation permits one continuation, but
      a second consecutive completed, non-summary assistant turn that is also
      truncated settles the goal as `blocked` (`repeated output truncation`).
      The consecutive state is derived from the loaded message history, not
      persisted, using `info.time.created` chronology rather than message IDs.
      Summary messages are not agent turns; an ordinary completed assistant
      turn naturally breaks the consecutive condition. Explicit Resume grants
      one new recovery attempt over the same transcript; the continuation
      consumes that permission, so another truncation blocks again. Resume
      does not bypass assistant errors or the token budget;
   - otherwise, a progress check of the objective + the last assistant turn
     only — no conversation history and no continuation prompts (`audit.js`).
     Three yes/no questions: does the report say all requested work is done
     (`all_done`), does it name requested work the agent still has to do
     (`remaining`), and is the agent stopped by something only the user can
     provide (`needs_user`). `decideProgress` combines them in code:
     `needs_user >= 0.5` → blocked, `all_done >= 0.5 && remaining < 0.5` →
     complete, anything else → continue. Jev answers with probabilities; the
     small model answers the same questions as JSON booleans read as 1/0, so
     there is one format and one decision. The long turn is cut to its head
     and, mostly, its tail, where the report sits.
     Who answers: Jev when `sessionGoalChecker` is `classifier` (an explicit
     pick; the default is `small-model`, since a classification provider set
     up for another feature is not consent to audit goals with Jev) and a
     classification provider can run it (`classifierEndpoint`, owned by
     `../routing`); the small model otherwise, and also when Jev fails this
     time (the session's own provider/model
     preferred). The check is the SOLE termination authority besides the hard
     stops above — the working agent has no channel to settle its own goal.
     `complete` and `blocked` settle on the first such answer: a blocked turn
     waits on the user, and another nudge would only spend a turn repeating the
     question (`statusReason: 'waiting for user input'`). There is no note: the
     strip shows the objective. A check that cannot run tolerates ONE
     consecutive unchecked continuation (`auditFailStreak`); a second
     consecutive failure settles the goal as `blocked` ("progress audit
     unavailable") — resumable, and settling resets the streak so Resume gets
     fresh tolerance. A dead checker can never drive the loop blind to the turn
     cap. Measured on 144 hand-written goal-report turns plus 8 real ones (lab:
     `~/projects/openchamber-extensions/jev-goal-lab`): Jev 142/144 with both
     misses on the safe side, gpt-6-luna 141/144. Change the questions or the
     threshold only with a new run of that lab;
   - continue: persist accounting + `turnsUsed` first (a crash after the
     write just waits for the next idle tick; the reverse could double-send),
     re-check the tail, then `POST /api/session/:id/prompt` with the
     continuation prompt. v2 keeps the model and agent on the session, so the
     prompt runs on what the session already uses; nothing is re-selected —
     the goal spends the session's own subscription.
4. Settling (`complete`/`blocked`/`budgetLimited`) fires the injected
   `emitGoalNotification` so the user hears about it even with the UI closed:
   desktop + UI broadcast + the standard push fanout (web-push with full
   text; APNs with a generic per-type title and the session name as body).
   It obeys the notify-on-completion setting. Conversely, while a goal is
   ACTIVE the notifications runtime suppresses per-turn "ready"
   notifications on every channel — they would only echo the loop's own
   continuations; error/question/permission notifications are untouched.
   Pausing a goal from the UI also aborts the running turn (and vice versa —
   an abort pauses the goal), so "stop" means stop on both axes.

## Continuation prompt

Built inline in `runtime.js`: the objective as untrusted user data in an
XML-escaped `<objective>` block, budget numbers, keep-the-full-objective and
work-from-evidence rules, a completion-audit instruction, and the requirement
to end every turn with a factual done/verified/remaining report — the audit
sees only that final turn, so the report is its evidence.

## UI consumers (packages/ui)

- `lib/sessionGoalMetadata.ts` — payload parsing/types.
- `lib/sessionGoalActions.ts` — create/edit/pause/resume/clear via
  `patchSessionMetadata`; `lib/sessionGoalPresentation.ts` — status
  colors/labels shared across surfaces.
- `stores/useSessionGoalArmStore.ts` — the "next prompt starts a goal" flag,
  consumed by `sendMessage` in `sync/session-ui-store.ts` (works for drafts).
  Armed slash commands resolve their authoritative command template and apply
  OpenCode argument expansion (`$ARGUMENTS`, positional placeholders, or the
  implicit argument suffix) for the audit objective before goal metadata is
  written and before `session.command` dispatch. If command details cannot be
  loaded, the raw invocation remains the objective rather than blocking command
  execution.
- `hooks/useSessionGoal.ts` — live goal state.
- `components/chat/SessionGoalButton.tsx` — composer target button
  (arm / status color / cancel confirm); `SessionGoalRow.tsx` — goal row
  among the composer's top rows; `SessionGoalDialog.tsx` — manage dialog
  (edit/pause/resume/complete/clear).
- Sidebar glyph next to the date in `SessionNodeItem`.
- `components/sections/openchamber/SessionGoalCheckerField.tsx` — Settings →
  Chat → Goal: Jev or the small model checks progress
  (`sessionGoalChecker`). Without a classification provider the Jev chip is
  disabled and the small model shows as chosen, matching the server.
  `useGoalCheckAvailable` (`hooks/useSessionGoal.ts`) gates arming a new goal
  on either checker being able to run.

### Goal writer in the UI

- `lib/goalWriter.ts` — `requestGoalSpec` (the route above; a failure comes
  back with its reason, never as an empty spec), `planGoalWriter` (whether a
  send stops for the writer), `buildGoalIntroReminder` (the goal-mode reminder,
  byte-identical to `buildGoalIntroText`), the context formatting for
  "goal from next message", and for Settings `fetchGoalWriterBuiltinPrompt`
  and `requestGoalWriterPromptRewrite`, which fail with their reason too.
- `components/chat/SessionGoalButton.tsx` — `SessionGoalWriterButton`, the
  sparkle switch right of the target (`sessionGoalWriterEnabled`, on by
  default). It shows only while the session has no goal and a progress check
  can run, and reads as on and locked while `sessionGoalRewriteAll` is on.
- `components/chat/ChatInput.tsx` — `handleSubmit` asks `planGoalWriter`
  before anything is taken from the composer. Eligible sends are plain text
  in normal mode: no slash command, shell input, side question, queue flush,
  or a send that auto-review would queue. Two triggers:
  - `armed`: the target is armed and the switch or rewrite-all is on. The
    writer reads the message only.
  - `auto-create`: the session has no goal at all, it is idle, and
    `sessionGoalAutoCreate` is `review` or `auto`. The writer also gets
    `components/chat/goalWriterContext.ts`: the first request and the newest
    turns of the loaded history, open project todos, session-pinned and
    project-pinned plans whose checklist is not done, queued messages and
    running subagent sessions. Every source is best effort; the message alone
    still makes a goal.
- `components/chat/GoalSpecDialog.tsx` — writes the spec (the session's
  composer model is sent as the fallback model), then shows it for approval
  when `sessionGoalWriterReview` is on (armed) or `sessionGoalAutoCreate` is
  `review`. Choices: send the message with the spec as its goal, send the spec
  as the message (`sessionGoalWriterSendMode` picks the primary one and the
  one used without review), write again, or skip: an armed goal keeps the
  message as typed, an automatic one sends without a goal. A failed write
  always waits for the user, review or not. Closing the dialog leaves the
  composer, queue and pending prompts untouched: the choice submits again with
  a `goal` option, and only then is the arm set, right before `sendMessage`.
- `stores/useSessionGoalArmStore.ts` — `settled` marks an objective the writer
  produced or the user kept over it, so rewrite-all leaves it alone;
  `briefAgent` puts the spec into the reminder when the message itself is not
  the spec.
- Rewrite all in the UI: `setSessionGoal` takes `rewrite` with the session's
  model and returns `rewrittenSpec`. `sendMessage` passes it for unsettled
  armed goals (Plan "Run as goal", fork as goal), and `SessionGoalDialog` when
  the typed objective changed. A failed rewrite keeps the user's text and says
  so in a toast. `sendMessage` builds the goal reminder only after the goal is
  saved, so a rewritten spec reaches the agent in the same message.
- A writer request belongs to the composer it came from: switching the
  composer to another session or draft closes the dialog, and a late choice is
  dropped.
- `components/sections/openchamber/SessionGoalWriterFields.tsx` — Settings →
  Chat → Goal: the switch, the writer model (`sessionGoalWriterModel`, read by
  the server only, so it lives in the settings file like the walkthrough
  model), its effort, the prompt, review, send mode, rewrite all, and goal
  from next message. None of it exists in VS Code, which has no goal loop.
  - Model: with no pick, the line under the label names the model that writes
    then, the composer's (`Session model: provider/model`). On Auto it says
    the small model writes, since the small-model chain treats Auto as no model.
  - Effort: `sessionGoalWriterVariant` in `useUIStore`, a picker of the picked
    model's levels from the provider catalog plus "Model default" (empty).
    Picking another model clears it; it is disabled while no model with levels
    is picked, unless a saved level needs clearing.
  - Prompt: `sessionGoalWriterPrompt` in `useUIStore`, saved as the user types.
    `GoalWriterPromptEditor.tsx` shows the prompt in use, the built-in one
    (from `GET /api/goals/spec/prompt`) while the setting is empty, and saves
    empty when the text is empty or equals the built-in prompt, so a newer
    release's prompt applies. Reset to default shows while the text differs
    from it. The rules the server adds after every prompt are shown under the
    field. "Describe a change" asks the rewrite route with the composer's model
    as the fallback and no directory, since Settings edits this server's
    settings; the answer is shown next to the current prompt (stacked on a
    narrow pane) until Apply, which puts it in the field and saves it, or
    Discard. A failure keeps the field and shows its reason.

## Scheduled goals

Scheduled tasks can run as goals: `execution.goalEnabled` (+ optional
`execution.goalTokenBudget`) on a task makes the scheduled-tasks runtime
write the goal into OpenChamber's session metadata store through the
`persistSessionGoal` seam `server/index.js` hands it (objective = the expanded
task prompt; v2 `CommandInfo` carries no template, so a slash command's
objective is its raw invocation) and attach the goal-mode intro part to normal
prompts. The store write is what arms the loop (`notifyGoalChanged`).

## CLI-created goals

`openchamber session create --prompt <text> --goal` uses the explicit
`POST /api/openchamber/sessions` orchestration route. The server creates the
session, fits and stores the expanded prompt as its objective, patches active
goal metadata, appends the synthetic goal reminder, and only then dispatches
the prompt. `--goal-token-budget` applies the same optional budget contract as
scheduled goals. Slash commands retain command dispatch semantics and cannot
carry the synthetic prompt part. Their command template with OpenCode argument
expansion becomes the audit objective; goal metadata
is still installed before the command runs. A missing command template falls
back to the raw invocation.

`openchamber session send --goal` and `openchamber session fork --goal` use
the same server-owned prompt orchestration. Send installs a fresh goal on the
target session; fork first uses the official OpenCode fork operation (at the
optional message boundary), then installs the goal on the new session. Both
preserve the objective-file-before-metadata and metadata-before-dispatch
ordering used by create and scheduled goals.

## Limitations

- Web-server feature: VS Code (extension-only) renders goal state via
  `session.updated` but does not run the loop.
- A goal on a session with no assistant reply yet starts after the first
  user exchange completes (there is no reply to audit before that).
- `tokensUsed` only counts completed assistant messages seen within the
  40-message fetch window per tick; extremely long busy stretches between
  idles undercount (acceptable: budget is a guardrail, not billing).
