import { WorkspaceTickProcessor } from './workspace-tick.processor';

/**
 * Flipping a runner OFFLINE and stranding its workspaces are one fact,
 * so they have to commit together. Two separate writes meant a pod that
 * died in between (OOM, eviction, rolling deploy) left the runner
 * OFFLINE with its workspaces ACTIVE, and nothing looked at an OFFLINE
 * runner again — the workspaces stayed active forever and only manual
 * SQL could fix it.
 */
describe('WorkspaceTickProcessor', () => {
  const makeProcessor = (overrides: {
    tick?: any;
    strand?: any;
    sweep?: any;
    transaction?: any;
  } = {}) => {
    const calls: string[] = [];
    const runners = {
      tick: overrides.tick ??
        jest.fn(async (_now: Date, manager?: any) => {
          calls.push(`tick(${manager ? 'in-tx' : 'no-tx'})`);
          return { checked: 1, transitioned: 1, markStrandedFor: ['r-1'] };
        }),
    };
    const workspaces = {
      markStrandedForRunners: overrides.strand ??
        jest.fn(async (_ids: string[], manager?: any) => {
          calls.push(`strand(${manager ? 'in-tx' : 'no-tx'})`);
          return 2;
        }),
      sweepExpired: overrides.sweep ?? jest.fn(async () => { calls.push('sweep'); return []; }),
    };
    const dataSource = {
      transaction: overrides.transaction ??
        jest.fn(async (fn: any) => {
          calls.push('tx-begin');
          const result = await fn({ getRepository: jest.fn() });
          calls.push('tx-commit');
          return result;
        }),
    };
    const processor = new WorkspaceTickProcessor(
      { add: jest.fn() } as any,
      runners as any,
      workspaces as any,
      dataSource as any,
    );
    return { processor, runners, workspaces, dataSource, calls };
  };

  it('runs the runner tick and the stranding fan-out in one transaction', async () => {
    const { processor, calls } = makeProcessor();

    await processor.tick({} as any);

    expect(calls).toEqual(['tx-begin', 'tick(in-tx)', 'strand(in-tx)', 'tx-commit', 'sweep']);
  });

  it('passes the transaction manager to both writes, so neither lands alone', async () => {
    const { processor, runners, workspaces } = makeProcessor();

    await processor.tick({} as any);

    const tickManager = (runners.tick as jest.Mock).mock.calls[0][1];
    const strandManager = (workspaces.markStrandedForRunners as jest.Mock).mock.calls[0][1];
    expect(tickManager).toBeDefined();
    expect(strandManager).toBe(tickManager);
  });

  it('a failed stranding rolls the runner flip back rather than leaving the pair half-done', async () => {
    const { processor, workspaces } = makeProcessor({
      strand: jest.fn(async () => { throw new Error('connection reset'); }),
      transaction: jest.fn(async (fn: any) => fn({ getRepository: jest.fn() })),
    });

    await expect(processor.tick({} as any)).rejects.toThrow('connection reset');
    expect(workspaces.markStrandedForRunners).toHaveBeenCalled();
  });

  it('skips the fan-out when nothing went offline', async () => {
    const { processor, workspaces } = makeProcessor({
      tick: jest.fn(async () => ({ checked: 3, transitioned: 0, markStrandedFor: [] })),
    });

    await processor.tick({} as any);

    expect(workspaces.markStrandedForRunners).not.toHaveBeenCalled();
    expect(workspaces.sweepExpired).toHaveBeenCalled();
  });
});
