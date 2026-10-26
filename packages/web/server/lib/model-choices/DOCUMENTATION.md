# Model choices

A local history of the models and efforts the user picks by hand, the notes
built from it, and the Settings suggestions those notes support (issue #147).

## What is recorded

One event per manual choice, in `<dataDir>/model-choices.json`:

- `surface`: `goal-writer` (a writer model or effort picked in the goal
  window, recorded when that pick writes a spec: a run of the send-time goal
  writer or a goal edit that rewrites the objective) or `composer` (a pick in
  the main composer's model or effort menu, desktop or mobile; side-chat and
  pinned pickers are not recorded).
- `kind`: `model` when the model changed, `effort` when only the effort did.
- `chosen` and `replaced`, each `{ model: 'provider/model', variant }`.
  For the goal writer `replaced` is the default the window started on (the
  Settings writer model, else the session's model at its default effort); for
  the composer it is the selection the composer showed before the pick.
- `sessionModel`: the session's model.
- `inputSize`: `empty`, `short` (up to 280 characters), `medium` (up to
  2,000), `long`, or `unknown`. The UI computes the bucket; the length and the
  text never leave the window. The composer does not know the draft, so its
  choices are `unknown`.
- `at`: when the server stored it.

Message text is never recorded: the store's schema drops any field it does
not name. The file keeps the newest 5,000 events from the last 90 days;
older ones are dropped on every write and ignored on every read. A missing
file is an empty history. A malformed one is an error (500) and is left in
place, because writing over it would erase it; clearing removes it.

Recording follows `modelChoiceRecordingEnabled` (instance scope, on unless
set to `false`). The server reads it for every choice and records nothing
while it is off; the UI also stops sending. VS Code has no OpenChamber server,
so nothing is recorded there and the Settings controls are hidden.

## Notes and suggestions

`notes.js` builds both deterministically; no model is asked.

- A note is one surface and choice made at least twice: "picks low effort on
  claude-opus for goal specs (7 of 9 times), usually over high effort on
  claude-opus, mostly for long inputs". The replaced selection and the input
  size are named when they cover at least 70 percent of that choice's events.
  A pool shows as `pool <id>`. At most 20 notes, the most frequent first.
- A suggestion is offered only for the goal writer's default model and
  effort (`sessionGoalWriterModel`, `sessionGoalWriterVariant`): among the last
  20 goal-writer events one choice must appear at least 5 times and make up at
  least 70 percent, and differ from the current setting. Once approved or
  declined, a suggestion with that id is never offered again. No suggestion is
  offered while recording is off.

The composer has no suggestion yet: its default lives in `defaultModel`,
which Settings also mirrors into the live composer state, and an approved
change there needs that same handling.

## Who reads it

- `GET /api/openchamber/model-choices` (Settings) and the `models.choices`
  action of the `openchamber` agent tool, which returns `enabled`, `total`,
  `notes` and the most recent events (`limit`, default 50, at most 500). The
  agent action is read only: clearing and the switch stay with the user.
- Settings → Chat → Assistance shows the switch, the number of kept choices
  and Clear history; the goal writer model field shows a suggestion with
  Approve and Decline. Approve has the server write the settings through
  `persistSettings`, then record the answer; a failed write records nothing,
  so the suggestion stays on offer.

## Jev

The notes are not sent to Jev. The routing request
(`../routing/DOCUMENTATION.md`, `jev.js`) asks one choice question whose
`criteria` are the category descriptions, one string per category, and Jev
answers with a category, never a model. A note about which model the user
picks would have to be folded into a category's criteria, where it describes
a model rather than the kind of request, which is what Jev judges. It would
also send the user's model habits to the classification provider, a new
crossing for enterprise mode. Feeding them belongs with a request format that
has a place for user preferences.

## Boundary

Everything stays on this machine: the file is in the data dir, and the agent
reads the notes through the managed tool on the session's own provider.
Enterprise mode gates nothing here.

## Files

- `store.js` — the file, validation, retention, serialized writes.
- `notes.js` — notes and suggestions.
- `service.js` — the recording switch, summaries, answering a suggestion.
- `routes.js` — the HTTP routes.
- `../openchamber-control/model-choice-actions.js` — `models.choices`.
- UI: `packages/ui/src/lib/modelChoices.ts` (sending and reading),
  `ModelChoiceSettings.tsx` (Settings section and the goal writer suggestion).
