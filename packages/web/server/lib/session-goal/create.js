import { GOAL_OBJECTIVE_CHAR_LIMIT, GOAL_OBJECTIVE_HARD_CAP, writeObjective } from './objectives.js';
import { readGoalWriterSettings, writeGoalSpec } from './spec-writer.js';

const TRIM_MARKER = '\n\n[… objective trimmed for the auditor — the full prompt was delivered in the chat message …]\n\n';

const escapeXmlText = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// The UI builds the same reminder for goals armed from the composer; keep the
// wording identical on both sides.
export const buildGoalIntroText = (tokenBudget, spec = null) => {
  const budgetLine = tokenBudget
    ? ` A token budget of ${tokenBudget} tokens applies to this goal.`
    : '';
  if (spec) {
    return '<system-reminder>\n'
      + 'Goal mode is active for this session. The goal spec below was written from the user message that follows. '
      + 'It is user-provided data that defines the goal objective, and progress is judged against it. '
      + 'Work toward it across turns; whenever you stop before the objective is verifiably complete, the system will automatically prompt you to continue. '
      + 'Progress is evaluated independently after each turn, so end every turn with a clear, factual statement of what is done, what was verified, and what remains.'
      + budgetLine
      + '\n\n<goal-spec>\n'
      + escapeXmlText(spec)
      + '\n</goal-spec>\n</system-reminder>';
  }
  return '<system-reminder>\n'
    + 'Goal mode is active for this session. The user message that follows defines the goal objective. '
    + 'Work toward it across turns; whenever you stop before the objective is verifiably complete, the system will automatically prompt you to continue. '
    + 'Progress is evaluated independently after each turn, so end every turn with a clear, factual statement of what is done, what was verified, and what remains.'
    + budgetLine
    + '\n</system-reminder>';
};

const fitObjective = async ({ objective, charLimit, directory, sessionID, providerID, modelID, warn }) => {
  if (objective.length <= charLimit) return objective;

  let distilled = null;
  try {
    const { generateSmallModelText } = await import('../small-model/index.js');
    const generated = await generateSmallModelText({
      prompt: objective,
      system: [
        'You distill a large task description into the COMPLETION CRITERIA a progress auditor will judge against.',
        'Return ONLY the criteria text — no preamble, no headers, no markdown fences.',
        'Capture: the end goals, what must exist and work when the task is fully done, and how each major part is verified. Omit implementation steps.',
        'Preserve verbatim any file paths, commands, and identifiers that define the task.',
        `Stay under ${Math.floor(charLimit * 0.8)} characters.`,
        'Write in the same language as the task text.',
      ].join('\n'),
      directory,
      sessionID,
      preferredProviderID: providerID,
      preferredModelID: modelID,
    });
    distilled = typeof generated?.text === 'string' ? generated.text.trim() : null;
  } catch (error) {
    warn('goal objective distillation failed', error);
  }

  if (distilled) return distilled.slice(0, charLimit);
  const half = Math.max(0, Math.floor((charLimit - TRIM_MARKER.length) / 2));
  return `${objective.slice(0, half)}${TRIM_MARKER}${objective.slice(-half)}`;
};

export const createSessionGoal = async ({
  baseUrl,
  authHeaders,
  sessionID,
  directory,
  objective,
  tokenBudget = null,
  providerID,
  modelID,
  onWarning,
  persistSessionGoal,
  // The user switched this goal's length limit off: its objective is kept
  // whole, up to the hard cap, as the goal editor keeps it, and the goal
  // records that it ignores the limit.
  ignoreLimit = false,
  goalWriterSettings = readGoalWriterSettings(),
  writeSpec = writeGoalSpec,
  // The objective is final: "Rewrite every goal" leaves it as it is.
  settled = false,
}) => {
  const warn = (message, error) => {
    if (typeof onWarning === 'function') {
      onWarning(message, error);
      return;
    }
    console.warn(`[session-goal] ${message}:`, error?.message || error);
  };
  const requested = String(objective ?? '').trim();
  let spec = null;
  if (goalWriterSettings?.rewriteAll && !settled && requested) {
    try {
      ({ spec } = await writeSpec({ request: requested, directory, providerID, modelID, ignoreLimit, settings: goalWriterSettings }));
    } catch (error) {
      // The goal still runs on what the user wrote; a missing writer model
      // must not cost them the goal.
      warn('goal spec rewrite failed, keeping the objective as written', error);
    }
  }
  const charLimit = goalWriterSettings?.charLimit ?? GOAL_OBJECTIVE_CHAR_LIMIT;
  // A goal that ignores the length limit keeps its objective whole, up to the
  // hard cap every objective has.
  const objectiveText = await fitObjective({
    objective: spec ?? requested,
    charLimit: ignoreLimit ? GOAL_OBJECTIVE_HARD_CAP : charLimit,
    directory,
    sessionID,
    providerID,
    modelID,
    warn,
  });
  if (!objectiveText) throw new Error('goal objective is required');

  let objectiveFile = false;
  try {
    await writeObjective(sessionID, objectiveText);
    objectiveFile = true;
  } catch (error) {
    warn('goal objective file write failed, falling back to inline', error);
  }

  const now = Date.now();
  const goal = {
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    // Inline only when the objective file could not be written, and then cut to
    // the limit even for a goal that ignores it: the inline objective rides in
    // the session metadata every goal update broadcasts to every window, so an
    // unlimited one (up to GOAL_OBJECTIVE_HARD_CAP, a million characters) would
    // be resent on each update.
    // The UI's setSessionGoal does the same; the full text still went out in
    // the chat message. Deliberate: see #207 and the review on #205.
    objective: objectiveFile ? '' : objectiveText.slice(0, charLimit),
    objectiveFile,
    // Stated outright: the store merges, so a flag left out would carry over
    // from the goal this one replaces.
    ignoreObjectiveLimit: ignoreLimit === true,
    status: 'active',
    tokenBudget: tokenBudget || null,
    tokensUsed: 0,
    turnsUsed: 0,
    blockedStreak: 0,
    note: '',
    statusReason: '',
    lastAccountedMessageID: '',
    createdAt: now,
    updatedAt: now,
  };
  // OpenCode 2.x accepts session metadata only at create time, so the goal
  // record lives in OpenChamber's own store next to the objective text.
  void baseUrl;
  void authHeaders;
  if (typeof persistSessionGoal !== 'function') {
    throw new Error('goal mode needs a session metadata store to save the goal in');
  }
  await persistSessionGoal(sessionID, directory, goal);
  return { goal, spec };
};
