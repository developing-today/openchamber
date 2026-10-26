import { describe, expect, it, vi } from 'vitest';

import {
  createQuotaCommand,
  resolveOpenCodeBaseUrl,
  buildOpenCodeAuthHeaders,
  formatQuotaResultLines,
  formatQuotaQuietLine,
} from './commands-quota.js';
import { EXIT_CODE } from './cli-errors.js';

const codexResult = {
  providerId: 'codex',
  providerName: 'Codex',
  ok: true,
  configured: true,
  usage: {
    windows: {
      weekly: {
        usedPercent: 7,
        remainingPercent: 93,
        windowSeconds: 604800,
        resetAt: 1793513510000,
        resetAtFormatted: 'Sat, Oct 31, 7:00 PM',
      },
      credits_balance: {
        usedPercent: null,
        remainingPercent: null,
        windowSeconds: null,
        resetAt: null,
        resetAtFormatted: null,
        valueLabel: '0',
      },
    },
  },
  fetchedAt: 1792938209143,
};

const claudeResult = {
  providerId: 'claude',
  providerName: 'Claude',
  ok: false,
  configured: true,
  usage: null,
  error: 'Session expired',
  fetchedAt: 1792938209143,
};

const captureStdout = () => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = vi.fn((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stdout.write = original;
    },
  };
};

const fakeCatalogue = [
  { id: 'codex', name: 'Codex', aliases: ['openai', 'codex', 'chatgpt'], disabled: false },
  { id: 'claude', name: 'Claude', aliases: ['anthropic', 'claude'], disabled: false },
  { id: 'github-copilot', name: 'GitHub Copilot', aliases: ['github-copilot', 'copilot'], disabled: false },
  { id: 'openrouter', name: 'OpenRouter', aliases: ['openrouter'], disabled: true },
];

const createFakeRuntime = ({ configured = [], results = {}, catalogue = fakeCatalogue } = {}) => {
  const calls = { fetch: [], list: [] };
  const runtime = {
    configureOpenCodeCredentials: vi.fn(),
    openCodeCredentialSource: vi.fn((deps) => ({ deps })),
    listQuotaProviderCatalogue: vi.fn(async () => catalogue),
    listConfiguredQuotaProviders: vi.fn(async (options) => {
      calls.list.push(options);
      return configured;
    }),
    fetchQuotaForProviderInstances: vi.fn(async (id) => {
      calls.fetch.push(id);
      const entry = results[id];
      if (Array.isArray(entry)) return entry;
      return [entry ?? {
        providerId: id,
        providerName: id,
        ok: false,
        configured: false,
        usage: null,
        error: 'Unsupported provider',
        fetchedAt: 0,
      }];
    }),
  };
  return { runtime, calls };
};

const codexLegacyResult = {
  ...codexResult,
  credentialId: 'cred_legacy',
  credentialLabel: 'OAuth',
  credentialActive: false,
  accountLabel: 'drewrypope@gmail.com',
};

const codexSharingResult = {
  providerId: 'codex',
  providerName: 'Codex',
  ok: false,
  configured: true,
  usage: null,
  error: 'OpenAI shows usage for Sign in with ChatGPT only at chatgpt.com/settings/usage; this sign-in method has no usage endpoint.',
  fetchedAt: 1792938209143,
  credentialId: 'cred_sharing',
  credentialLabel: 'OpenAI 2',
  credentialActive: true,
};

const createCommand = (runtime, env = {}) => createQuotaCommand({
  loadQuotaRuntime: async () => runtime,
  env,
});

