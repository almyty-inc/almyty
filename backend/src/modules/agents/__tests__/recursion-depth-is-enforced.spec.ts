import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';
import { DEFAULT_RUN_LIMITS, hardCeiling, resolveRunLimits } from '../run-limits';

/**
 * `maxRecursionDepth` was resolved and governed nothing.
 *
 * Two independent nesting ceilings existed, and neither was the resolved
 * one. The workflow engine passed `internalOptions?.maxNestingDepth`, which
 * is undefined for every top-level run, so the sub-agent executor fell
 * through to its own hard-coded `|| 5`. The autonomous runtime capped the
 * parent-run chain at a hard-coded 10. Meanwhile `checkRunLimits` compared
 * `maxRecursionDepth` against `AgentRun.recursionDepth` -- a column with a
 * migration and an entity field that no code ever wrote -- so the
 * comparison was `0 > N` on every run and RECURSION_DEPTH_EXCEEDED was
 * unreachable.
 *
 * Net effect: an operator who set RUN_LIMIT_MAX_RECURSION_DEPTH, and an
 * organization or agent that configured a depth, got the hard-coded number
 * regardless.
 */
const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('sub-agent nesting stops at the resolved depth', () => {
  const helper = Object.create(AgentSubAgentExecutors.prototype) as AgentSubAgentExecutors;
  (helper as any).templateResolver = { resolve: (t: string) => t };

  const runAt = (nestingDepth: number, maxNestingDepth?: number) =>
    helper.executeSubAgentNode(
      { id: 'sub-1', data: { target: { kind: 'native', agentId: 'agent-2' } } } as any,
      { input: {}, nodes: {} } as any,
      { organizationId: 'org-1', nestingDepth, maxNestingDepth } as any,
    );

  it('refuses the call once the run is at its ceiling', async () => {
    await expect(runAt(2, 2)).rejects.toThrow(/Max nesting depth \(2\)/);
  });

  it('still allows the call one level below it', async () => {
    // Loads the sub-agent, which this harness does not stub -- reaching the
    // repository at all proves the depth guard let it through.
    (helper as any).agentRepository = { findOne: async () => null };
    await expect(runAt(1, 2)).rejects.toThrow(/not found/);
  });
});

describe('the workflow engine hands the resolved ceiling to the sub-agent executor', () => {
  const engine = read('agent-execution.engine.ts');

  it('falls back to runLimits.maxRecursionDepth, not to the executor hard-coded 5', () => {
    expect(engine).toContain(
      'maxNestingDepth: internalOptions?.maxNestingDepth ?? runLimits.maxRecursionDepth',
    );
  });

  it('a nested run still inherits the ceiling its parent was given', () => {
    // The ?? keeps the parent's value winning; the sub-agent executor passes
    // maxDepth forward, so the whole tree shares one ceiling.
    expect(engine).toContain('internalOptions?.maxNestingDepth ??');
    expect(read('agent-subagent-executors.helper.ts')).toContain('maxNestingDepth: maxDepth');
  });
});

describe('the autonomous runtime writes the nesting ledger', () => {
  const runtime = read('agent-runtime.service.ts');

  it('persists recursionDepth on the new run, which nothing did before', () => {
    const create = runtime.slice(
      runtime.indexOf('const run = this.runRepository.create({'),
      runtime.indexOf('const savedRun = await this.runRepository.save(run);'),
    );
    expect(create).toContain('recursionDepth,');
  });

  it('the depth written is the ancestor count the chain walk computed', () => {
    expect(runtime).toContain('recursionDepth = depth;');
  });

  it('rejects against the resolved ceiling, not only the hard-coded chain cap', () => {
    expect(runtime).toContain('nestedLimits.maxRecursionDepth');
    expect(runtime).toContain("describeLimitTrip('RECURSION_DEPTH_EXCEEDED')");
  });

  it('rejects before the run row is created, so a refused run leaves none', () => {
    const rejectAt = runtime.indexOf('nestedLimits.maxRecursionDepth');
    const createAt = runtime.indexOf('const run = this.runRepository.create({');
    expect(rejectAt).toBeGreaterThan(-1);
    expect(rejectAt).toBeLessThan(createAt);
  });
});

describe('the resolved ceiling is the one an operator can actually move', () => {
  it('the env key is read and clamps the default', () => {
    const tight = resolveRunLimits({ env: { RUN_LIMIT_MAX_RECURSION_DEPTH: '1' } });
    expect(tight.maxRecursionDepth).toBe(1);
    expect(hardCeiling({ RUN_LIMIT_MAX_RECURSION_DEPTH: '1' }).maxRecursionDepth).toBe(1);
  });

  it('an agent may raise above the default but never above the operator ceiling', () => {
    const agent = { agentConfig: { runLimits: { maxRecursionDepth: 99 } } } as any;
    expect(resolveRunLimits({ agent }).maxRecursionDepth).toBe(
      hardCeiling({}).maxRecursionDepth,
    );
    expect(DEFAULT_RUN_LIMITS.maxRecursionDepth).toBeLessThan(
      hardCeiling({}).maxRecursionDepth,
    );
  });
});
