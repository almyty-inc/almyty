import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';
import { AgentTemplateResolver, ExecutionContext } from '../agent-template-resolver';
import { AgentVerifierHelper } from '../agent-verifier.helper';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { A2AClientService } from '../../a2a/a2a-client.service';
import { ExternalAgentsService } from '../../a2a/external-agents.service';
import { ModelRouterService } from '../../model-catalog/routing/model-router.service';
import { Agent, AgentPipelineNode } from '../../../entities/agent.entity';
import { Organization } from '../../../entities/organization.entity';

/**
 * The strategy compiler emits every verify step's checker as
 * `{ name: <slot>, roleKey: <role> }` -- a role, not a provider. But
 * `runChecker` reads only `providerId`, so such a checker returned
 * `verdict: 'error'`, `mergeVerdicts` turned an all-error panel into
 * 'fail', and the run completed reporting a failed check.
 *
 * The visible consequence was that cascade escalated to the expensive role
 * on every single run -- the exact saving the strategy exists to make was
 * never made, and nothing anywhere said so, because a failed check is a
 * legitimate outcome and an escalation is what a failed check is supposed
 * to cause. `executeVerifyNode` now resolves a role-named checker to a
 * provider before the panel sees it, the way callModelForNode already
 * resolved a node's own role.
 */
describe('a verify checker that names a role reaches the panel as a provider', () => {
  let executor: AgentNodeExecutor;
  let runPanel: jest.Mock;
  let providerForModelId: jest.Mock;

  const verifyNode = (checkers: any[]): AgentPipelineNode =>
    ({
      id: 'check',
      type: 'verify',
      data: { checkers, policy: 'any_fail_blocks', target: 'the draft', spec: 'must be true' },
    }) as any;

  const context = (): ExecutionContext => ({ input: {}, nodes: {}, variables: {} });

  const options = (roles?: any[]) =>
    ({ resolvedRoles: roles ?? [{ key: 'role-verifier', modelId: 'card-1', via: 'pinned' }] }) as any;

  beforeEach(async () => {
    runPanel = jest.fn().mockResolvedValue({
      verdict: 'pass',
      passed: true,
      policy: 'any_fail_blocks',
      failures: [],
      passedRules: [],
      checkers: [],
      cost: 0,
      tokens: 0,
    });
    providerForModelId = jest
      .fn()
      .mockResolvedValue({ card: { vendorModelId: 'gpt-x' }, provider: { id: 'prov-9' } });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentNodeExecutor,
        AgentTemplateResolver,
        AgentSubAgentExecutors,
        { provide: AgentVerifierHelper, useValue: { runPanel } },
        { provide: ModelRouterService, useValue: { providerForModelId } },
        { provide: LlmProvidersService, useValue: { chat: jest.fn() } },
        { provide: ToolExecutorService, useValue: { executeTool: jest.fn() } },
        { provide: AgentExecutionEngine, useValue: { execute: jest.fn() } },
        { provide: A2AClientService, useValue: {} },
        { provide: ExternalAgentsService, useValue: {} },
        { provide: getRepositoryToken(Agent), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Organization), useValue: { findOne: jest.fn() } },
      ],
    }).compile();
    executor = module.get(AgentNodeExecutor);
  });

  const checkersSeenByPanel = () => runPanel.mock.calls[0][0].checkers;

  it('resolves the role to a provider before the panel runs', async () => {
    await executor.execute(
      verifyNode([{ name: 'verifier', roleKey: 'role-verifier' }]),
      context(),
      'org-1',
      'user-1',
      options(),
    );
    expect(providerForModelId).toHaveBeenCalledWith('org-1', 'card-1', { id: 'user-1' });
    expect(checkersSeenByPanel()).toEqual([
      { name: 'verifier', roleKey: 'role-verifier', providerId: 'prov-9', model: 'gpt-x' },
    ]);
  });

  it('never hands the panel a checker with neither a provider nor a way to get one', async () => {
    await executor.execute(
      verifyNode([{ name: 'verifier', roleKey: 'role-verifier' }]),
      context(),
      'org-1',
      'user-1',
      options(),
    );
    // This is the assertion that fails on the old code: runChecker reads
    // providerId and nothing else, so a checker arriving without one is
    // the whole bug.
    for (const checker of checkersSeenByPanel()) {
      expect(checker.providerId).toBeTruthy();
    }
  });

  it('leaves a checker that already pins a provider completely alone', async () => {
    await executor.execute(
      verifyNode([{ name: 'v', providerId: 'prov-pinned', model: 'gpt-pinned' }]),
      context(),
      'org-1',
      'user-1',
      options(),
    );
    expect(providerForModelId).not.toHaveBeenCalled();
    expect(checkersSeenByPanel()).toEqual([
      { name: 'v', providerId: 'prov-pinned', model: 'gpt-pinned' },
    ]);
  });

  it("keeps the checker's own model when it names one alongside the role", async () => {
    await executor.execute(
      verifyNode([{ name: 'verifier', roleKey: 'role-verifier', model: 'chosen-by-hand' }]),
      context(),
      'org-1',
      'user-1',
      options(),
    );
    expect(checkersSeenByPanel()[0].model).toBe('chosen-by-hand');
    expect(checkersSeenByPanel()[0].providerId).toBe('prov-9');
  });

  it('resolves each checker in a mixed panel independently', async () => {
    await executor.execute(
      verifyNode([
        { name: 'a', roleKey: 'role-verifier' },
        { name: 'b', providerId: 'prov-pinned' },
      ]),
      context(),
      'org-1',
      'user-1',
      options(),
    );
    const seen = checkersSeenByPanel();
    expect(seen[0].providerId).toBe('prov-9');
    expect(seen[1].providerId).toBe('prov-pinned');
    expect(providerForModelId).toHaveBeenCalledTimes(1);
  });

  it('names the undefined role rather than running a check it cannot perform', async () => {
    await expect(
      executor.execute(
        verifyNode([{ name: 'verifier', roleKey: 'role-nobody-defined' }]),
        context(),
        'org-1',
        'user-1',
        options(),
      ),
    ).rejects.toThrow(/checker naming role 'role-nobody-defined', which this agent does not define/);
    expect(runPanel).not.toHaveBeenCalled();
  });
});
