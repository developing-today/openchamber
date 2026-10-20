import React from 'react';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { loadDesktopSettings } from '@/lib/persistence';

type GoalWriterDefault = { providerID: string; modelID: string; variant: string | null } | null;

/**
 * The Settings writer model and effort, read once when a goal window opens.
 * Null until read, and when Settings name no writer model (the session's own
 * model writes then).
 */
export function useGoalWriterDefault(): GoalWriterDefault {
  const [value, setValue] = React.useState<GoalWriterDefault>(null);
  React.useEffect(() => {
    let alive = true;
    void loadDesktopSettings()
      .then((settings) => {
        const parsed = parseModelIdentifier(settings?.sessionGoalWriterModel?.trim());
        if (!alive || !parsed) return;
        setValue({ providerID: parsed.providerId, modelID: parsed.modelId, variant: settings?.sessionGoalWriterVariant?.trim() || null });
      })
      .catch((error) => console.warn('Failed to load the goal writer model:', error));
    return () => {
      alive = false;
    };
  }, []);
  return value;
}
