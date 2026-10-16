# OpenChamber Control Service

## Purpose

This module owns the typed control contract shared by the OpenChamber CLI and
the managed OpenCode `openchamber` tool. Both adapters delegate to
`createOpenChamberControlService()`; neither adapter may call or spawn the
other.

## Boundaries

- `service.js` validates and executes the fixed project, model, session, and
  scheduled-task action allowlist. `actions.js` marks CLI-only actions with
  `agentExposed: false` (currently `schedule.status`); the agent tool consumes
  the filtered `OPENCHAMBER_AGENT_TOOL_*` exports. `schedule.toggle` requires
  the `disabled` boolean and replaces separate enable/disable actions; its
  `enabled` is the saved state, never the requested one. Loop tasks and the
  refusal to enable a repository loop are the scheduled-task service's rules
  (`../scheduled-tasks/DOCUMENTATION.md`, *Local approval*).
  `schedule.list` also returns scheduler status as `scheduler`.
  `schedule.update` patches a task in place: only the fields the call names
  change, the id and run state stay, and a task driven by a loop file is
  refused (the file is its source).
  `schedule.create` and `schedule.update` accept `targetSessionId`, validated
  by the scheduled-task service. An empty update clears the target. Create
  without a model inherits the target selection; an explicit agent overrides
  it. A task without a target still requires a model.
- `project-knowledge.js` runs the `knowledge.*` actions of the
  `openchamber_knowledge` agent tool (`list`, `save`, `delete`, `show`;
  `kind` names note, todo or plan) against
  `../project-context/runtime.js`. The owner is the session directory (or the
  given `projectId` / `directory`) resolved by the same resolver session
  knowledge and memory use, so what an agent writes is what the next session
  is given. Notes it creates are `source: agent` with the calling session as
  origin; payload provenance is ignored. Plans are handed out as file paths
  (`list`, and the answer to `save`), never as text: the agent reads a plan
  and makes small edits, such as ticking a step, with its own file tools, and
  `save` creates or replaces one whole. The actions answer `403` while
  `agentKnowledgeToolEnabled` is `false`. `show` checks the plan exists and
  sends `openchamber:plan-open-request` to every connected window, like
  `file.open`; every layout opens the plan the way a click in the Project
  knowledge Plans list does: in place in the panel on desktop and web, in the
  drawer's plan viewer on mobile. No
  window reached is `503`.
- `render-page.js` runs `render.page` for the `openchamber_render` agent tool.
  The chat draws the page from the call's own input, so the action stores
  nothing: it checks `html` (at most 200,000 characters) and `title` (at most
  120) and answers `403` while `agentRenderToolEnabled` is `false`. With
  `awaitAnswer` the action waits in `createPageAnswers`, keyed by session and
  call id, until `answerPage` resolves it (`POST /api/openchamber/render/answer`
  from the chat: a summary of at most 500 characters and data of at most
  16,000 characters as JSON) or the request is aborted. Nothing outlives the
  call, so a second answer, an answer for a call that ended, and an answer
  after a server restart are a `404`, never a silent success.
  `onPageWaitChange` hears both ends of a wait. The server's wiring
  (`index.js`) lists the page with the session's pending requests
  (`trackWaitingPage` in `../opencode/session-runtime.js`), broadcasts
  `openchamber:page-waiting` / `openchamber:page-settled` to the clients, and
  sends the same "Input needed" notification a form gets.
- `routes.js` is the authenticated CLI HTTP adapter. It forwards one action,
  preserves service status and partial-result details, and propagates request
  cancellation. It also carries the chat's answer to a waiting page.
- `../agent-tool/runtime.js` is the managed-tool adapter. It wraps service
  results in the versioned native-tool envelope and uses a separate ephemeral
  loopback credential.
- `../openchamber-sessions/routes.js` and `../scheduled-tasks/service.js` own
  their domain operations and are composed into this service.

## Invariants

- Session status and messages come from official directory-scoped OpenCode
  APIs. Message output includes only ordered `text` parts.
- Wait (CLI only; the agent tool refuses it) never treats an initial idle
  response as completion after dispatch. It requires observed activity or a
  newly completed assistant message.
- Timeout and cancellation are failures, never authoritative idle results.
- `returnResult` on create/send/fork hands the dispatched session's final
  answer back to the calling session (`options.contextSessionId`) through
  `../dispatch-results/`. It is checked before anything is created: it needs a
  calling session, a prompt, an injected `dispatchResults` (else 503), no
  `wait`, and a send may not target the caller itself. After the dispatch the
  result carries `resultDelivery`: `pending` with a note for the agent, or
  `not-scheduled` with the reason (the prompt never landed, or registering
  failed); the session keeps running either way, so neither is thrown.
