# Roadmap

This is the roadmap for the fork. It is grouped by area, and each row has a horizon: Now, Next, Later or Ideas. How the roadmap works, and how it connects to designs and plans, is in [`planning/README.md`](planning/README.md).

A row records intent. It is not a product decision and it is not a go-ahead to build. A new control, a changed default or a changed shortcut waits for the maintainer's answer, as `CLAUDE.md` says.

Sources: open issues, [`TODO.md`](TODO.md), tracker issue #25 and the merged PRs of 2026-10-18.

## Areas

| Area                                                                    | Current focus                                            |
| ----------------------------------------------------------------------- | -------------------------------------------------------- |
| [Releases and live validation](#releases-and-live-validation)           | No release since `v2.2.0`. Waiting on time on the Mac    |
| [Sessions and sidebar](#sessions-and-sidebar)                           | Layout options for the phone and the session rows        |
| [Nested subagents](#nested-subagents)                                   | Shipped. One cost bug left                               |
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

Subagents can launch subagents. Asks from any depth reach the root session, and Work Status nests running subagents under the one that started them.

| Title                               | Horizon | Status   | Intent                                                                                                                                                                                    | Links |
| ----------------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Cost rollup survives a parent cycle | Now     | proposed | `computeRollup` counts the wrong subagents and misattributes the root's own cost when the viewed session sits in a parent cycle. `developing-today/opencode#77` is the same class of bug. | #79   |

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
| Timeout caps on every job    | Next    | proposed    | A hung job stops at its cap.                                                                                                            | #67   |
| Anti-slop backlog            | Later   | planned     | 9,498 findings in 1,086 files, worked in three phases from the cheapest.                                                                | #80   |

## Done

| Title                                                    | Date       | Result                |
| -------------------------------------------------------- | ---------- | --------------------- |
| New sidebar layout: attention sections, movable sections | 2026-10-16 | #20                   |
| Worktree start points and branch templates               | 2026-10-16 | #23                   |
| Follow subsessions of subsessions                        | 2026-10-18 | `6247e7e`             |
| Asks from nested subagents reach the root                | 2026-10-18 | #69, flake pin in #75 |
| Next-attention shortcut for sessions drawn project-first | 2026-10-18 | #71                   |
| `browser.type` checks the value landed                   | 2026-10-18 | #70                   |
| Bot workflows skip when their app is not configured      | 2026-10-18 | #62, #66, #74         |
| Concurrency groups per PR, issue or input                | 2026-10-18 | #58, #76, #78         |
| Test isolation fixes for the UI suite                    | 2026-10-18 | #53, #57, #63         |
| Contributing note on isolated test runs                  | 2026-10-18 | #50                   |
