/**
 * Nothing swept `AgentExecution`.
 *
 * `AgentRunReaperService` has always swept `AgentRun`. The workflow path's
 * row had no equivalent, and every ceiling a workflow run has is enforced
 * from inside `AgentExecutionEngine.execute` — which never runs again once
 * the pod is gone. So a process killed mid-pipeline left its row RUNNING
 * forever: a live run in the UI that nothing would ever finish.
 */
import { AgentExecutionReaperService } from '../agent-execution-reaper.service';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { statusAllowed } from './agent-execution.fixtures';

const STALE_MS = 60 * 60_000;

function row(overrides: Partial<AgentExecution>): AgentExecution {
  const e = new AgentExecution();
  e.id = 'exec-1';
  e.agentId = 'agent-1';
  e.organizationId = 'org-1';
  e.status = AgentExecutionStatus.RUNNING;
  e.createdAt = new Date();
  e.updatedAt = new Date();
  return Object.assign(e, overrides);
}

const longAgo = () => new Date(Date.now() - STALE_MS - 60_000);
const justNow = () => new Date(Date.now() - 1_000);

/** A table that honours `createdAt: LessThan(...)` and the status guard. */
function fakeRepo(rows: AgentExecution[]) {
  return {
    rows,
    find: jest.fn(async ({ where, take }: any) => {
      const statuses: string[] = where.status?.value ?? [where.status];
      const cutoff: Date = where.createdAt?.value;
      return rows
        .filter((r) => statuses.includes(r.status) && (!cutoff || r.createdAt < cutoff))
        .slice(0, take ?? rows.length);
    }),
    update: jest.fn(async (criteria: any, partial: any) => {
      const ids: string[] = criteria.id?.value ?? [criteria.id];
      let affected = 0;
      for (const r of rows) {
        if (!ids.includes(r.id)) continue;
        if (!statusAllowed(r.status, criteria.status)) continue;
        Object.assign(r, partial);
        affected += 1;
      }
      return { affected };
    }),
  };
}

describe('AgentExecutionReaperService', () => {
  it('times out an execution the engine will never finish', async () => {
    const stuck = row({ id: 'stuck', createdAt: longAgo() });
    const repo = fakeRepo([stuck]);
    const reaper = new AgentExecutionReaperService(repo as any);

    expect(await reaper.reapStuckExecutions()).toBe(1);
    expect(stuck.status).toBe(AgentExecutionStatus.TIMEOUT);
    expect(stuck.error).toMatch(/the process running it is gone/);
  });

  it('leaves a run that is still inside the window alone', async () => {
    const live = row({ id: 'live', createdAt: justNow() });
    const repo = fakeRepo([live]);
    const reaper = new AgentExecutionReaperService(repo as any);

    expect(await reaper.reapStuckExecutions()).toBe(0);
    expect(live.status).toBe(AgentExecutionStatus.RUNNING);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('sweeps a row that never left PENDING', async () => {
    const never = row({ id: 'never', status: AgentExecutionStatus.PENDING, createdAt: longAgo() });
    const repo = fakeRepo([never]);
    const reaper = new AgentExecutionReaperService(repo as any);

    expect(await reaper.reapStuckExecutions()).toBe(1);
    expect(never.status).toBe(AgentExecutionStatus.TIMEOUT);
  });

  it('never touches a run that already reached a terminal state', async () => {
    const rows = [
      row({ id: 'done', status: AgentExecutionStatus.COMPLETED, createdAt: longAgo() }),
      row({ id: 'gone', status: AgentExecutionStatus.CANCELLED, createdAt: longAgo() }),
      row({ id: 'bad', status: AgentExecutionStatus.FAILED, createdAt: longAgo() }),
    ];
    const repo = fakeRepo(rows);
    const reaper = new AgentExecutionReaperService(repo as any);

    expect(await reaper.reapStuckExecutions()).toBe(0);
    expect(rows.map((r) => r.status)).toEqual(['completed', 'cancelled', 'failed']);
  });

  it('does not clobber a run that finished between the read and the write', async () => {
    const racing = row({ id: 'racing', createdAt: longAgo() });
    const repo = fakeRepo([racing]);
    // The read sees it RUNNING; by the time the UPDATE lands it has been
    // cancelled. The status guard is what stops the sweep overwriting it.
    repo.find = jest.fn(async () => {
      const seen = Object.assign(new AgentExecution(), racing);
      racing.status = AgentExecutionStatus.CANCELLED;
      return [seen];
    }) as any;
    const reaper = new AgentExecutionReaperService(repo as any);

    expect(await reaper.reapStuckExecutions()).toBe(0);
    expect(racing.status).toBe(AgentExecutionStatus.CANCELLED);
  });

  it('starts and stops its timer without holding the event loop open', () => {
    const reaper = new AgentExecutionReaperService(fakeRepo([]) as any);
    reaper.onModuleInit();
    expect(() => reaper.onModuleDestroy()).not.toThrow();
    // Idempotent: a second destroy after the timer is cleared is fine.
    expect(() => reaper.onModuleDestroy()).not.toThrow();
  });
});
