import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { applyGoalSpecJobUpdatedEvent, useGoalSpecJobStore } from '@/stores/goalSpecJobStore';

/**
 * Goal writer jobs follow the control stream: every connection of it reads
 * the server's jobs again, since events sent while it was down are lost, and
 * each update applies in revision order.
 */
export const subscribeGoalSpecJobSync = (runtimeKey: string): (() => void) => (
  subscribeOpenchamberEvents((event) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if (event.type === 'event-stream-ready') {
      void useGoalSpecJobStore.getState().resync().catch(() => undefined);
    } else if (event.type === 'openchamber:goal-spec-job.updated') {
      applyGoalSpecJobUpdatedEvent(event, runtimeKey);
    }
  })
);
