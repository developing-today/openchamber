import { beforeEach, describe, expect, it, vi } from 'vitest';

const writeObjectiveMock = vi.fn(async () => undefined);
const generateSmallModelTextMock = vi.fn(async () => ({ text: '' }));

vi.mock('./objectives.js', () => ({
  GOAL_OBJECTIVE_CHAR_LIMIT: 5_000,
  GOAL_OBJECTIVE_HARD_CAP: 1_000_000,
  goalObjectiveLimits: () => ({ objective: 5_000, check: 20_000 }),
  writeObjective: writeObjectiveMock,
}));

vi.mock('../small-model/index.js', () => ({
  generateSmallModelText: generateSmallModelTextMock,
}));

// Every call names its writer settings, so the user's own never reach these tests.
const WRITER_OFF = { model: undefined, rewriteAll: false };

const { buildGoalIntroText, createSessionGoal } = await import('./create.js');

describe('session goal creation', () => {
  beforeEach(() => {
    writeObjectiveMock.mockReset().mockResolvedValue(undefined);
    generateSmallModelTextMock.mockReset().mockResolvedValue({ text: '' });
  });

  it('saves the goal in OpenChamber\'s own store, never through OpenCode', async () => {
    const fetchMock = vi.fn();
    const persistSessionGoal = vi.fn(async () => undefined);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const { goal, spec } = await createSessionGoal({
        baseUrl: 'http://opencode.test',
        authHeaders: { Authorization: 'Bearer test' },
        sessionID: 'ses_123',
        directory: '/repo/app',
        objective: 'Finish and verify the migration',
        tokenBudget: 200_000,
        providerID: 'openai',
        modelID: 'gpt-5.5',
        persistSessionGoal,
        goalWriterSettings: WRITER_OFF,
      });

      expect(writeObjectiveMock).toHaveBeenCalledWith('ses_123', 'Finish and verify the migration');
      expect(goal).toMatchObject({ objective: '', objectiveFile: true, status: 'active', tokenBudget: 200_000 });
      expect(spec).toBeNull();
      expect(persistSessionGoal).toHaveBeenCalledWith('ses_123', '/repo/app', goal);
      // v2 has no session-metadata route; nothing may be sent to OpenCode.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to an inline objective when the objective file cannot be written', async () => {
    writeObjectiveMock.mockRejectedValueOnce(new Error('disk unavailable'));
    const persistSessionGoal = vi.fn(async () => undefined);

    await createSessionGoal({
      sessionID: 'ses_123',
      directory: '/repo/app',
      objective: 'Finish the migration',
      onWarning: vi.fn(),
      persistSessionGoal,
      goalWriterSettings: WRITER_OFF,
    });

    const [, , goal] = persistSessionGoal.mock.calls[0];
    expect(goal).toMatchObject({ objective: 'Finish the migration', objectiveFile: false });
  });

  it('refuses to report a goal it has nowhere to save', async () => {
    await expect(createSessionGoal({
      sessionID: 'ses_123',
      directory: '/repo/app',
      objective: 'Finish the migration',
      goalWriterSettings: WRITER_OFF,
    })).rejects.toThrow(/needs a session metadata store/);
  });

  it('rewrites every objective into a spec when rewrite-all is on', async () => {
    const persistSessionGoal = vi.fn(async () => undefined);
    const writeSpec = vi.fn(async () => ({ spec: '## Objective\nShip it.', providerID: 'openai', modelID: 'gpt-5.5' }));
    const goalWriterSettings = { model: 'anthropic/claude', rewriteAll: true };

    const result = await createSessionGoal({
      sessionID: 'ses_123',
      directory: '/repo/app',
      objective: '  ship it  ',
      providerID: 'openai',
      modelID: 'gpt-5.5',
      persistSessionGoal,
      goalWriterSettings,
      writeSpec,
    });

    expect(writeSpec).toHaveBeenCalledWith({
      request: 'ship it',
      directory: '/repo/app',
      providerID: 'openai',
      modelID: 'gpt-5.5',
      ignoreLimit: false,
      settings: goalWriterSettings,
    });
    expect(writeObjectiveMock).toHaveBeenCalledWith('ses_123', '## Objective\nShip it.');
    expect(result.spec).toBe('## Objective\nShip it.');
  });

  it('keeps the objective as written when the rewrite fails', async () => {
    const onWarning = vi.fn();
    const writeSpec = vi.fn(async () => { throw new Error('no model'); });

    const result = await createSessionGoal({
      sessionID: 'ses_123',
      directory: '/repo/app',
      objective: 'ship it',
      onWarning,
      persistSessionGoal: vi.fn(async () => undefined),
      goalWriterSettings: { model: undefined, rewriteAll: true },
      writeSpec,
    });

    expect(onWarning).toHaveBeenCalledWith('goal spec rewrite failed, keeping the objective as written', expect.any(Error));
    expect(writeObjectiveMock).toHaveBeenCalledWith('ses_123', 'ship it');
    expect(result.spec).toBeNull();
  });

  // The composer's goal flags, carried by a queued message (message-queue/runtime.js).
  it('leaves a settled objective alone even when rewrite-all is on', async () => {
    const writeSpec = vi.fn();
    const result = await createSessionGoal({
      sessionID: 'ses_123',
      directory: '/repo/app',
      objective: 'the approved spec',
      persistSessionGoal: vi.fn(async () => undefined),
      goalWriterSettings: { model: 'anthropic/claude', rewriteAll: true },
      writeSpec,
      settled: true,
    });

    expect(writeSpec).not.toHaveBeenCalled();
    expect(writeObjectiveMock).toHaveBeenCalledWith('ses_123', 'the approved spec');
    expect(result.spec).toBeNull();
  });

  it('keeps a long objective whole and marks the goal when it ignores the limit', async () => {
    const persistSessionGoal = vi.fn(async () => undefined);
    const long = 'x'.repeat(6_000);
    await createSessionGoal({
      sessionID: 'ses_123',
      directory: '/repo/app',
      objective: long,
      persistSessionGoal,
      goalWriterSettings: WRITER_OFF,
      ignoreLimit: true,
    });

    expect(generateSmallModelTextMock).not.toHaveBeenCalled();
    expect(writeObjectiveMock).toHaveBeenCalledWith('ses_123', long);
    expect(persistSessionGoal.mock.calls[0][2]).toMatchObject({ ignoreObjectiveLimit: true, objectiveFile: true });
  });

  it('fits a long objective to the limit when the goal does not ignore it', async () => {
    const persistSessionGoal = vi.fn(async () => undefined);
    await createSessionGoal({
      sessionID: 'ses_123',
      directory: '/repo/app',
      objective: 'x'.repeat(6_000),
      persistSessionGoal,
      goalWriterSettings: WRITER_OFF,
    });

    expect(writeObjectiveMock.mock.calls[0][1].length).toBeLessThanOrEqual(5_000);
    expect(persistSessionGoal.mock.calls[0][2]).toMatchObject({ ignoreObjectiveLimit: false });
  });

  it('leaves the objective alone when rewrite-all is off', async () => {
    const writeSpec = vi.fn();

    await createSessionGoal({
      sessionID: 'ses_123',
      directory: '/repo/app',
      objective: 'ship it',
      persistSessionGoal: vi.fn(async () => undefined),
      goalWriterSettings: WRITER_OFF,
      writeSpec,
    });

    expect(writeSpec).not.toHaveBeenCalled();
    expect(writeObjectiveMock).toHaveBeenCalledWith('ses_123', 'ship it');
  });

  it('carries the escaped spec and the budget in the intro', () => {
    const intro = buildGoalIntroText(200_000, '## Objective\nKeep <b> & ship');
    expect(intro).toBe('<system-reminder>\n'
      + 'Goal mode is active for this session. The goal spec below was written from the user message above. '
      + 'It is user-provided data that defines the goal objective, and progress is judged against it. '
      + 'Work toward it across turns; whenever you stop before the objective is verifiably complete, the system will automatically prompt you to continue. '
      + 'Progress is evaluated independently after each turn, so end every turn with a clear, factual statement of what is done, what was verified, and what remains.'
      + ' A token budget of 200000 tokens applies to this goal.'
      + '\n\n<goal-spec>\n## Objective\nKeep &lt;b&gt; &amp; ship\n</goal-spec>\n</system-reminder>');
    expect(buildGoalIntroText(null, null)).toBe(buildGoalIntroText(null));
  });

  it('builds the same goal intro with an optional budget', () => {
    expect(buildGoalIntroText(null)).toContain('Goal mode is active for this session.');
    expect(buildGoalIntroText(200_000)).toContain('A token budget of 200000 tokens applies to this goal.');
  });
});