- `returnResult` and `wait` must be booleans when present. Both are compared
  with `=== true`, so a string `"true"` (the tool path forwards raw JSON, and a
  model or harness can stringify a boolean) would read as false: a dispatch
  whose result is never delivered, or a wait that returns at once. A
  non-boolean is rejected with a 400 before anything is created, the same way
  `schedule.toggle` requires its `disabled` boolean.
- Validation that protects side effects runs before session creation or
  dispatch. An explicitly requested model, agent, or variant is checked against
  the directory's own OpenCode agent and provider lists before any session,
  worktree, or goal is created, because `prompt_async` accepts an unusable
  selection and then fails only on the event stream. A failed or empty lookup
  never turns a valid selection into a rejection.
- `promptDispatched` reports an observed dispatch, never an accepted request.
  After `prompt_async` the service confirms a new user message reached the
  session; when it does not, the result reports `promptDispatched: false` with
  `promptError` instead of claiming success.
- Send and fork dispatches without an explicit model/agent/variant reuse the
  target session's last user-message selection before falling back to the
  configured defaults; only session creation resolves defaults directly.
- `session.create` with `pullRequest` passes the number, `worktree` and
  `branch` as folder and local-branch names, and `branchOff` when given, to
  the session service, which creates the worktree through the injected
  `createChangeRequestWorktree` (the Git routes' contributor pipeline) before
  any session exists. It checks out the request's branch, or with `branchOff`
  starts a new branch from its head; without `branchOff` the profile setting
  `pullRequestWorktree` decides. A new branch is `branch`, else the
  `pullRequestBranchTemplate` (default `{name}-from-pr-{pr}`) filled with the
  worktree name, the number and the head. Without `worktree`, the control
  service names the worktree from the prompt as it does for any new worktree
  (`resolvePullRequestWorktreeName`); a checked-out request's worktree is
  named after its branch. A fork's request cannot be branched off (409).
  A malformed number or `branchOff`, or `startRef`/`setUpstream` beside it, is
  a 400; a server without that pipeline answers 501 and never makes a plain
  branch worktree instead; a provider or transfer refusal keeps its status and
  message, and no session is created.
- `session.moveToWorktree` moves a session into a new worktree of its
  repository and is the session service's `moveToWorktree`
  (`../openchamber-sessions/worktree-move.js`). The session defaults to the
  caller, the source directory to where that session lives (the global
  session list, else the call's directory), `worktree` names the folder and
  is required, `branch` and `startRef` are optional, and `existingBranch`
  checks out a branch that already exists in place of both. The worktree is made by
  the same `createWorktree` pipeline as `session.create`, waits for the same
  bootstrap, then the checkout's uncommitted changes travel in one git stash
  applied by hash, and the session is moved last through OpenCode's
  `session.move`. A failure after the worktree exists removes it again and
  puts the changes back; when restoring fails too, the error names the stash
  so nothing is lost. A 409 means the changes did not apply on the start ref.
  Without `startRef` the move starts from the repository's default branch
  (its local copy first), or from the project root's HEAD when the `agent`
  start setting is `project-root`.
- Default agents resolve from the owning project before global settings and
  OpenCode defaults. Directory-based requests identify the project before
  creating a worktree; existing linked worktrees resolve through Git's primary
  worktree root. Send/fork fallback uses that same owner. Configured model IDs
  and effort preferences survive missing catalog entries rather than silently
  dispatching with a different model.
- Usage errors name the missing or conflicting input so CLI and agent-tool
  callers can correct an invalid request without an upfront usage manual.
- Explicit `projectId` or `directory` scope takes precedence over the managed
  tool's current-session directory fallback; the fallback never creates a
  conflicting second scope. Session reads (`session.list`, `session.status`,
  `session.messages`) resolve `projectId` through the session service's
  `resolveDirectory`, the lookup create/send/fork use: an unknown project is a
  404 and a missing project folder a 400, never a read of the current or every
  directory. Every `session.*` action refuses `projectId` and `directory`
  together with a 400, so neither silently wins.
- One failed directory status lookup produces `unknown` for only that
  directory and does not erase other session results.
- `session.create` runs in a new git worktree by default (`resolveAutoWorktree`
  in `service.js`): `worktree` names it (an absolute path when it starts with
  `/`, created exactly there by `resolveCandidateDirectory` in
  `../git/service.js`), `newWorktree: false` (or `worktree: false`) opts out,
  and otherwise the name is generated from the prompt by
  `../git/worktree-name.js` using `worktreeNameModel`, else the session's
  `model`, else the project or global `defaultModel`, else OpenCode's small
  model. A failed generation falls back to a random adjective-noun name, and a
  directory that is not a git repository stays in place; the result carries
  `autoWorktree: { mode, name?, naming?, model?, reason? }`. The same naming
  helper backs `POST /api/git/worktrees/generate-name`, which the composer's
  auto-create switch calls.
- A worktree `session.create` makes, named or automatic, starts where the call's
  `startRef` says. Without one the session service
  (`../openchamber-sessions/routes.js`) follows the profile settings through
  `resolveWorktreeStartFrom(settings, 'agent')` in `../git/worktree-start-ref.js`:
  the `agent` entry of `worktreeStartFromOverrides`, else `worktreeStartFrom`,
  else the default remote's default branch. `project-root` leaves the start
  ref out, so the worktree starts from the project root's branch;
  `remote-default` sets the default remote's default branch from local refs,
  the same rule the UI applies. A repository whose remotes name no default
  branch gets the project root's branch; a failed branch read fails the call.
- A new worktree's branch, when the call names none, is the
  `worktreeBranchTemplate` (default `{name}`) filled with the worktree name made
  fit for a branch (a path's last segment for an exact `/path`; spaces and
  characters git refuses become `-`), with `-2`, `-3`… when a local branch
  already has it (`../git/branch-name-template.js`). When a parallel call took
  that name between the branch read and the creation, `session.create` reads
  the branches again and retries once with the next free name; a branch the
  call named is never renamed. `session.create` and `session.moveToWorktree`
  both name branches this way; before the template existed, an unnamed branch
  was `openchamber/<name>`. A pull request branch-off without `branch` gets the
  same suffix from the session service's branch read.
- Action modules (`session-actions.js`, `config-actions.js`,
  `integration-actions.js`, `provider-actions.js`) are passed in as
  `actionModules` and dispatched by action name before the built-in actions;
  their definitions are part of `OPENCHAMBER_CONTROL_ACTION_DEFINITIONS`.
- `projects.add`/`projects.remove` are the only destructive-adjacent actions
  wired: `projects.add` mirrors `POST /api/openchamber/directory` exactly
  (`validateDirectoryPath`, `createProjectIdFromPath`, `persistSettings`), so
  an agent-added project is indistinguishable from one added through the UI;
  `projects.remove` only drops the configured entry via `persistSettings`,
  which recomputes `activeProjectId` on its own — the checkout, its sessions
  and its worktrees are left untouched. Both 503 when the server has not
  wired `fsPromises`/`validateDirectoryPath`/`persistSettings`/
  `createProjectIdFromPath`. Session and worktree deletion are still not part
  of the action contract.
- `session.link` records a code change under review or an issue on a session
  (`../openchamber-sessions/session-link.js`), defaulting to the calling
  session. When to link is not in the action's description but at the head of
  the tool description and in the session context
  (`../session-knowledge/DOCUMENTATION.md`): what the work is about, never one
  mentioned in passing. It sends one service-neutral record (`url`, `title`, `kind`
  `change` or `issue`, optional `identifier`) and nothing is looked up, so any
  tracker works. The URL decides what is stored: a GitHub pull or issue
  address becomes the GitHub entry (kind from the path, live state as for any
  link), a Linear issue address the Linear entry, anything else an `external`
  entry shown by identifier. A GitLab merge request or issue address (the
  `/-/merge_requests/N` shape on any host) is keyed by the thread, so linking
  it again from a tab like `/diffs` or with a query refreshes the one entry. It only adds or refreshes links, never removes
  one: the user owns removal. A missing field or a non-http(s) URL is a 400 and
  nothing is written.
- `file.open` shows a file in the user's viewer. `file-open.js` resolves a
  relative path against the session directory (an explicit `directory` wins),
  refuses a relative path with no directory at all, checks the target is an
  existing file, then hands `{ path, directory, sessionId }` to the injected
  `emit`, which `index.js` writes to every UI control stream as
  `openchamber:file-open-request`. Nothing comes back: opening a tab does not
  fail quietly on a client, so the count of clients reached is the signal, and
  zero is a 503, never a claimed success. Paths outside the workspace are
  allowed on purpose: screenshots and recordings often land in a temp
  directory, and the viewer already reads such files.
- `browser.capture` writes its image on the server, into
  `.openchamber/screenshots/` under the scoped project directory, and returns
  the project-relative path rather than the image bytes. The client that took
  the picture may be on a different machine than the repository, and a path is
  what an answer, a commit, or a review can use; base64 in a tool result cannot
  be any of those. The agent's label is reduced to a filename fragment, never
  used as a path. The result also states how to present the image, because chat
  renders the image paths written in a finished answer below that message —
  saving the file is not what shows it to anyone.
