/**
 * The draft's "Auto-create worktree" switch: the first prompt of a new session
 * gets its own worktree before the session is created.
 *
 * The composer starts it right before the send and marks the draft with a
 * pending worktree request; draft materialization already waits on that
 * request, so the session is created in the new worktree. Naming is a
 * convenience and never blocks: a failed or empty generated name falls back to
 * the random name Quick worktree uses. A failed creation fails the send, so the
 * prompt returns to the composer instead of running in the project root.
 */

import { z } from 'zod';

import { generateBranchName } from '@/lib/git/branchNameGenerator';
import { normalizePath } from '@/lib/pathNormalization';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { resolveWorktreeSetupCommands } from '@/lib/sharedTrustConfirmation';
import {
  createPendingDraftWorktreeRequest,
  rejectPendingDraftWorktreeRequest,
  resolvePendingDraftWorktreeRequest,
} from '@/lib/worktrees/pendingDraftWorktree';
import { createWorktreeWithDefaults, WorktreeRequiresGitRepositoryError } from '@/lib/worktrees/worktreeCreate';
import type { CreateWorktreeArgs, ProjectRef } from '@/lib/worktrees/worktreeManager';
import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';

/** Long enough for a small model's reply, short enough that a stuck one costs only a pause. */
const NAME_GENERATION_TIMEOUT_MS = 15_000;

type AutoWorktreeTarget =
  | { kind: 'path'; path: string }
  | { kind: 'name'; name: string }
  | { kind: 'generate' };

/** What the optional name field asks for: an exact path, a name, or a name made from the prompt. */
export const parseAutoWorktreeName = (typed: string | undefined): AutoWorktreeTarget => {
  const value = typed?.trim() ?? '';
  if (!value) return { kind: 'generate' };
  if (value.startsWith('/')) return { kind: 'path', path: value };
  return { kind: 'name', name: value };
};

/**
 * A plain name is the branch and the directory under the worktree root, like
 * Quick worktree. An exact path names only the checkout; the server picks the
 * branch from its last segment.
 */
export const toAutoWorktreeCreateArgs = (
  target: Exclude<AutoWorktreeTarget, { kind: 'generate' }>,
): Pick<CreateWorktreeArgs, 'preferredName' | 'branchName' | 'worktreeName'> => (
  target.kind === 'path'
    ? { worktreeName: target.path }
    : { preferredName: target.name, branchName: target.name, worktreeName: target.name }
);

/**
 * The switch applies only to a project draft still aimed at the project root
 * of a git repository: a draft that already targets a worktree (Quick
 * worktree, the New Worktree dialog, a selected worktree) or a space keeps it.
 */
export const shouldAutoCreateDraftWorktree = ({ enabled, draft, projectPath, isGitRepo }: {
  enabled: boolean;
  draft: Pick<NewSessionDraftState, 'open' | 'target' | 'directoryOverride' | 'pendingWorktreeRequestId' | 'bootstrapPendingDirectory'>;
  projectPath: string | null;
  isGitRepo: boolean | null;
}): boolean => {
  if (!enabled || !draft.open || draft.target !== 'project' || isGitRepo !== true) return false;
  if (draft.pendingWorktreeRequestId || draft.bootstrapPendingDirectory) return false;
  const root = normalizePath(projectPath);
  if (!root) return false;
  return (normalizePath(draft.directoryOverride) ?? root) === root;
};

const GeneratedNameResponse = z.object({ name: z.string() });

/** A name made from the prompt by the given model, or '' when none could be made. */
export const generateAutoWorktreeName = async (
  projectDirectory: string,
  prompt: string,
  model: string,
): Promise<string> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAME_GENERATION_TIMEOUT_MS);
  try {
    const response = await runtimeFetch('/api/git/worktrees/generate-name', {
      method: 'POST',
      query: { directory: projectDirectory },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model }),
      signal: controller.signal,
    });
    if (!response.ok) return '';
    const parsed = GeneratedNameResponse.safeParse(await response.json());
    return parsed.success ? parsed.data.name.trim() : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
};

const resolveNamedTarget = async (
  target: AutoWorktreeTarget,
  generate: () => Promise<string>,
): Promise<Exclude<AutoWorktreeTarget, { kind: 'generate' }>> => {
  if (target.kind !== 'generate') return target;
  const generated = await generate();
  return { kind: 'name', name: generated || generateBranchName() };
};

/**
 * Starts the worktree for a draft that is about to send and returns the
 * pending request the draft now waits on. The live draft is marked too, so the
 * target selector shows the worktree being made and cannot be changed under it.
 */
export const startAutoDraftWorktree = ({ project, prompt, model, typedName, fallbackDirectory }: {
  project: ProjectRef;
  prompt: string;
  /** `providerID/modelID` the first prompt is sent with; it also names the worktree. */
  model: string;
  typedName: string | undefined;
  /** Where the draft pointed before, restored when no worktree could be made. */
  fallbackDirectory: string;
}): string => {
  const requestId = createPendingDraftWorktreeRequest();
  useSessionUIStore.getState().setPendingDraftWorktreeRequest(requestId);

  void (async () => {
    try {
      const target = await resolveNamedTarget(
        parseAutoWorktreeName(typedName),
        () => generateAutoWorktreeName(project.path, prompt, model),
      );
      const setupCommands = await resolveWorktreeSetupCommands(project);
      const metadata = await createWorktreeWithDefaults(project, {
        mode: 'new',
        ...toAutoWorktreeCreateArgs(target),
        setupCommands,
        returnAfterDirectoryCreated: true,
      });
      resolvePendingDraftWorktreeRequest(requestId, metadata.path, { keep: true });
    } catch (error) {
      // Not a repository after all: the switch has nothing to do, the session starts where it was aimed.
      if (error instanceof WorktreeRequiresGitRepositoryError) {
        resolvePendingDraftWorktreeRequest(requestId, fallbackDirectory, { keep: true });
        return;
      }
      rejectPendingDraftWorktreeRequest(requestId, error instanceof Error ? error : new Error(String(error)), { keep: true });
      useSessionUIStore.getState().resolvePendingDraftWorktreeTarget(requestId, fallbackDirectory, { preserveDirectoryOverride: false });
    }
  })();

  return requestId;
};
