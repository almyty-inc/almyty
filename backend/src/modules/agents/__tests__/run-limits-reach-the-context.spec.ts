import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `context.runLimits` was declared on ExecutionContext and read by the loop
 * node's step clamp -- and set by nobody. The engine built its context
 * literal with `input`, `nodes` and `variables` only, so `maxSteps` was
 * always undefined, the clamp always fell through, and a loop node could
 * run as many iterations as its own config asked for regardless of the
 * agent's budget, the organization's ceiling or the operator's env floor.
 *
 * It compiled, and every test passed, because a limit that is never applied
 * looks exactly like a limit that is never exceeded.
 */
const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('the run budget is actually applied', () => {
  it('the engine puts runLimits on the execution context', () => {
    const src = read('agent-execution.engine.ts');
    const literal = src.match(/const context: ExecutionContext = \{[\s\S]*?\};/);
    expect(literal).not.toBeNull();
    expect(literal![0]).toContain('runLimits:');
    expect(literal![0]).toContain('maxSteps');
    expect(literal![0]).toContain('maxToolCalls');
  });

  it('the numbers come from resolveRunLimits, not from a literal', () => {
    const src = read('agent-execution.engine.ts');
    // resolveRunLimits is what applies the env hard ceiling and reconciles
    // the org, agent and request scopes. A hand-rolled number here would
    // silently skip all three.
    expect(src).toContain('resolveRunLimits({ organization, agent })');
  });

  it('the organization ceiling is read, and a failure to read it does not remove it', () => {
    const src = read('agent-execution.engine.ts');
    expect(src).toContain('this.organizationRepository.findOne');
    // The lookup sits in a try/catch that warns and leaves `organization`
    // null; resolveRunLimits still clamps to the env ceiling.
    const block = src.match(/let organization: Organization \| null = null;[\s\S]*?resolveRunLimits/);
    expect(block).not.toBeNull();
    expect(block![0]).toContain('catch');
    expect(block![0]).toContain('warn');
  });

  it('the loop clamp still reads the field the engine now sets', () => {
    const src = read('agent-node-executor.ts');
    expect(src).toContain('context.runLimits?.maxSteps');
  });

  it('ExecutionContext still declares it, so the two ends agree', () => {
    const src = read('agent-template-resolver.ts');
    expect(src).toMatch(/runLimits\?:/);
    expect(src).toContain('maxSteps');
  });
});
