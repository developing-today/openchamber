# Routing

## Purpose

Jev model routing, the permission safety net, and the classification provider
that answers both. With the `openchamber/auto` model selected, the server asks
[Jev](https://docs.typesafe.ai) (TypeSafe's System One decision model) which
task category a message belongs to and sends it with that category's model,
thinking variant and agent. In a session whose permission mode is `safety`
(`../permission-auto-accept/DOCUMENTATION.md`), the same kind of call decides
whether a permission is accepted or stays on screen for the user.

Routing needs the OpenChamber server, so it is present wherever that server is
and absent everywhere else: VS Code talks to OpenCode directly and never offers
Auto. There is no env gate — the feature shipped dark behind
`OPENCHAMBER_ROUTING_ENABLE` until Jev stopped needing a key of the user's own
(see "Where a Jev request goes"), which was the reason to hide it.

## Files

- `defaults.js` — the Auto sentinel, the Jev endpoints and models, the
  `ZEN_JEV_PROMOTION_ACTIVE` switch, built-in categories, the question wording
  for routing and for the safety net, history excerpt limits.
- `classifier.js` — the classification providers: `resolveClassifier` (the
  user's pick, what is usable, and the source that actually answers) and
  `classifierEndpoint` (where a request for a source goes),
  `legacyClassifier` (the view older clients parse) and
  `parseCustomEndpointUrl` (the custom endpoint's request URL).
- `store.js` — `routing.json` (only deviations from the built-ins),
  `routing-auth.json` (the TypeSafe key alone, mode 0600),
  `classification.json` (the classification provider pick),
  `classifier-endpoint.json` (the custom endpoint, mode 0600) and
  `auto-sessions.json` (the sessions on Auto) in the OpenChamber data dir. An unreadable pick file reads as no pick, an
  unreadable endpoint file as no endpoint. `resolveEffectiveConfig` merges built-ins with stored overrides;
  `toStoredConfig` is its inverse. A missing file is the defaults, a malformed
  one throws.
- `jev.js` — request builders, answer parsing, and the HTTP call with a
  timeout to the endpoint `classifierEndpoint` chose.
- `history.js` — the last three settled turns through session assist's
  `loadAssistContext` (text parts only, attached quotes included, no files or
  tool payloads), each user message cut to its head and each answer to head
  plus tail. The new request is never cut. Also the model that wrote the last
  settled answer and when it finished (`lastAnswer`), for `cache.js`.
- `cache.js` — "Try to preserve cache usage": which category a send stays on
  while the current model's prompt cache is likely warm (`cacheHoldCategory`),
  and how long that is given OpenCode's `warming` config (`warmWindowMs`).
- `runtime.js` — `createRoutingRuntime`: `describe`, `classifierEndpoint` (the
  endpoint a Jev request goes to now, or null; also used by
  `../session-work` and `../session-goal`), `noteModelSelection`,
  `isAutoSession`, `resolveAutoSelection`, `applySessionSelection`, `routeSend`,
  `evaluatePermission`, `legacySafetyNetEnabled`, config, token, classifier and
  custom endpoint writes, event broadcasts, and `testClassifier` (one probe
  request from Settings' Test button, through the provider answering now or
  through custom endpoint fields as typed; stores nothing, and typed fields are
  refused in enterprise mode like a save). The classifier judges the user's
  text plus one attachment fact for sends with images (`attachmentHint`,
  `routingRequestTextOf`); that fact never reaches OpenCode.
- `routes.js` — `/api/routing` (GET, PUT), `/api/routing/token` (PUT, DELETE),
  `/api/routing/classifier` (PUT), `/api/routing/classifier/custom` (PUT,
  DELETE), `/api/routing/classifier/test` (POST) and
  `registerRoutingPromptRewrite`.

## Invariants

- The sentinel never reaches OpenCode. OpenCode 2.x holds the model and agent
  on the session and a prompt body carries only the user's text, so Auto is
  per-session state: `POST /api/session` drops the sentinel from the create
  body (the session starts on OpenCode's default; the first send switches it),
  `POST /api/session/:id/model` with the sentinel is
  swallowed and marks the session (`noteModelSelection`), and every
  `POST /api/session/:id/{prompt,command}` in a marked session is routed
  (`routeSend`) and switches the session onto the answer before the send is
  forwarded. Both sit ahead of the generic proxy, which replays a parsed body.
  The message queue calls `resolveAutoSelection` itself and applies the answer
  with the model/agent switches it already makes. Without a fallback model the
  runtime throws 400 rather than forwarding. The OpenChamber session service
  (`openchamber-sessions/routes.js`) talks to OpenCode through the SDK and can
  pick Auto up from Session Defaults, so it calls `resolveAutoSelection` itself
  before switching the session.
- The mark is saved in `auto-sessions.json` in the data dir, beside
  `routing.json`. A change is written before the switch answers, and the list
  is read back when the runtime starts, so a restart keeps Auto. Choosing a real
  model removes the mark. A failed write is logged, and the mark holds until the
  next restart.
- Routing failures keep the user's own behaviour: a Jev error, timeout, unknown
  category or low confidence routes to the fallback model, and the decision
  carries the reason.
- The safety net accepts only on a verdict from Jev. With no usable
  classification provider it holds quietly (the session behaves like `ask`);
  when Jev fails it holds, broadcasts `openchamber:routing.safety-skipped` with
  the error, and does not remember the failure, so reconnect reconciliation asks
  again. It runs whether or not Auto routing is enabled: the routing config's
  `safetyNet.enabled` is no longer read except once, by
  `legacySafetyNetEnabled`, when the permission policy converts pre-modes
  entries. `safetyNet.threshold` still applies.
- A category without a model uses the fallback model *and* variant; a variant
  only travels with the model it was chosen for. A category agent replaces the
  composer's agent; an empty one keeps it.
- A variant the model's catalog entry does not list is dropped before the
  switch, so the reply runs on the model's default thinking instead of OpenCode
  refusing it (Settings from before #4133 saved list positions like `"2"`).
  An unreadable catalog, or one that does not know the model yet, keeps it.
- A provider's prompt cache belongs to one model, so a model switch makes the
  new model read the whole context uncached. With `preserveCache` on (the
  default; a config without the key reads as on), a send Jev routes to a
  built-in category below the one the session is on runs as that one instead,
  while the cache is likely warm. "Below" is the built-in order trivial <
  research < implement < hard; the session is on the highest enabled built-in
  category whose model wrote the last settled answer. Moving up is never held,
  and neither is a send routed to a user category, a fallback for low
  confidence or an error, or a hold that would change the agent (another
  agent is another system prompt, which misses the cache anyway). Warm means
  within 5 minutes of the last answer finishing, or, when OpenCode's `warming`
  is on for the directory, within its `duration` (30 minutes for `true`) plus
  5 minutes. The config is read only after the first 5 minutes; an unreadable
  one counts as warming off. The decision event names the category the send
  ran as and carries `cacheHold.requested`, the one Jev chose.
- Auto is offered (`autoReady`) with a usable classification provider
  (`jevAvailable`), `enabled`, a fallback model and at least two enabled
  categories.
- Held permission decisions are cached for 15 minutes per request id so
  reconnect reconciliation in `permission-auto-accept` does not re-ask Jev;
  `permission.replied` forgets them.
- The send rewrite reads a body only in a session already marked as routed,
  which the URL alone answers; every other send, and anything that is not JSON,
  reaches the proxy as the stream it arrived as.

## Where a Jev request goes

The user picks a classification provider in Settings → Providers →
Classification providers:

- `off`: no Jev at all. Every Jev feature takes its no-provider path.
- `zen-promo`: `opencode.ai/zen/v1/systemone` as `jev-1.13-free`, which OpenCode
  Zen answers with no credential at all. Usable while
  `ZEN_JEV_PROMOTION_ACTIVE` is true; flip it when OpenCode ends the promotion.
- `zen-key`: the same endpoint as `jev-1.13` with a Zen API key read from
  OpenCode's credentials (`opencode/auth.js`, entry `opencode`, type `api`).
  An OpenCode account sign-in is an OAuth credential, and zen rejects it as a
  key ("Invalid API key", checked 2026-09-27), so it does not count. The paid
  call itself is not verified live yet.
- `openrouter`: `openrouter.ai/api/v1/systemone` as `jev-latest` (OpenRouter's
  `~typesafe/jev-latest` alias) with the OpenRouter API key saved in OpenCode
  (entry `openrouter`, type `api`), billed to that OpenRouter account.
- `vercel`: `ai-gateway.vercel.sh/typesafe/v1/systemone` as `typesafe-ai/jev`
  with the Vercel AI Gateway API key saved in OpenCode (entry `vercel`, type
  `api`). Both gateways implement TypeSafe's request and response shapes, so
  `jev.js` is the same for every source. Both answer 401 without a key
  (checked 2026-09-27); a paid call is not verified live yet.
- `typesafe`: `api.typesafe.ai/v1/systemone` as `jev-latest` with the key saved
  in `routing-auth.json`. Saving a key also picks it.
- `custom`: any endpoint that speaks the System One API, with the URL, model
  and optional key the user saved (`classifier-endpoint.json`, mode 0600, its
  own file so a token write never rewrites it). The key goes as a bearer when
  present; `describe` returns `customEndpoint` as URL, model and `keyPresent`,
  never the key. `setCustomEndpoint` stores the request URL exactly as pasted
  (trimmed, without a `#fragment`) and appends nothing: a company proxy can
  serve System One on any path, so only the user knows the full address. Before
  2026-10-05 a `/v1` base or an API root got `/v1/systemone` appended; URLs
  saved then are already full and read back unchanged, but a pin written in
  that short form now needs the full address. Only http(s), no credentials in
  the URL. It does not go through the TTS remote-URL gate: a remote classifier is
  the user's explicit choice, the same as the hosted sources. Saving picks it;
  a missing `key` keeps the saved one, null removes it without changing the
  pick.
  An administrator can pin the endpoint (`readPinnedCustomEndpoint`): `jev` in
  the machine policy file, else `OPENCHAMBER_JEV_URL`, `OPENCHAMBER_JEV_MODEL`
  defaulting to `jev-latest`, optional `OPENCHAMBER_JEV_API_KEY` (source rules
  in `../enterprise-mode.js`). The pin
  replaces the saved endpoint, `customEndpoint.pinned` tells the page to show
  it read-only, and `setCustomEndpoint` / `clearCustomEndpoint` answer 409.

In enterprise mode (policy file or `OPENCHAMBER_ENTERPRISE_MODE`, `../enterprise-mode.js`)
`resolveAccess` treats the pick as `off` whatever is stored (the stored pick is
kept for when the mode is lifted), `setClassifierSource` refuses anything but
`off` and `setToken` and `setCustomEndpoint` refuse every write with 403, and `describe` reports
`enterpriseMode` so the page shows why only Off is offered. With a pinned
endpoint it is the administrator's own infrastructure, so it becomes the
default (`custom` unless the stored pick is `off`) and `custom` is the one
other pick allowed.

Jev reads conversation excerpts, so it is opt-in. Without a stored pick the
default is `typesafe` when a key is saved (saving a key is choosing it, and it
always won before the pick existed) and `off` otherwise. Until v2.0.3 the
default was `zen-promo`, which sent every message of users who never opened
this page to zen (#4109); an install without a stored pick now reads as `off`
with no conversion. A pick that cannot be used falls back to the first usable
key (`typesafe`, `custom`, `openrouter`, `vercel`, `zen-key`: what the user set
up in OpenChamber for Jev before keys borrowed from OpenCode); none usable
means no Jev.
`zen-promo` needs no credential, so it is never a fallback: only an explicit
pick sends anything there, and `off` never falls back.
The OpenCode keys are read on every request, so a key added or removed in
OpenCode counts from the next request on.

OpenRouter and Vercel also count a key in `OPENROUTER_API_KEY` /
`AI_GATEWAY_API_KEY` (`readOpenCodeKeys`), because OpenCode connects those
providers from the variable live and never stores it (v2 `integration.ts`
`resolveConnections`). A key saved in OpenCode wins. The server's
`process.env` already carries the login-shell snapshot and a managed OpenCode
is spawned from it, so both see the same variable; an external OpenCode
started elsewhere may not, and then the variable simply is not seen. Zen has
no variable.

Every zen call is tagged `x-opencode-client: openchamber`. Dax approved the
free use in Slack on 2026-09-22 on terms the code and the copy keep together:
zen can identify and throttle our calls through that header, and the
Classification providers page tells the user in plain words that the free model
is a limited-time OpenCode promotion. Zen rejects the `jev-latest` alias, so
versioned ids are sent.

Never make the free tier the only path: the zen docs call it "available for a
limited time", and the keys are what users fall back to when it ends.

## Events

Broadcast on the OpenChamber control stream: `openchamber:routing.updated`
(availability, including `jevAvailable`), `openchamber:routing.decision` (per
send), `openchamber:routing.permission-held`,
`openchamber:routing.safety-skipped`. Showing the held request itself is not
routing's job: the permission auto-accept runtime reports every request it
left for the user (`../permission-auto-accept/DOCUMENTATION.md`).

`/api/routing` keeps `jevSource` (`typesafe` or `zen-free`) for clients from
before the classifier pick and adds `jevAvailable`, `classifier` and
`classification` (both `selected`, `effective`, `sources`). `classification`
is the full picture. `classifier` is what v2.0.2 clients parse: their schema
knows only `zen-promo`, `zen-key` and `typesafe` and rejects the whole state
on any other id, so it lists only those and is null while OpenRouter,
Vercel or a custom endpoint is picked or answering (`legacyClassifier`). Current clients read
`classification` and drop source ids they do not know.

## UI

`packages/ui/src/stores/useRoutingStore.ts` projects `/api/routing` and these
events (`selectSafetyNetAvailable` gates the safety-net mode everywhere);
`hooks/useRoutingSync.ts` keeps it current and shows the skipped-check toast. `lib/routing/autoModel.ts` owns the sentinel; `useConfigStore` accepts it
as a valid selection while `autoReady`. `ModelPickerList` renders it as the
pinned `leadingEntry`; `ModelControls` hides the agent and thinking controls
while Auto is selected. `PermissionCard` shows the hold reason. Settings →
Routing (`components/sections/routing/RoutingPage.tsx`) edits the config with
debounced saves. Settings → Providers → Classification providers
(`components/sections/classification/ClassificationProvidersPage.tsx`) picks
the source and manages the TypeSafe key and, through `CustomEndpointFields.tsx`,
the custom endpoint; `JevAccessNote` links there from the
features that need Jev.

## Model pool telemetry

Separate from Jev/Auto above: read-only views over OpenCode's own
`route_attempt`/`route_decision` tables (`experimental.model_routes` pools,
`model-routes.js`'s concern), not OpenChamber's classifier. Both report
`{ available: false, reason }` instead of an empty result when the database,
its routing tables, or a usable `node:sqlite`/`bun:sqlite` driver are absent.

`model-routes.js` checks each new or changed pool, `schedules` included,
against OpenCode's schema and its own stricter rules before saving it.

- `model-route-stats.js` — `GET /api/model-routes/stats`: aggregate counts,
  latencies, grouped errors and hedge win rates per target over a trailing
  window (`hours`, default 24).
- `message-model-attribution.js` — `GET /api/model-routes/turns?sessionID=`:
  per-assistant-message attribution for one session, keyed by assistant
  message id (`routeID`, the `selection` decision nearest before the attempt
  that answered, and a `failover` block when an earlier attempt for the same
  message failed over to a different target first). Every request OpenCode
  runs writes an attempt row, routed or not, so a direct (non-pool) model gets
  an entry too, with `routeID: null`. This backs the UI's per-message model
  badge, its hover detail, and the transcript's model-changed divider; the
  divider's "does the real model differ from the previous turn" check itself
  needs no telemetry, since it just compares the assistant messages' own
  `providerID`/`modelID`/`variant` (`packages/ui/src/components/chat/lib/turns/modelChange.ts`).

## Model pools

`model-routes.js` serves `/api/model-routes` (GET, PUT) over
`experimental.model_routes` and `experimental.model_route_tuning`. No pool in
the OpenCode config can fail a read or block a save of another pool.

Both routes read the merged global config: `opencode.json` and
`opencode.jsonc` in OpenCode's config directory, plus the file
`OPENCODE_CONFIG` names (`readConfigLayers(null)`, so project config files are
neither read nor written). A save writes both keys into the primary global
file, `opencode.json` when it exists, else `opencode.jsonc`, else a new
`opencode.json` (`paths.userPath`), then asks OpenCode to reload
(`refreshOpenCodeAfterConfigChange`). When that request fails, the file stays
written and OpenCode reads it at its next reload. In enterprise mode every PUT
answers 403; GET still answers.

- **Schema lists.** `ROUTE_KEYS`, `TARGET_KEYS`, `HEALTH_KEYS`, `BUDGET_KEYS`,
  `SCHEDULE_KEYS`, `WINDOW_KEYS` and `TUNING_KEYS` copy the keys OpenCode's
  schema defines (`packages/schema/src/config/model-routes.ts` in the OpenCode
  fork). A key OpenCode adds and these lists lack is reported on every pool
  that uses it, and a save that changes such a pool is refused until forced,
  so the lists move with that file.
- **Problems.** `modelRouteProblems` reports every problem in one pool, each
  with `skipsPool`. It is true where OpenCode's own schema refuses the value:
  OpenCode decodes each pool on its own and leaves out one that fails
  (`packages/core/src/config/normalize.ts`, `decodeMap`). Examples are
  `Infinity` as a weight or as `minOutputTokensPerSecond`, and a target `until`
  above `Number.MAX_SAFE_INTEGER` (OpenCode's `PositiveInt` is a safe
  integer). It is false for OpenChamber's stricter checks of what OpenCode
  loads anyway: an unknown key, which OpenCode drops; `slowThreshold` above
  `sampleWindow`, which it clamps; a weight for a target the pool lacks and a
  fixed pool's `selection`, which it ignores; an empty target list; and a target
  written as `{ providerID, model }`, which OpenChamber does not check.
- **GET** returns `routes`, `tuning`, `path` and `problems`, the problems of
  each pool that has any, keyed by pool id. A read never refuses.
- **PUT** compares each pool sent with the one the merged config holds, as JSON:
  that is how the client received it, so a JSONC `1e999` read as `Infinity`
  comes back as `null` and still counts as unchanged. An unchanged pool is
  written exactly as the config holds it and is not checked
  (`reviewModelRoutesSave`). When a new or changed pool has a problem, the save
  answers 400 with `error` and `problems` for those pools and writes nothing;
  with `force: true` it writes them and returns them in `problems` with the
  other pools'. `tuning` is checked as a whole, and `force` does not apply to
  it.

The client (`packages/ui/src/lib/routing/modelRoutesApi.ts`) reads each pool on
its own. A pool the structured editor cannot represent (a key it does not know
anywhere in the pool, a value of another type, a `{ providerID, model }`
target) becomes a `json` entry: the JSON as received, plus the path the editor
stopped at, sent back unchanged unless the user edits that JSON. Review
settings it cannot read come back as `unreadable`, and the pools still load.
Settings (`packages/ui/src/components/sections/routing/ModelPoolsSection.tsx`)
rolls a refused or failed save back to the last saved pools, for an edit in
the structured editor and in Raw JSON alike. A refused save lists its problems
with Save anyway; a failed one shows the error.

## Sentence rules

Settings → Routing → Route by sentence
(`packages/ui/src/components/sections/routing/RouteRulesSection.tsx`,
`RouteRulesAdvanced.tsx`, `packages/ui/src/lib/routing/routeRulesApi.ts`)
turns one plain sentence, such as "skip anthropic today", into overrides that
OpenCode applies while it picks a pool's target. `route-overrides-store.js`
keeps them (see Route overrides).

- `route-interpreter.js` reads a sentence in stages and returns a decision, a
  question, or nothing. It touches no files, so the stages and the learning are
  tested directly.
- `route-rules-routes.js` serves `/api/model-routes/rules` (GET),
  `/api/model-routes/interpret` and `/api/model-routes/interpret/answer`
  (POST), `/api/model-routes/rules/:id` (DELETE, the undo),
  `/api/model-routes/settings` (GET, PUT), `/api/model-routes/wait` (GET),
  `/api/model-routes/local` (GET) and `/api/model-routes/local/download`
  (POST). It runs the stages on sentences of 1 to 500 characters and writes
  each decision through the overrides store.
- `route-learning.js` (`learnedChoices`) works out which answer to a
  clarifying question the user has settled on.
- `route-local-model.js` pins, downloads and runs the local stage's model.
- `route-settings.js` keeps `route-settings.json` in OpenChamber's data
  directory: which stages run, `learnAfter`, `waitPercentile` and
  `waitMinSamples`.
- `route-wait.js` (`estimateWait`) estimates how long a target stays out of
  rotation, from OpenCode's `route_health` table.

Invariants:

- The stages run in order: keywords, then the local model, then the
  classification provider. The first stage that decides wins. Only the keyword
  stage asks a question, and the later stages see only sentences it could not
  read, so the user is asked at most one thing and no model answers a question
  meant for the user.
- A model stage only picks from fixed answers (`choiceQuestions`). For the
  local model the provider and the model family come from the sentence itself
  (`groundChoices`), because a small model invents names. A
  classification-provider answer below 0.6 confidence counts as none. A model
  stage never avoids a model family without a provider to scope it.
- The classification-provider stage sends the sentence and the provider ids to
  the endpoint `routingRuntime.classifierEndpoint()` returns, so it follows the
  user's pick and enterprise mode, and it is skipped when there is none.
- Every override ends. A sentence without a duration lasts a day, and its
  summary says the day was assumed. An override reaches `fixed` pools unless
  the sentence excludes them, and none is limited to one pool.
- Answering a clarifying question records the choice in
  `route-feedback.jsonl`; undoing a rule that came from a question records a
  vote against that answer. An answer is learned once it has at least
  `learnAfter` net votes (3 by default) and leads every other answer. A learned
  answer is applied as tentative, and its summary says it was the user's
  earlier choice.
- Undo removes every rule written for the same sentence.
- The settings never go into the OpenCode config. Values are clamped
  (`learnAfter` 1 to 20, `waitPercentile` 5 to 75, `waitMinSamples` 1 to 100),
  and an unreadable file reads as the defaults.
- The local model is downloaded only when the user asks, from a Hugging Face
  URL pinned to one commit, into `$XDG_CACHE_HOME/openchamber/models`
  (`~/.cache` by default). It is kept only when its size and SHA-256 match the
  pinned values; a model without a pinned digest is refused with 409 before
  anything is fetched. `node-llama-cpp` is loaded only when the stage first
  runs.
- A wait estimate reads the target's `cooldown-start` rows from the last 30
  days, at most 2,000. It takes the chosen percentile of the closest group with
  enough samples (same weekday and hour give or take one, then same hour, then
  all) and never goes below the ordinary 60-second cooldown. Too few samples
  give no estimate, and a missing database or routing table comes back as
  `reason`.

## Route overrides

`route-overrides-store.js` owns `route-overrides.json`, the overrides OpenCode
reads while it picks a pool's target, and `route-feedback.jsonl`, the answers
the interpreter learns from. Both live in OpenCode's data directory
(`resolveOpenCodeDataDir`: `$XDG_DATA_HOME/opencode`, default
`~/.local/share/opencode`), where OpenCode's `ModelRouteOverrides.filePath`
looks.

- The file is `{ version: 1, overrides: [...] }` and stays in step with
  `ModelRouteOverrides.parse` in OpenCode
  (`packages/core/src/model-route-overrides.ts`). OpenCode reads it again
  whenever its modification time changes, so a new override applies to the
  next routed request without a config reload.
- An entry is kept only with an id, an action (`avoid`, `prefer` or
  `allow-over-budget`), a finite `until` and at least one provider or model
  pattern. Anything else is dropped on read, and a missing or unreadable file
  reads as no overrides.
- Every write drops the entries whose `until` has passed. `fixed` is true
  unless an entry says `false`, so an override reaches fixed pools by default.
- OpenCode's parser also accepts `weight` and a recurring `schedule`, which
  needs no `until`. This store keeps neither field: OpenChamber's next write
  drops an entry without `until`, and an entry with both loses its window and
  then applies at all hours until it ends. OpenCode itself never writes the
  file (fork main at 1668a0350b), so only a hand edit adds such entries.
- Feedback is appended as one JSON line per answer or undo, and a line that
  does not parse is skipped.

## Plan store

`plans.js` and `plan-routes.js` own the plan store: the user's plans, each
model's cost tier, what each pool is for, and the notes about how usage has
felt. It is `plans.json` and the append-only `plan-notes.jsonl` in OpenCode's
data directory, the records OpenCode's `plan_info` and `route_usage` tools
read. Settings → Routing → Plans and usage
(`packages/ui/src/components/sections/routing/PlansSection.tsx`,
`packages/ui/src/lib/routing/plansApi.ts`) edits it.

`plan-routes.js` serves `/api/routing/plans` (GET), `/api/routing/plans/record`,
`/api/routing/plans/model` and `/api/routing/plans/pool` (PUT), and
`/api/routing/plans/notes` (GET, POST).

- The shapes match `packages/core/src/model-plan.ts` in OpenCode. Coverage is
  `subscription`, `credits`, `metered`, `free` or `trial`; a model's tier is
  `cheap`, `standard` or `frontier`; a note's kind is `experience`,
  `expectation`, `plan-change`, `correction` or `other`. A change on one side
  needs the same change on the other and in `plansApi.ts`.
- A missing `plans.json` is an empty store. A malformed one answers 409
  `PLAN_STORE_MALFORMED` and is left as it is, so a bad write never erases the
  user's plans.
- Every write is checked against the schema, written to a temporary file and
  renamed into place.
- An update sets the fields it names, keeps the ones it leaves out, and removes
  a field sent as `null`. A plan sent without an id gets a slug of its provider
  and its plan name or label. A model needs a tier the first time it is set
  (400 `INVALID_TIER`).
- Nothing is deleted: there is no delete route, and a plan that ends is marked
  `expired` or `cancelled`. Notes are only appended, and a damaged line is
  skipped and counted (`skippedNotes`). Notes written from Settings carry
  `source: "ui"`.
- GET returns the newest 20 notes. The notes route takes a `limit` from 1 to
  500, 50 by default.

## Tests

`store.test.js` (defaults, deviation round-trip, the cache setting's default,
deleted built-ins, malformed
file, token file mode, classifier pick, custom endpoint file), `runtime.test.js` (request text,
excerpts, decisions, cache holds and the warm window, endpoints, custom URL normalization and setter,
classifier fallback, rewrite and fallback
paths, safety net accept/hold/skip/unavailable), `routes.http.test.js`
(sentinel dropped from a create and swallowed on the model switch, routed send
ahead of a stand-in proxy, the routes), `model-routes.test.js` (every
validator rule, which problems skip a pool, problems on a read, unchanged pools
written as stored, a refused save and its forced retry),
`route-interpreter.test.js` (the keyword stage, its question and learned
answers, stage order and toggles, grounding, override records),
`route-rules-routes.test.js` (interpret, answer, undo, settings, wait and the
local model over HTTP), `route-learning-wait-settings.test.js` (the learning
threshold, wait estimates, settings ranges), `route-local-model.test.js` (the
pin and the download checks), `route-overrides-store.test.js` (the file
OpenCode reads, expiry, feedback lines, `XDG_DATA_HOME`), `plans.test.js` and
`plan-routes.test.js` (merges, refusals, atomic writes, the malformed file,
notes). The queue and auto-accept tests cover their hooks.
