import { describe, expect, test } from 'bun:test';
import { resolveNextAttentionEntry } from './nextAttentionSession';
import type { SessionSidebarNavigationEntry } from '../sessionSidebarRowModel';

const entry = (sessionId: string, containerKey: string): SessionSidebarNavigationEntry => ({ sessionId, directory: '/repo', containerKey });

const isAttention = (key: string): boolean => key === 'activity:approvals' || key === 'activity:questions';

// Approvals first, then Questions, then In work; `a1` shows again under its project.
const entries = [
  entry('a1', 'activity:approvals'),
  entry('a2', 'activity:approvals'),
  entry('q1', 'activity:questions'),
  entry('w1', 'activity:work'),
  entry('a1', 'project-a:main'),
];

describe('resolveNextAttentionEntry', () => {
  test('opens the first session needing attention when the open one is elsewhere', () => {
    expect(resolveNextAttentionEntry(entries, 'w1', isAttention)?.sessionId).toBe('a1');
    expect(resolveNextAttentionEntry(entries, null, isAttention)?.sessionId).toBe('a1');
    expect(resolveNextAttentionEntry(entries, 'gone', isAttention)?.sessionId).toBe('a1');
  });

  test('steps to the next attention session in drawn order, skipping duplicates', () => {
    expect(resolveNextAttentionEntry(entries, 'a1', isAttention)?.sessionId).toBe('a2');
    expect(resolveNextAttentionEntry(entries, 'a2', isAttention)?.sessionId).toBe('q1');
  });

  test('wraps around at the end', () => {
    expect(resolveNextAttentionEntry(entries, 'q1', isAttention)?.sessionId).toBe('a1');
  });

  test('returns null when nothing needs attention', () => {
    expect(resolveNextAttentionEntry([entry('w1', 'activity:work')], 'w1', isAttention)).toBeNull();
    expect(resolveNextAttentionEntry([], null, isAttention)).toBeNull();
  });

  test('returns null when the open session is the only one needing attention', () => {
    expect(resolveNextAttentionEntry(entries.slice(0, 1), 'a1', isAttention)).toBeNull();
  });

  test('returns a session whose project entry precedes its attention entry', () => {
    const reordered = [
      entry('a1', 'project-a:main'),
      entry('a1', 'activity:approvals'),
      entry('a2', 'activity:approvals'),
    ];
    expect(resolveNextAttentionEntry(reordered, null, isAttention)?.sessionId).toBe('a1');
    expect(resolveNextAttentionEntry(reordered, 'a1', isAttention)?.sessionId).toBe('a2');
  });

  test('returns the only attention session when its project entry comes first', () => {
    const reordered = [
      entry('a1', 'project-a:main'),
      entry('a1', 'activity:approvals'),
    ];
    expect(resolveNextAttentionEntry(reordered, 'w1', isAttention)?.sessionId).toBe('a1');
    expect(resolveNextAttentionEntry(reordered, 'a1', isAttention)).toBeNull();
  });

  test('steps from the open session at its attention entry position when drawn project-first', () => {
    const reordered = [
      entry('a1', 'project-a:main'),
      entry('a2', 'activity:approvals'),
      entry('a1', 'activity:approvals'),
    ];
    expect(resolveNextAttentionEntry(reordered, 'a2', isAttention)?.sessionId).toBe('a1');
    expect(resolveNextAttentionEntry(reordered, 'a1', isAttention)?.sessionId).toBe('a2');
  });
});
