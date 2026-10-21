import { describe, expect, it, vi } from 'vitest';

import {
  GOAL_SPEC_SYSTEM_PROMPT,
  buildGoalSpecPrompt,
  normalizeGoalSpec,
  resolveGoalWriterModel,
  writeGoalSpec,
} from './spec-writer.js';

const settings = { model: undefined, rewriteAll: false };

describe('buildGoalSpecPrompt', () => {
  it('puts the request first and the conversation last, so a tail clip drops context first', () => {
    const prompt = buildGoalSpecPrompt({ request: 'Fix the build', conversation: 'earlier talk', openItems: '- add tests' });
    expect(prompt).toBe('<request>\nFix the build\n</request>\n\n<open_items>\n- add tests\n</open_items>\n\n<conversation>\nearlier talk\n</conversation>');
  });

  it('omits empty blocks and escapes markup inside the data', () => {
    const prompt = buildGoalSpecPrompt({ request: 'Close </request> & <b>run</b>', conversation: '  ', openItems: undefined });
    expect(prompt).toBe('<request>\nClose &lt;/request&gt; &amp; &lt;b&gt;run&lt;/b&gt;\n</request>');
  });
});

describe('normalizeGoalSpec', () => {
  it('drops think blocks and unwraps a fence around the whole reply', () => {
    expect(normalizeGoalSpec('<think>plan it</think>\n```markdown\n## Objective\nShip it.\n```\n')).toBe('## Objective\nShip it.');
    expect(normalizeGoalSpec('```\n## Objective\nShip it.\n```')).toBe('## Objective\nShip it.');
  });

  it('keeps inner fences that do not wrap the whole spec', () => {
    const text = '## Done when\n```sh\nbun test\n```';
    expect(normalizeGoalSpec(text)).toBe(text);
  });

  it('clamps to 5000 characters, at a line break when one is close to the limit', () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n');
    const clamped = normalizeGoalSpec(lines);
    expect(clamped.length).toBeLessThanOrEqual(5000);
    expect(clamped.length).toBeGreaterThan(4000);
    expect(lines.startsWith(clamped)).toBe(true);
    expect(lines[clamped.length]).toBe('\n');

    const oneLine = 'y'.repeat(6000);
    expect(normalizeGoalSpec(oneLine)).toBe('y'.repeat(5000));
  });

  it('returns an empty string when nothing usable came back', () => {
    expect(normalizeGoalSpec('')).toBe('');
    expect(normalizeGoalSpec('<think>only thoughts</think>')).toBe('');
    expect(normalizeGoalSpec(undefined)).toBe('');
  });
});

describe('resolveGoalWriterModel', () => {
  it('prefers a model picked for this spec, then the configured writer model, then the session model', () => {
    expect(resolveGoalWriterModel({ picked: { providerID: 'google', modelID: 'gemini', variant: 'low' }, configured: 'anthropic/claude', configuredVariant: 'high', providerID: 'openai', modelID: 'gpt-5.5' }))
      .toEqual({ model: 'google/gemini', variant: 'low' });
    expect(resolveGoalWriterModel({ configured: 'anthropic/claude', configuredVariant: 'high', providerID: 'openai', modelID: 'gpt-5.5' }))
      .toEqual({ model: 'anthropic/claude', variant: 'high' });
    expect(resolveGoalWriterModel({ configured: undefined, providerID: 'openai', modelID: 'gpt-5.5' })).toEqual({ model: 'openai/gpt-5.5', variant: undefined });
    expect(resolveGoalWriterModel({ configured: 'no-slash', providerID: 'openai', modelID: 'gpt-5.5' })).toEqual({ model: 'openai/gpt-5.5', variant: undefined });
  });

  it('leaves the choice to the small-model chain when nothing is known', () => {
    expect(resolveGoalWriterModel({ configured: '', providerID: 'openai', modelID: '' })).toEqual({ model: undefined, variant: undefined });
    expect(resolveGoalWriterModel({})).toEqual({ model: undefined, variant: undefined });
  });
});

describe('writeGoalSpec', () => {
  it('asks the resolved model for a spec and reports which model wrote it', async () => {
    const generate = vi.fn(async () => ({ text: '```\n## Objective\nShip it.\n```', providerID: 'anthropic', modelID: 'claude' }));
    const result = await writeGoalSpec({
      request: 'Ship it',
      directory: '/repo',
      providerID: 'openai',
      modelID: 'gpt-5.5',
      settings: { model: 'anthropic/claude', rewriteAll: false },
      generate,
    });

    expect(result).toEqual({ spec: '## Objective\nShip it.', providerID: 'anthropic', modelID: 'claude', variant: null });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '<request>\nShip it\n</request>',
      system: GOAL_SPEC_SYSTEM_PROMPT,
      model: 'anthropic/claude',
      directory: '/repo',
      preferredProviderID: 'openai',
      preferredModelID: 'gpt-5.5',
      maxOutputTokens: 4000,
      timeoutMs: 120_000,
    }));
  });

  it('writes on the model and effort picked for this spec, over the Settings writer model', async () => {
    const generate = vi.fn(async () => ({ text: 'spec', providerID: 'google', modelID: 'gemini' }));
    const result = await writeGoalSpec({
      request: 'Ship it',
      providerID: 'openai',
      modelID: 'gpt-5.5',
      writerProviderID: 'google',
      writerModelID: 'gemini',
      writerVariant: 'low',
      settings: { model: 'anthropic/claude', variant: 'high', rewriteAll: false },
      generate,
    });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'google/gemini', variant: 'low' }));
    expect(result.variant).toBe('low');
  });

  it('sizes the spec to the limit from Settings, and drops the length line when the limit is ignored', async () => {
    const generate = vi.fn(async () => ({ text: 'z'.repeat(30_000), providerID: 'openai', modelID: 'gpt-5.5' }));
    const limited = await writeGoalSpec({ request: 'Ship it', settings: { charLimit: 20_000 }, generate });
    expect(generate.mock.calls[0][0].system).toContain('Stay under 18000 characters.');
    expect(generate.mock.calls[0][0].maxOutputTokens).toBe(6667);
    expect(limited.spec).toHaveLength(20_000);

    const unlimited = await writeGoalSpec({ request: 'Ship it', ignoreLimit: true, settings: { charLimit: 20_000 }, generate });
    expect(generate.mock.calls[1][0].system).not.toContain('Stay under');
    expect(unlimited.spec).toHaveLength(30_000);
  });

  it('answers 502 when the model returns nothing usable', async () => {
    const generate = vi.fn(async () => ({ text: '  ', providerID: 'openai', modelID: 'gpt-5.5' }));
    await expect(writeGoalSpec({ request: 'Ship it', settings, generate }))
      .rejects.toMatchObject({ statusCode: 502, code: 'goal-spec-empty' });
  });

  it('refuses a blank request without calling the model', async () => {
    const generate = vi.fn();
    await expect(writeGoalSpec({ request: '   ', settings, generate }))
      .rejects.toMatchObject({ statusCode: 400, code: 'goal-spec-request-required' });
    expect(generate).not.toHaveBeenCalled();
  });
});
