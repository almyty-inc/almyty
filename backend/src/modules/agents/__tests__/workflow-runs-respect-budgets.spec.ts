import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * A spend budget with behavior 'reject' never stopped a workflow agent.
 *
 * BudgetsService.enforceForRun had exactly one non-test caller --
 * agent-runtime.service, gated on `agent.mode === 'autonomous'`. Workflow
 * agents do not go through that path; they reach AgentExecutionEngine.execute
 * from the execution controller, the scheduler, both compat APIs and the
 * sub-agent executor, and none of those consulted a budget.
 *
 * The half that made it hard to see: SpendService counts agent_executions,
 * so a workflow agent's spend DID raise the organization total and could
 * trip an org-wide reject budget for somebody's autonomous run -- while
 * never blocking the workflow run that exhausted it.
 */
const engine = readFileSync(join(__dirname, '..', 'agent-execution.engine.ts'), 'utf8');

describe('workflow runs are subject to spend budgets', () => {
  it('the engine enforces the budget', () => {
    expect(engine).toContain('this.budgets.enforceForRun(organizationId, agent.id)');
  });

  it('enforces before the execution row is created, so a refused run leaves none', () => {
    const enforceAt = engine.indexOf('enforceForRun(organizationId, agent.id)');
    const createAt = engine.indexOf('this.agentExecutionRepository.create({');
    expect(enforceAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(enforceAt).toBeLessThan(createAt);
  });

  it('keeps BudgetsService optional and last in the constructor', () => {
    const ctor = engine.slice(engine.indexOf('constructor('), engine.indexOf(') {}'));
    expect(ctor).toContain('private readonly budgets?: BudgetsService');
    // Positional harnesses construct this class; a dependency added above
    // strategyPipelines shifts it and the engine silently stops running
    // compiled strategies. Last is the only safe place.
    expect(ctor.lastIndexOf('budgets?: BudgetsService')).toBeGreaterThan(
      ctor.lastIndexOf('agentRoles?: AgentRolesService'),
    );
    expect(ctor.lastIndexOf('budgets?: BudgetsService')).toBeGreaterThan(
      ctor.lastIndexOf('strategyPipelines?: StrategyPipelineResolver'),
    );
  });

  it('does not throw when no budgets service is wired, so existing harnesses still run', () => {
    expect(engine).toContain('if (this.budgets) {');
  });
});
