import { FindOperator } from 'typeorm';

import { AgentStepProcessor } from '../agent-step-processor';
import { AgentRunStatus } from '../../../entities/agent-run.entity';

/**
 * Cancelling a run has to stick.
 *
 * A worker loads the run at `currentStep: 3, status: running` and then
 * spends seconds to minutes in the model call and the tool executions.
 * The user cancels in that window: `status` becomes CANCELLED, the UI
 * says cancelled and the SSE consumer detaches. The worker then
 * committed step 3 — and because cancel never touches `currentStep`,
 * the compare-and-set still matched: `running` was written back over
 * CANCELLED, the step advanced, step 4 was enqueued, and the run went
 * on spending money nobody was watching.
 */
describe('a cancelled run is not revived by the step it was cancelled during', () => {
  /**
   * Enough FindOperator support to evaluate the CAS predicate for real.
   * `_value` rather than `.value`, because the public getter unwraps a
   * nested operator and would hand back In's array for Not(In(...)).
   */
  const evaluate = (actual: any, op: FindOperator<any>): boolean => {
    const type = (op as any).type;
    const raw = (op as any)._value;
    if (type === 'not') return !(raw instanceof FindOperator ? evaluate(actual, raw) : actual === raw);
    if (type === 'in') return (raw as any[]).includes(actual);
    throw new Error(`unsupported FindOperator "${type}"`);
  };
  const matches = (row: any, where: Record<string, any>): boolean =>
    Object.entries(where).every(([key, expected]) =>
      expected instanceof FindOperator ? evaluate(row[key], expected) : row[key] === expected,
    );

  const harness = (row: Record<string, any>) => {
    const runRepository = {
      findOne: jest.fn(async () => ({ id: row.id, status: row.status })),
      update: jest.fn(async (where: any, patch: Record<string, any>) => {
        if (!matches(row, where)) return { affected: 0 };
        Object.assign(row, patch);
        return { affected: 1 };
      }),
    };
    const processor = new AgentStepProcessor(
      { runRepository, logger: { log: jest.fn(), warn: jest.fn(), debug: jest.fn() } } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { processor, runRepository };
  };

  it('refuses the commit when the row went terminal during the step', async () => {
    // What the DB holds: the user's cancel landed while the step ran.
    const row: Record<string, any> = { id: 'r-1', currentStep: 3, status: AgentRunStatus.CANCELLED, totalCost: 0.2 };
    const { processor } = harness(row);
    // What the worker is holding: loaded before the cancel.
    const run: any = { id: 'r-1', currentStep: 4, status: AgentRunStatus.RUNNING, totalCost: 0.4, totalTokens: 900, steps: [], executionTime: 10 };

    const won = await (processor as any).commitStep(run, 3);

    expect(won).toBe(false);
    expect(row.status).toBe(AgentRunStatus.CANCELLED);
    expect(row.currentStep).toBe(3);
  });

  it('still commits a step of a live run', async () => {
    const row: Record<string, any> = { id: 'r-1', currentStep: 3, status: AgentRunStatus.RUNNING };
    const { processor } = harness(row);
    const run: any = { id: 'r-1', currentStep: 4, status: AgentRunStatus.RUNNING, totalCost: 0.4, totalTokens: 900, steps: [], executionTime: 10 };

    expect(await (processor as any).commitStep(run, 3)).toBe(true);
    expect(row.currentStep).toBe(4);
    expect(row.status).toBe(AgentRunStatus.RUNNING);
  });

  it('abandons the step as soon as the model returns, banking only the cost already spent', async () => {
    const row: Record<string, any> = { id: 'r-1', currentStep: 3, status: AgentRunStatus.CANCELLED, totalCost: 0, totalTokens: 0 };
    const { processor } = harness(row);
    const run: any = { id: 'r-1', currentStep: 3, status: AgentRunStatus.RUNNING, totalCost: 0.4, totalTokens: 900 };

    expect(await (processor as any).abandonIfTerminal(run, 3)).toBe(AgentRunStatus.CANCELLED);
    // The call is paid for, so it is recorded — but nothing else is.
    expect(row.totalCost).toBe(0.4);
    expect(row.totalTokens).toBe(900);
    expect(row.status).toBe(AgentRunStatus.CANCELLED);
    expect(row.currentStep).toBe(3);
  });

  it('lets a live run carry on past the check', async () => {
    const row: Record<string, any> = { id: 'r-1', currentStep: 3, status: AgentRunStatus.RUNNING };
    const { processor } = harness(row);
    const run: any = { id: 'r-1', currentStep: 3, totalCost: 0.4, totalTokens: 900 };

    expect(await (processor as any).abandonIfTerminal(run, 3)).toBeNull();
  });
});
