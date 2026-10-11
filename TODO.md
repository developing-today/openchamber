# TODO

- [ ] Supervisor and listener handoff for upgrades. A small supervisor process owns the managed OpenCode children and the listening socket, so OpenChamber can be upgraded or restarted with no dropped OpenCode sessions and no port change. Today this works through detached OpenCode adoption (`state.json`) and optional socket activation (`LISTEN_FDS`), which still need a systemd `.socket` unit and `KillMode=process`. Open questions: who owns the socket across an OpenChamber version change, how the new process proves it speaks the same OpenCode protocol before taking over, and how a failed handoff rolls back.

- [ ] Versioned state store and explicit handoff protocol for managed OpenCode. `state.json` and `draining.json` are version-1 files with ad-hoc validation, and the handoff is inferred from the state at startup rather than from a recorded protocol step. Replace them with one versioned store that records each OpenCode generation (pid, port, binary, args, fingerprint, state: starting, active, draining, closed) and a write-ahead handoff record (predecessor, successor, busy set at switch, outcome). The store needs a migration path from version 1, a reaper that reads it instead of inferring ownership from `ps`, and tests that replay a crash between each step.

- [ ] Anti-slop lint backlog. `bun run lint:anti-slop` (the vendored oxlint plugin in `tools/oxlint/anti-slop`) reports 9,521 errors in 1,089 files, measured 2026-10-11. The counts come from `oxlint --format json`, grouped by rule code and by `packages/<name>`. `check:changed` only stops changed files from gaining findings, so this number falls only when someone works the backlog.

  Every rule asks for a named domain type, a parse at an I/O boundary, or a stated invariant. Lowering severity, silencing a rule, or adding `SAFETY:` comments that do not state a checked invariant does not fix a finding.

  | Rule | Findings | Fix shape |
  |---|---:|---|
  | `no-runtime-typeof` | 4,801 | Parse at the I/O boundary, then branch on the domain value |
  | `require-safety-comment-for-type-assertion` | 2,355 | Remove the assertion, or state the invariant it relies on |
  | `no-unsafe-dictionary-type` | 630 | Owner or schema-derived value type |
  | `no-unknown-parameters` | 500 | Named domain parameter type |
  | `no-conditional-empty-object-spread` | 489 | Build the object in separate statements |
  | `no-known-value-widening` | 410 | Keep inference, or check with `satisfies` |
  | `no-chained-type-assertions` | 189 | Keep the precise type, or parse before narrowing |
  | `no-unknown-returns` | 80 | Named domain return type |
  | `no-module-mocking` | 36 | Dependency injection through a real interface |
  | `no-shape-in-symbol-names` | 25 | Rename for the domain role |
  | `no-object-parameters` | 6 | Named owner type |
  | **Total** | **9,521** | |

  By package: `packages/ui` 5,298, `packages/web` 2,633, `packages/vscode` 1,290, `packages/electron` 221, `scripts` 40, `packages/sdk` 39. The largest files are `packages/vscode/src/quotaProviders.ts` (242), `packages/web/server/lib/opencode/settings-helpers.js` (208), `packages/vscode/src/opencodeConfig.ts` (183), `packages/ui/src/sync/session-actions.test.ts` (161), and `packages/electron/main.mjs` (121).

  Auto-fix: none. No rule in the plugin defines a fixer, so `oxlint --fix` changes none of these. Each fix needs a type or a decision, so the edits are made by hand, with `check:changed` run after each file.

  Phased plan, cheapest first:
  1. Mechanical and behavior-neutral, about 520 findings: `no-shape-in-symbol-names`, `no-conditional-empty-object-spread`, `no-object-parameters`. Check each rename against its consumers, and keep exports in step with knip.
  2. Owner types at signatures and call sites, about 1,800 findings: `no-unknown-returns`, `no-unknown-parameters`, `no-unsafe-dictionary-type`, `no-chained-type-assertions`, `no-known-value-widening`. Work one module at a time, the stores first.
  3. Boundary parsing and invariants, about 7,200 findings: `no-runtime-typeof`, `require-safety-comment-for-type-assertion`, `no-module-mocking`. Each boundary needs a schema or a written invariant, so this phase needs a design pass before the edits.

  Work the backlog with `bun run deslop -- next-batch`, which claims a batch of files, and `bun run deslop -- release --run <run-id>` when the batch is done.
