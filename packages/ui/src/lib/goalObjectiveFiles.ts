import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const ObjectiveResponseSchema = z.object({ content: z.string() });
// `length` arrived in 2026-10; an older server answers `{ ok: true }` alone.
const WriteResponseSchema = z.object({ length: z.number().int().nonnegative().optional() }).catch({});
// What an OpenChamber server from before the goal length setting keeps of an objective.
const LEGACY_SERVER_OBJECTIVE_LIMIT = 5_000;

// File-backed goal objectives: the text lives in a server-side file keyed by
// the session id (one goal per session; a new goal overwrites the old file).
// The metadata only carries an `objectiveFile: true` flag so it stays light
// for session.updated fanout.

const objectiveUrl = (sessionId: string): string =>
  `/api/goals/objective/${encodeURIComponent(sessionId)}`;

export type GoalObjectiveFileWrite =
  | { saved: false }
  /** `truncated`: the server kept less than was sent, so the goal lost its end. */
  | { saved: true; truncated: boolean };

/** Write the session's objective file. */
export async function writeGoalObjectiveFile(sessionId: string, content: string): Promise<GoalObjectiveFileWrite> {
  try {
    const response = await runtimeFetch(objectiveUrl(sessionId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) return { saved: false };
    const { length } = WriteResponseSchema.parse(await response.json().catch(() => ({})));
    const kept = length ?? Math.min(content.trim().length, LEGACY_SERVER_OBJECTIVE_LIMIT);
    return { saved: true, truncated: kept < content.trim().length };
  } catch {
    return { saved: false };
  }
}

/** Best-effort delete; a failure leaves an orphaned file the next goal overwrites. */
export function deleteGoalObjectiveFile(sessionId: string): void {
  void runtimeFetch(objectiveUrl(sessionId), { method: 'DELETE' }).catch(() => undefined);
}

/** Fetch the file-backed objective text; null when unavailable. */
export async function fetchGoalObjectiveContent(sessionId: string): Promise<string | null> {
  try {
    const response = await runtimeFetch(objectiveUrl(sessionId));
    if (!response.ok) return null;
    const parsed = ObjectiveResponseSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data.content : null;
  } catch {
    return null;
  }
}
