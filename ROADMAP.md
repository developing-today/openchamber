# Roadmap

This is the roadmap for the fork. It is grouped by area, and each row has a horizon: Now, Next, Later or Ideas. How the roadmap works, and how it connects to designs and plans, is in [`planning/README.md`](planning/README.md).

A row records intent. It is not a product decision and it is not a go-ahead to build. A new control, a changed default or a changed shortcut waits for the maintainer's answer, as `CLAUDE.md` says.

Sources: open issues, [`TODO.md`](TODO.md), tracker issue #25 and the merged PRs of 2026-10-18, 2026-10-19, 2026-10-20, 2026-10-21, 2026-10-22 and 2026-10-23.

## Areas

| Area                                                                    | Current focus                                            |
| ----------------------------------------------------------------------- | -------------------------------------------------------- |
| [Releases and live validation](#releases-and-live-validation)           | No release since `v2.2.0`. Waiting on time on the Mac    |
| [Sessions and sidebar](#sessions-and-sidebar)                           | Layout options for the phone and the session rows        |
| [Nested subagents](#nested-subagents)                                   | Shipped, including the parent-cycle and any-depth fixes  |
| [Agent control and worktrees](#agent-control-and-worktrees)             | Merged, and not yet run in a live app                    |
| [Routing, knowledge and cost](#routing-knowledge-and-cost)              | Feature requests that depend on the OpenCode fork        |
| [Sync and transport](#sync-and-transport)                               | Durable cursors, a transcript that blanks                |
| [Upgrades without dropped sessions](#upgrades-without-dropped-sessions) | A supervisor and a versioned state store, both proposals |
| [Quality and CI](#quality-and-ci)                                       | Test isolation, anti-slop backlog, timeout caps          |

## Releases and live validation

`main` is more than 320 commits past `v2.2.0`, the only fork release. The agent control actions, worktree-by-default, the new sidebar layout and the worktree start points have never run in a live app. Issue #25 is the tracker. On 2026-10-17 the maintainer decided on an unsigned local build for the Mac, because there is no Apple ID.

| Title                                   | Horizon | Status   | Intent                                                                                                                                                                                          | Links |
| --------------------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Live validation of the merged work      | Now     | planned  | Call every control action with good and bad input, run worktree creation and the Auto-create switch, and use the sidebar with real requests. Do it on an isolated server first.                 | #25   |
| Cut a fork release newer than `v2.2.0`  | Now     | planned  | Dispatch `release.yml` at the validated commit. The version number is an open decision.                                                                                                         | #25   |
| Post-merge review of the sidebar layout | Now     | planned  | PR #20 merged before any review finished. Check the stored-layout upgrade path in particular.                                                                                                   | #25   |
| Install the fork build on the Mac       | Next    | proposed | Replace upstream's signed app with a locally built, unsigned fork build. It loses upstream's auto-update. The maintainer decides.                                                               | #25   |
| Open decisions after live use           | Later   | proposed | Whether new worktrees start from `origin/main`, agents create worktrees by default, the `openchamber/` branch prefix goes, the sidebar layout is the default, and which model names a worktree. | #25   |

## Sessions and sidebar

| Title                                 | Horizon | Status   | Intent                                                  | Links |
| ------------------------------------- | ------- | -------- | ------------------------------------------------------- | ----- |
| Sessions sidebar on the phone sheet   | Next    | proposed | A layout for the sessions sidebar in the phone sheet.   | #18   |
| Sidebar view mode without headers     | Next    | proposed | Keep the section order and drop the headers.            | #21   |
| Choose session row lines and elements | Next    | proposed | Let the user pick what a session row shows.             | #22   |
| Transcript does not blank mid-turn    | Next    | proposed | The transcript blanks for 57 to 149 ms twice in a turn. | #52   |

## Nested subagents

Subagents can launch subagents. Asks from any depth reach the root session, and Work Status nests running subagents under the one that started them. Ancestor walks count chains at any depth: the old 8-level cap is gone (#123).

## Agent control and worktrees

| Title                             | Horizon | Status   | Intent                                                                                                                                 | Links |
| --------------------------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `browser.scroll` stops timing out | Next    | proposed | It reports "in-app browser did not respond within 20s" every time.                                                                     | #31   |
| Name the worktree-naming model    | Later   | proposed | Today the session's model names a worktree and delays the first turn by up to 15 s. Two cheaper options were offered and not answered. | #25   |

## Routing, knowledge and cost

These ask for features that sit on top of the OpenCode fork's routing and plan tracking. See `developing-today/opencode`'s roadmap.

| Title                                              | Horizon | Status   | Intent                                                 | Links |
| -------------------------------------------------- | ------- | -------- | ------------------------------------------------------ | ----- |
| Model tier chooser and quota fallback card         | Later   | proposed | An interactive card through `render.page awaitAnswer`. | #14   |
| Auto-publish agent task plans to Project Knowledge | Later   | proposed | With live progress.                                    | #15   |
| Tier-aware dispatching and cost tracking           | Later   | proposed | For Project Knowledge plans.                           | #16   |

## Sync and transport

| Title                                              | Horizon | Status   | Intent | Links |
| -------------------------------------------------- | ------- | -------- | ------ | ----- |
| Durable OpenChamber cursors for local event frames | Later   | proposed |        | #2    |

## Upgrades without dropped sessions

Both rows are proposals from `TODO.md`. They need the maintainer's approval of a design before any code.

| Title                                                                 | Horizon | Status   | Intent                                                                                                          | Links                |
| --------------------------------------------------------------------- | ------- | -------- | --------------------------------------------------------------------------------------------------------------- | -------------------- |
| A supervisor that owns the listener and the managed OpenCode children | Later   | proposed | OpenChamber upgrades or restarts with no dropped sessions and no port change.                                   | #81, [TODO](TODO.md) |
| A versioned state store and handoff record                            | Later   | proposed | One store for each OpenCode generation, with a write-ahead handoff record and a reaper that does not read `ps`. | #82, [TODO](TODO.md) |

## Quality and CI

| Title                        | Horizon | Status      | Intent                                                                                                                                  | Links |
| ---------------------------- | ------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| UI tests pass in one process | Now     | in-progress | A combined `bun test` shows phantom failures from leaked module mocks. Several files are fixed and five failures remain in `src/hooks`. | #46   |
| Anti-slop backlog            | Later   | planned     | 9,498 findings in 1,086 files, worked in three phases from the cheapest.                                                                | #80   |

## Done

| Title                                                             | Date       | Result                     |
| ----------------------------------------------------------------- | ---------- | -------------------------- |
| New sidebar layout: attention sections, movable sections          | 2026-10-16 | #20                        |
| Worktree start points and branch templates                        | 2026-10-16 | #23                        |
| Follow subsessions of subsessions                                 | 2026-10-18 | `6247e7e`                  |
| Asks from nested subagents reach the root                         | 2026-10-18 | #69, flake pin in #75      |
| Next-attention shortcut for sessions drawn project-first          | 2026-10-18 | #71                        |
| `browser.type` checks the value landed                            | 2026-10-18 | #70                        |
| Bot workflows skip when their app is not configured               | 2026-10-18 | #62, #66, #74              |
| Concurrency groups per PR, issue or input                         | 2026-10-18 | #58, #76, #78, #86         |
| Test isolation fixes for the UI suite                             | 2026-10-18 | #53, #57, #63              |
| Contributing note on isolated test runs                           | 2026-10-18 | #50                        |
| `queue: max` startup failure in issue-intake and pr-review fixed  | 2026-10-18 | #84, #85                   |
| Cost rollup survives a parent cycle                               | 2026-10-18 | #79, #88                   |
| Session trees survive a parent cycle (mobile, header, relocation) | 2026-10-19 | #92, #94, #101, #103, #105 |
| PR checks run on pushes to main                                   | 2026-10-19 | #95, #96                   |
| Dispatch-workflow concurrency keyed by its inputs                 | 2026-10-19 | #97                        |
| Atomic-write renames retry on transient Windows errors            | 2026-10-19 | #98, #99, #106, #117, #125 |
| Sonner toast-pin test no longer flakes                            | 2026-10-19 | #107, #108                 |
| Stale WSL docs removed; French onboarding fixed                   | 2026-10-19 | #109, #110, #111, #112     |
| Least-privilege permissions in the remaining workflows            | 2026-10-19 | #113                       |
| Timeout caps on every workflow job that can carry one             | 2026-10-19 | #67, #116, #118, #119      |
| Subagent chains count at any depth (8-level cap removed)          | 2026-10-19 | #123, #126                 |
| Root `.env` untracked (already covered by `.gitignore`)           | 2026-10-19 | #120, #121                 |
| Jules upstream-sync dispatches queue with `queue: max`            | 2026-10-19 | #124                       |
| Remaining floating `@v4` action references SHA-pinned             | 2026-10-19 | #127, #128                 |
| Self-handoff readiness timeout reports log, exit and pid state    | 2026-10-20 | #131, #132                 |
| `queue: max` on stale, the last non-cancelling workflow           | 2026-10-20 | #133, #134                 |
| Electron lint stub replaced with the shared oxlint command        | 2026-10-20 | #135, #136                 |
| Electron `test:linux-desktop` smoke runs in pr checks             | 2026-10-20 | #137, #138                 |
| Release pipeline actions aligned to the repo's v7 pins            | 2026-10-20 | #143, #144                 |
| Desktop release pipeline cache aligned to v6.1.0                  | 2026-10-20 | #155, #156                 |
| pr-intake github-script aligned to v8.0.0                         | 2026-10-20 | #157, #158                 |
| Electron `build` bundles the main process (was a no-op stub)      | 2026-10-20 | #142, #159                 |
| Jules action pinned to commit SHA (opencode#184 set)              | 2026-10-20 | #162                       |
| Tracked `.create-pr-proof` screenshots removed + gitignored         | 2026-10-20 | #165, #166                 |
| Malformed versions rejected in mobile release update check          | 2026-10-20 | #180, #181                 |
| Malformed versions rejected in vscode upgrade check                 | 2026-10-21 | #182, #183                 |
| Malformed versions rejected in web upgrade check                    | 2026-10-21 | #184, #187                 |
| Malformed versions rejected in web package-manager check            | 2026-10-21 | #188, #189                 |
| Malformed versions rejected in electron compareSemver               | 2026-10-21 | #185, #190                 |
| Bare-key secret names masked and refused                            | 2026-10-21 | #208, #175, #211           |
| Secret subtrees masked; plural secret names refused                 | 2026-10-21 | #214, #215, #219           |
| Malformed weekly weekdays rejected instead of coerced               | 2026-10-21 | #209, #210                 |
| ROADMAP Done records the five version-parse completions             | 2026-10-21 | #191, #192                 |
| Non-mac releases can finalize without macOS manifests               | 2026-10-21 | #186, #193                 |
| Android launch targets the real MainActivity class                  | 2026-10-21 | #173, #200                 |
| ROADMAP Done records the #209 and #214/#215 completions             | 2026-10-21 | #220, #221                 |
| updateSettings feeds projects the migrated settings                 | 2026-10-21 | #199, #223                 |
| Electron relay and space-preview ports reject malformed values      | 2026-10-21 | #226, #227                 |
| Passphrase values masked in opencode.config answers                 | 2026-10-21 | #222, #232                 |
| Web serve --port rejects malformed and out-of-range values          | 2026-10-21 | #228, #229                 |
| ROADMAP Done records the #226 completion                            | 2026-10-21 | #230, #231                 |
| Web dev-tunnel ports reject malformed values                        | 2026-10-21 | #233, #234                 |
| Env-config ports reject malformed and out-of-range values           | 2026-10-21 | #235, #238                 |
| ROADMAP Done records the #222 completion                            | 2026-10-21 | #236, #237                 |
| ROADMAP Done records the #228, #230, #233 and #235 completions      | 2026-10-21 | #239, #240                 |
| SSH managed remote port read from anchored serve output             | 2026-10-22 | #241, #242                 |
| ROADMAP Done records the #236 and #239 completions                  | 2026-10-22 | #243, #244                 |
| Project environment command receives resolved vault values          | 2026-10-22 | #174, #245                 |
| SSH remote probe reads status lines by prefix                       | 2026-10-22 | #246, #248                 |
| Reload no longer joins a stale in-flight environment run          | 2026-10-22 | #247, #249                 |
| ROADMAP Done records the #241, #243, #174 and #246 completions    | 2026-10-22 | #250, #251                 |
| SSH remote answers read past login-shell banner output            | 2026-10-22 | #253, #254                 |
| Remote tool resolution no longer returns a banner line            | 2026-10-22 | #255, #257                 |
| ROADMAP Done records the #247, #250 and #253 completions          | 2026-10-22 | #252, #256, #258           |
| ROADMAP Done records the #259 completion                          | 2026-10-22 | #262, #263                 |
| GitHub vault-add route and client covered by tests                | 2026-10-22 | #178, #261                 |
| Queued-goal inline fallback honours the objective limit opt-out   | 2026-10-22 | #207, #205                 |
| Dev-server listener ports and pids reject trailing junk           | 2026-10-22 | #264, #265                 |
| ROADMAP Done records the #178, #207 and #264 completions          | 2026-10-22 | #266, #267                 |
| Vault read status tied to the reference it came from              | 2026-10-22 | #268, #271                 |
| Terminal preview ports are range-checked                          | 2026-10-22 | #274, #276                 |
| Pool schedule windows with equal start and end rejected           | 2026-10-23 | #341, #343                 |
| Non-finite pool weights and health rates rejected                 | 2026-10-23 | #344, #345                 |
| ROADMAP Done records the #274 completion                          | 2026-10-23 | #279, #346                 |
| Pool budget keys must name a route target                         | 2026-10-23 | #347, #348                 |
| Pool schedule targets must match a route target                   | 2026-10-23 | #349, #350                 |
| ROADMAP Done records the #351 completion                          | 2026-10-23 | #351, #352                 |
| Pool schedule patterns partly overlapping a target accepted       | 2026-10-23 | #353, #357                 |
| Pool budget keys must be concrete models, not patterns            | 2026-10-23 | #354, #355                 |
| Pool targets referencing nonexistent or cyclic routes refused     | 2026-10-23 | #356, #361                 |
| Pool schedule targets judged as OpenCode applies them             | 2026-10-23 | #358, #362                 |
| Pool weights and budgets on a fixed route rejected                | 2026-10-23 | #359, #360                 |
| Terminal preview port 0 is no longer announced                    | 2026-10-22 | #283, #284                 |
| ROADMAP Done records the #266 and #268 completions                | 2026-10-22 | #277, #278                 |
| SSH probe status parser rejects trailing junk                     | 2026-10-22 | #286, #287                 |
| SSH probe statuses must use the canonical shape                   | 2026-10-22 | #288, #290                 |
| Terminal preview port-0 URL no longer discards a sibling URL      | 2026-10-22 | #285, #309                 |
| SSH served-port parser rejects leading-zero spellings             | 2026-10-22 | #311, #312                 |
| SSH remote-server registry drops out-of-range ports               | 2026-10-22 | #313, #314                 |
| SSH probe status parser rejects whitespace-padded spellings       | 2026-10-22 | #292, #315                 |
| SSH instance sanitizers range-check ports (1-65535)               | 2026-10-22 | #316, #317                 |
| Device-settings closing/hidden flush stays delivered              | 2026-10-22 | #281, #318                 |
| Arabic and Hebrew routing strings and Target header translated    | 2026-10-23 | #299, #320                 |
| Pool health panel lands; unused plan-links route removed          | 2026-10-23 | #294, #303                 |
| Queued-goal applyGoalChoice extracted and pinned by tests         | 2026-10-23 | #282, #333                 |
| Refused closing send overlap pinned in device settings tests        | 2026-10-23 | #335, #336                   |
| Model pool validator accepts route schedules                        | 2026-10-23 | #298, #340                   |
| Pool budgets judged through route references                        | 2026-10-24 | #363, #376                 |
| Pool schedule targets judged through route references               | 2026-10-24 | #364, #381                 |
| ROADMAP Done records the #359 completion                            | 2026-10-24 | #367, #368                 |
| Empty variant settings on a pool target rejected                    | 2026-10-24 | #369, #370                 |
| Pattern weights keys in the pool rejected                           | 2026-10-24 | #371, #372                 |
| Target until that can never apply rejected                          | 2026-10-24 | #373, #387                 |
| Schedule windows that already ended rejected                        | 2026-10-24 | #374, #375                 |
| Duplicate targets in one pool route rejected                        | 2026-10-24 | #377, #378                 |
| Pool targets referencing their own route rejected                   | 2026-10-24 | #379, #380                 |
| Pool route-reference target that is trail-dead refused              | 2026-10-24 | #382, #392                 |
| Variant settings on a route-reference target rejected               | 2026-10-24 | #395, #396                 |
| Concrete target shadowed by an earlier pattern rejected             | 2026-10-24 | #383, #398                 |
| ROADMAP Done records the #311, #313, #292, #316, #281 completions   | 2026-10-24 | #321, #408                 |
| Pattern target covered by an earlier pattern rejected               | 2026-10-24 | #406, #407                 |
| ROADMAP Done records the #299 and #294 completions                  | 2026-10-24 | #334, #409                 |
| Local model download aborts once it passes the pinned size          | 2026-10-24 | #412, #413                 |
| ROADMAP Done records the #382, #395, #383, #321, #406, #334 rows    | 2026-10-24 | #410, #414                 |
| ROADMAP Done records the #412, #413, #410, #414 completions         | 2026-10-24 | #415, #416                 |
| SSH remote-server list filter reuses validPort                      | 2026-10-24 | #418, #420                 |
| ROADMAP Done records the #415 completion                            | 2026-10-24 | #419, #421                 |
| Dictation model downloads pinned by size and SHA-256                | 2026-10-24 | #417, #424                 |
| ROADMAP Done records the #418 and #419 completions                  | 2026-10-24 | #425, #426                 |
| Stale x86_64-linux node_modules hash updated                        | 2026-10-24 | #422, #423                 |
| Cached-archive pin re-verification covered by dictation tests       | 2026-10-24 | #428, #429                 |
| ROADMAP Done records the #417, #425 and #422 completions            | 2026-10-24 | #430, #431                 |
| ROADMAP Done records the #428 and #430 completions                  | 2026-10-25 | #435, #436                 |
| Web CLI `--lines`/`--limit` strict parsing                          | 2026-10-25 | #433, #434                 |
| Schedule targets judged by their trimmed spelling                   | 2026-10-25 | #432, #437                 |
| ROADMAP Done records the #432 completion                            | 2026-10-25 | #441, #442                 |
| ROADMAP Done records the #433 and #435 completions                  | 2026-10-25 | #438, #443                 |
| Model-route targets refuse padded and empty-segment spellings       | 2026-10-25 | #439, #440, #444           |
| Scheduled opencode-update workflow (daily bump, build, test)        | 2026-10-25 | #448                       |
| Web CLI `--timeout` strict parsing                                  | 2026-10-25 | #446, #447                 |
| opencode-update failure excerpt keeps the error at the tail         | 2026-10-25 | #450, #451                 |
| Target references refuse whitespace inside a segment or variant     | 2026-10-25 | #453                       |
| ROADMAP Done records five completions through #453                  | 2026-10-25 | #445, #454                 |
| ROADMAP Done records the #450 completion                            | 2026-10-25 | #455                       |
| opencode-update merge handoff for token refusals, cleaner excerpts  | 2026-10-25 | #452                       |
| OpenCode updated to d7d6466f8342                                    | 2026-10-25 | #456                       |
| Renovate kept off the workflow-owned opencode flake input           | 2026-10-25 | #459                       |
| opencode-update install failures recorded on the tracking issue     | 2026-10-26 | #457, #460                 |
| ROADMAP Done records the #448, #452, #456, #459, #460 completions   | 2026-10-26 | #458, #461                 |
| pr-intake runs on this fork as well as upstream                     | 2026-10-26 | #87, #462                  |
| pr-intake labels with the workflow token when the app is unset      | 2026-10-26 | #87, #466                  |
