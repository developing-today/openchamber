import { describe, expect, it, vi } from 'vitest';

import { generateWorktreeName, sanitizeGeneratedWorktreeName } from './worktree-name.js';

describe('sanitizeGeneratedWorktreeName', () => {
  it('reduces model dressing to one kebab-case slug', () => {
    expect(sanitizeGeneratedWorktreeName('fix-login-redirect')).toBe('fix-login-redirect');
    expect(sanitizeGeneratedWorktreeName('"Fix Login Redirect"')).toBe('fix-login-redirect');
    expect(sanitizeGeneratedWorktreeName('```\nadd-csv-export\n```')).toBe('add-csv-export');
    expect(sanitizeGeneratedWorktreeName('Name: Refactor session store.\nBecause...')).toBe('refactor-session-store');
    expect(sanitizeGeneratedWorktreeName('')).toBe('');
    expect(sanitizeGeneratedWorktreeName(null)).toBe('');
  });

  it('caps length on a word boundary', () => {
    const name = sanitizeGeneratedWorktreeName('one two three four five six seven eight nine ten eleven twelve');
    expect(name.length).toBeLessThanOrEqual(48);
    expect(name.endsWith('-')).toBe(false);
  });
});

describe('generateWorktreeName', () => {
  it('names with the requested model and the prompt', async () => {
    const generateText = vi.fn(async () => ({ text: 'Add CSV export' }));
    await expect(generateWorktreeName({ prompt: 'please add csv export to reports', model: 'anthropic/claude', directory: '/repo', generateText }))
      .resolves.toBe('add-csv-export');
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ model: 'anthropic/claude', directory: '/repo' }));
  });

  it('accepts an object model ref', async () => {
    const generateText = vi.fn(async () => ({ text: 'x-y' }));
    await generateWorktreeName({ prompt: 'p', model: { providerID: 'p1', modelID: 'm1' }, generateText });
    expect(generateText.mock.calls[0][0].model).toBe('p1/m1');
  });

  it('resolves to empty rather than throwing, so callers fall back to a random name', async () => {
    const generateText = vi.fn(async () => { throw new Error('no model'); });
    await expect(generateWorktreeName({ prompt: 'p', generateText })).resolves.toBe('');
    await expect(generateWorktreeName({ prompt: '   ', generateText })).resolves.toBe('');
  });
});
