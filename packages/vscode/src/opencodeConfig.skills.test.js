import './opencodeConfigTestHome';
import { describe, expect, test } from 'bun:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BUILT_IN_SKILL_LOCATION,
  getSkillSources,
  listSnippets,
  MD_FILE_MAX_BYTES,
  mergeDiscoveredSkills,
  parseMdFile,
} from './opencodeConfig';

describe('VS Code skill discovery parity', () => {
  test('merges OpenCode API skills with locally discovered fallback skills', () => {
    const merged = mergeDiscoveredSkills(
      [
        { name: 'built-in', path: BUILT_IN_SKILL_LOCATION, scope: 'user', source: 'opencode' },
        { name: 'local-first', path: '/tmp/local-first/SKILL.md', scope: 'user', source: 'agents' },
      ],
      [
        { name: 'local-first', path: '/tmp/local-first/SKILL.md', scope: 'user', source: 'agents' },
        { name: 'local-only', path: '/tmp/local-only/SKILL.md', scope: 'project', source: 'claude' },
      ],
    );

    expect(merged.map((skill) => skill.name)).toEqual(['built-in', 'local-first', 'local-only']);
  });

  test('resolves built-in skills without treating the virtual location as a file', () => {
    const discoveredSkill = {
      name: 'customize-opencode',
      path: BUILT_IN_SKILL_LOCATION,
      scope: 'user',
      source: 'opencode',
      description: 'Customize opencode',
      content: '# Customize opencode\n\nUse for config work.',
    };

    const sources = getSkillSources('customize-opencode', '/tmp/openchamber-vscode-skills-test', discoveredSkill);

    expect(sources.md.exists).toBe(true);
    expect(sources.md.path).toBeNull();
    expect(sources.md.dir).toBeNull();
    expect(sources.md.scope).toBe('user');
    expect(sources.md.source).toBe('opencode');
    expect(sources.md.description).toBe('Customize opencode');
    expect(sources.md.instructions).toBe('# Customize opencode\n\nUse for config work.');
    expect(sources.md.fields).toEqual(['description', 'instructions']);
  });
});
describe('VS Code parseMdFile size gate (#1157)', () => {
  const withTempDir = (run) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-md-cap-'));
    try {
      return run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test('exports a positive named cap of 4 MiB', () => {
    expect(MD_FILE_MAX_BYTES).toBe(4 * 1024 * 1024);
  });

  test('refuses an over-cap file with ERR_MD_FILE_TOO_LARGE without parsing it', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'over-cap.md');
      fs.writeFileSync(file, 'a'.repeat(MD_FILE_MAX_BYTES + 1), 'utf8');

      let thrown;
      try {
        parseMdFile(file);
      } catch (error) {
        thrown = error;
      }

      expect(thrown?.code).toBe('ERR_MD_FILE_TOO_LARGE');
      expect(thrown?.message).toContain(String(MD_FILE_MAX_BYTES));
    });
  });

  test('parses a file exactly at the cap byte-identically', () => {
    withTempDir((dir) => {
      const content = 'a'.repeat(MD_FILE_MAX_BYTES);
      const file = path.join(dir, 'at-cap.md');
      fs.writeFileSync(file, content, 'utf8');
      expect(fs.statSync(file).size).toBe(MD_FILE_MAX_BYTES);

      const parsed = parseMdFile(file);

      expect(parsed.frontmatter).toEqual({});
      expect(parsed.body).toBe(content);
    });
  });

  test('parses ordinary frontmatter and keeps missing-file ENOENT behaviour', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'agent.md');
      fs.writeFileSync(file, '---\nname: demo\n---\n\nhello\n', 'utf8');

      const parsed = parseMdFile(file);
      expect(parsed.frontmatter.name).toBe('demo');
      expect(parsed.body).toBe('hello');

      let thrown;
      try {
        parseMdFile(path.join(dir, 'missing.md'));
      } catch (error) {
        thrown = error;
      }
      expect(thrown?.code).toBe('ENOENT');
    });
  });

  test('snippet discovery skips an over-cap file and keeps loading the rest', () => {
    withTempDir((dir) => {
      const snippetsDir = path.join(dir, '.opencode', 'snippets');
      fs.mkdirSync(snippetsDir, { recursive: true });
      fs.writeFileSync(path.join(snippetsDir, 'bigone.md'), 'a'.repeat(MD_FILE_MAX_BYTES + 1), 'utf8');
      fs.writeFileSync(path.join(snippetsDir, 'tiny.md'), 'hello', 'utf8');

      const snippets = listSnippets(dir);

      expect(snippets.map((snippet) => snippet.name)).toEqual(['tiny']);
      expect(snippets[0].content).toBe('hello');
    });
  });
});