describe('quota endpoint resolution', () => {
  it('uses OPENCODE_HOST and strips trailing slashes', () => {
    expect(resolveOpenCodeBaseUrl({ OPENCODE_HOST: ' http://example.test:1234/ ' })).toBe('http://example.test:1234');
  });

  it('falls back to OPENCODE_PORT on loopback, then the default serve port', () => {
    expect(resolveOpenCodeBaseUrl({ OPENCODE_PORT: '4098' })).toBe('http://127.0.0.1:4098');
    expect(resolveOpenCodeBaseUrl({})).toBe('http://127.0.0.1:4096');
    expect(resolveOpenCodeBaseUrl({ OPENCODE_PORT: 'nope' })).toBe('http://127.0.0.1:4096');
  });

  it('builds the Basic header only when a server password is set', () => {
    expect(buildOpenCodeAuthHeaders({})).toEqual({});
    expect(buildOpenCodeAuthHeaders({ OPENCODE_SERVER_PASSWORD: 'pw' })).toEqual({
      Authorization: `Basic ${Buffer.from('opencode:pw').toString('base64')}`,
    });
  });
});

describe('quota formatting', () => {
  it('formats a successful result with its windows', () => {
    expect(formatQuotaResultLines(codexResult)).toEqual([
      'Codex (codex)',
      '  weekly: 7% used, resets Sat, Oct 31, 7:00 PM',
      '  credits_balance: 0',
    ]);
  });

  it('labels a result with its credential and account', () => {
    expect(formatQuotaResultLines(codexLegacyResult)[0]).toBe('Codex (codex) — OAuth — drewrypope@gmail.com');
    expect(formatQuotaResultLines(codexSharingResult)[0]).toContain('Codex (codex) — OpenAI 2:');
    expect(formatQuotaQuietLine(codexLegacyResult)).toBe('codex/OAuth weekly:7% credits_balance:0');
    expect(formatQuotaQuietLine(codexSharingResult)).toBe('codex/OpenAI-2 error');
  });

  it('formats a failed result as one line with the error', () => {
    expect(formatQuotaResultLines(claudeResult)).toEqual(['Claude (claude): Session expired']);
  });

  it('formats quiet lines as compact tokens', () => {
    expect(formatQuotaQuietLine(codexResult)).toBe('codex weekly:7% credits_balance:0');
    expect(formatQuotaQuietLine(claudeResult)).toBe('claude error');
  });
});

