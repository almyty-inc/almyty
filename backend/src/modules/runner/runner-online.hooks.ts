import { Injectable, Logger } from '@nestjs/common';

export type RunnerOnlineListener = (runnerId: string) => void | Promise<void>;

/**
 * Who wants to know the moment a runner comes online: its first heartbeat,
 * or one after it went stale. Hosted runners listen, so a woken machine is
 * marked ready on that heartbeat instead of on the next reconcile sweep
 * (up to a minute later). The runner module only announces; it does not
 * know who listens, which keeps the hosted-runners module (which imports
 * this one) out of its imports.
 *
 * Listeners run after the heartbeat is handled and never hold it up; a
 * listener that throws is logged and the others still run.
 */
@Injectable()
export class RunnerOnlineHooks {
  private readonly logger = new Logger(RunnerOnlineHooks.name);
  private readonly listeners = new Set<RunnerOnlineListener>();

  on(listener: RunnerOnlineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(runnerId: string): void {
    for (const listener of this.listeners) {
      void Promise.resolve()
        .then(() => listener(runnerId))
        .catch((err: any) => this.logger.warn(`runner-online listener failed for ${runnerId}: ${err?.message ?? err}`));
    }
  }
}
