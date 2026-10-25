import { afterEach, describe, expect, it } from 'vitest';

import { parseArgs } from './cli-args.js';
import { INJECTED_ENV_KEY, assignInjectedEnv } from '../../server/lib/injected-env.js';

describe('parseArgs ui password default', () => {
  const previous = {
    OPENCHAMBER_UI_PASSWORD: process.env.OPENCHAMBER_UI_PASSWORD,
    [INJECTED_ENV_KEY]: process.env[INJECTED_ENV_KEY],
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('takes a password the user exported', () => {
    delete process.env[INJECTED_ENV_KEY];
    process.env.OPENCHAMBER_UI_PASSWORD = 'theirs';

    expect(parseArgs(['serve']).options.uiPassword).toBe('theirs');
  });

  it('rejects malformed --lines and --limit values instead of reinterpreting them', () => {
    for (const bad of ['10junk', '1e3', '10.9', 'abc', '-5', '0']) {
      expect(() => parseArgs(['logs', '--lines', bad])).toThrow(/Invalid lines value/);
      expect(() => parseArgs(['status', '--limit', bad])).toThrow(/Invalid limit value/);
    }
    expect(parseArgs(['logs', '--lines', '50']).options.lines).toBe(50);
    expect(parseArgs(['logs', '--lines', '007']).options.lines).toBe(7);
    expect(parseArgs(['status', '--limit', '25']).options.limit).toBe(25);
  });

  it('ignores a password OpenChamber put into the shell', () => {
    delete process.env[INJECTED_ENV_KEY];
    delete process.env.OPENCHAMBER_UI_PASSWORD;
    assignInjectedEnv(process.env, { OPENCHAMBER_UI_PASSWORD: 'the-desktop-apps' });

    expect(parseArgs(['serve']).options.uiPassword).toBeUndefined();
    expect(parseArgs(['serve', '--ui-password', 'chosen']).options.uiPassword).toBe('chosen');
  });
});