describe('quota command', () => {
  it('wires the credential source with the resolved endpoint before fetching', async () => {
    const { runtime } = createFakeRuntime({ results: { codex: codexResult } });
    const quotaCommand = createCommand(runtime, {
      OPENCODE_HOST: 'http://example.test:1234/',
      OPENCODE_SERVER_PASSWORD: 'pw',
    });
    const out = captureStdout();
    try {
      await quotaCommand({}, 'codex');
    } finally {
      out.restore();
    }

    expect(runtime.openCodeCredentialSource).toHaveBeenCalledTimes(1);
    const deps = runtime.openCodeCredentialSource.mock.calls[0][0];
    expect(deps.buildOpenCodeUrl('')).toBe('http://example.test:1234');
    expect(deps.getOpenCodeAuthHeaders()).toEqual({
      Authorization: `Basic ${Buffer.from('opencode:pw').toString('base64')}`,
    });
    expect(runtime.configureOpenCodeCredentials).toHaveBeenCalledTimes(1);
    expect(out.text()).toContain('weekly: 7% used');
  });

  it('prints every configured provider and keeps a failure inline', async () => {
    const { runtime, calls } = createFakeRuntime({
      configured: ['codex', 'claude'],
      results: { codex: codexResult, claude: claudeResult },
    });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    try {
      await quotaCommand({}, null);
    } finally {
      out.restore();
    }

    expect(calls.fetch).toEqual(['codex', 'claude']);
    expect(out.text()).toContain('Codex (codex)');
    expect(out.text()).toContain('Claude (claude): Session expired');
  });

  it('asks the listing to include disabled providers only with --all', async () => {
    const { runtime, calls } = createFakeRuntime({ configured: [] });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    try {
      await quotaCommand({}, null);
      await quotaCommand({ all: true }, null);
    } finally {
      out.restore();
    }

    expect(calls.list).toEqual([{ includeDisabled: false }, { includeDisabled: true }]);
  });

  it('prints one labeled block per credential of a provider', async () => {
    const { runtime } = createFakeRuntime({
      results: { codex: [codexLegacyResult, codexSharingResult] },
    });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    const previousExitCode = process.exitCode;
    try {
      await quotaCommand({}, 'codex');
      // One credential read fine, so the request as a whole succeeded.
      expect(process.exitCode ?? 0).toBe(previousExitCode ?? 0);
    } finally {
      out.restore();
      process.exitCode = previousExitCode;
    }

    expect(out.text()).toContain('Codex (codex) — OAuth — drewrypope@gmail.com');
    expect(out.text()).toContain('weekly: 7% used');
    expect(out.text()).toContain('Codex (codex) — OpenAI 2:');
  });

  it('prints one quiet line per credential of a provider', async () => {
    const { runtime } = createFakeRuntime({
      results: { codex: [codexLegacyResult, codexSharingResult] },
    });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    try {
      await quotaCommand({ quiet: true }, 'codex');
    } finally {
      out.restore();
    }

    expect(out.text()).toBe('codex/OAuth weekly:7% credits_balance:0\ncodex/OpenAI-2 error\n');
  });

  it('emits JSON only in json mode', async () => {
    const { runtime } = createFakeRuntime({ results: { codex: codexResult } });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    try {
      await quotaCommand({ json: true }, 'codex');
    } finally {
      out.restore();
    }

    const payload = JSON.parse(out.text());
    expect(payload.providers).toEqual([codexResult]);
  });

  it('emits one compact line per provider in quiet mode', async () => {
    const { runtime } = createFakeRuntime({
      configured: ['codex', 'claude'],
      results: { codex: codexResult, claude: claudeResult },
    });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    try {
      await quotaCommand({ quiet: true }, null);
    } finally {
      out.restore();
    }

    expect(out.text()).toBe('codex weekly:7% credits_balance:0\nclaude error\n');
  });

  it('sets a non-zero exit code when the one requested provider fails', async () => {
    const { runtime } = createFakeRuntime({ results: { claude: claudeResult } });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    const previousExitCode = process.exitCode;
    try {
      await quotaCommand({}, 'claude');
      expect(process.exitCode).toBe(EXIT_CODE.GENERAL_ERROR);
      expect(out.text()).toContain('Session expired');
    } finally {
      out.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('rejects an unknown provider as a usage error', async () => {
    const { runtime } = createFakeRuntime();
    const quotaCommand = createCommand(runtime);
    await expect(quotaCommand({}, 'nope')).rejects.toThrow("Unknown quota provider 'nope'.");
  });

  it('prints its own help for the help action without loading the runtime', async () => {
    const loadQuotaRuntime = vi.fn(async () => {
      throw new Error('should not load');
    });
    const quotaCommand = createQuotaCommand({ loadQuotaRuntime, env: {} });
    const out = captureStdout();
    try {
      await quotaCommand({}, 'help');
    } finally {
      out.restore();
    }
    expect(loadQuotaRuntime).not.toHaveBeenCalled();
    expect(out.text()).toContain('openchamber quota [PROVIDER');
  });
});

describe('quota provider arguments', () => {
  const openrouterResult = {
    providerId: 'openrouter',
    providerName: 'OpenRouter',
    ok: true,
    configured: true,
    usage: { windows: { monthly: { usedPercent: 100, resetAtFormatted: 'Sat, Oct 31, 7:00 PM' } } },
    fetchedAt: 0,
  };
  const copilotResult = {
    providerId: 'github-copilot',
    providerName: 'GitHub Copilot',
    ok: true,
    configured: true,
    usage: { windows: { premium_interactions: { valueLabel: 'Unlimited' } } },
    fetchedAt: 0,
  };

  const runCommand = async (runtime, options, args) => {
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    const previousExitCode = process.exitCode;
    try {
      await quotaCommand(options, args);
      return { text: out.text(), exitCode: process.exitCode ?? 0 };
    } finally {
      out.restore();
      process.exitCode = previousExitCode;
    }
  };

  it('fetches several providers in argument order', async () => {
    const { runtime, calls } = createFakeRuntime({
      results: { codex: codexResult, claude: claudeResult },
    });
    const { text, exitCode } = await runCommand(runtime, {}, ['claude', 'codex']);
    expect(calls.fetch).toEqual(['claude', 'codex']);
    expect(text.indexOf('Claude (claude)')).toBeLessThan(text.indexOf('Codex (codex)'));
    // Claude returned no successful result, so the run reports failure.
    expect(exitCode).toBe(EXIT_CODE.GENERAL_ERROR);
  });

  it('resolves display names and credential aliases, ignoring case', async () => {
    const { runtime, calls } = createFakeRuntime({
      results: { codex: codexResult, 'github-copilot': copilotResult },
    });
    await runCommand(runtime, {}, ['CHATGPT']);
    await runCommand(runtime, {}, ['GitHub Copilot']);
    expect(calls.fetch).toEqual(['codex', 'github-copilot']);
  });

  it('fetches a provider once when several arguments name it', async () => {
    const { runtime, calls } = createFakeRuntime({ results: { codex: codexResult } });
    await runCommand(runtime, {}, ['codex', 'chatgpt', 'Codex']);
    expect(calls.fetch).toEqual(['codex']);
  });

  it('fetches a turned off provider that is named exactly', async () => {
    const { runtime, calls } = createFakeRuntime({
      configured: [],
      results: { openrouter: openrouterResult },
    });
    const { text } = await runCommand(runtime, {}, ['openrouter']);
    expect(calls.fetch).toEqual(['openrouter']);
    expect(text).toContain('OpenRouter (openrouter)');
  });

  it('expands a wildcard over configured providers, leaving out turned off ones', async () => {
    const { runtime, calls } = createFakeRuntime({
      configured: ['codex', 'claude', 'openrouter'],
      results: { codex: codexResult, claude: claudeResult, openrouter: openrouterResult },
    });
    await runCommand(runtime, {}, ['*']);
    expect(calls.fetch).toEqual(['codex', 'claude']);
  });

  it('includes turned off providers in a wildcard expansion only with --all', async () => {
    const { runtime, calls } = createFakeRuntime({
      configured: ['codex', 'claude', 'openrouter'],
      results: { codex: codexResult, claude: claudeResult, openrouter: openrouterResult },
    });
    await runCommand(runtime, { all: true }, ['*']);
    expect(calls.fetch).toEqual(['codex', 'claude', 'openrouter']);
  });

  it('rejects a wildcard that matches only a turned off provider', async () => {
    const { runtime, calls } = createFakeRuntime({
      configured: ['openrouter'],
      results: { openrouter: openrouterResult },
    });
    const quotaCommand = createCommand(runtime);
    await expect(quotaCommand({}, ['open*'])).rejects.toThrow("No configured quota provider matches 'open*'.");
    expect(calls.fetch).toEqual([]);
  });

  it('rejects a wildcard that matches no configured provider', async () => {
    const { runtime, calls } = createFakeRuntime({ configured: ['codex'], results: { codex: codexResult } });
    const quotaCommand = createCommand(runtime);
    await expect(quotaCommand({}, ['git*'])).rejects.toThrow("No configured quota provider matches 'git*'.");
    expect(calls.fetch).toEqual([]);
  });

  it('rejects an unknown argument before fetching anything', async () => {
    const { runtime, calls } = createFakeRuntime({ results: { codex: codexResult } });
    const quotaCommand = createCommand(runtime);
    await expect(quotaCommand({}, ['codex', 'nope'])).rejects.toThrow("Unknown quota provider 'nope'.");
    expect(calls.fetch).toEqual([]);
  });

  it('keeps the json shape a flat list in argument order', async () => {
    const { runtime } = createFakeRuntime({
      results: { codex: codexResult, 'github-copilot': copilotResult },
    });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    try {
      await quotaCommand({ json: true }, ['copilot', 'codex']);
    } finally {
      out.restore();
    }
    const payload = JSON.parse(out.text());
    expect(payload.providers.map((entry) => entry.providerId)).toEqual(['github-copilot', 'codex']);
  });
});
