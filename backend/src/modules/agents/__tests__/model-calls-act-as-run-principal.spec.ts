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
import { gatewayPrincipal } from '../../../common/authorization/execution-access.service';

/**
 * A run's model calls act as the run's principal, never as the user on
 * the run row. A run through a team gateway has no user (userId null) and
 * the gateway's team as its scope; the node executor used to hand the
 * LLM path the userId, so such a run was refused its own team's provider
 * and model cards, and a routed or role-named call was planned for nobody.
 */
describe('model calls of a workflow node act as the run principal', () => {
  let executor: AgentNodeExecutor;
  let chat: jest.Mock;
  let providerForModelId: jest.Mock;
  let runPanel: jest.Mock;

  const teamGateway = gatewayPrincipal({
    id: 'gw-payments', organizationId: 'org-1', visibility: 'team', teamId: 'team-payments',
  });
  const context = (): ExecutionContext => ({ input: {}, nodes: {}, variables: {} });
  const options = () => ({
    organizationId: 'org-1',
    userId: undefined,
    principal: teamGateway,
    resolvedRoles: [{ key: 'drafter', modelId: 'card-1', via: 'pinned' }],
  }) as any;

  beforeEach(async () => {
    chat = jest.fn().mockResolvedValue({
      message: { role: 'assistant', content: 'ok' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      cost: 0,
      model: 'gpt-x',
    });
    providerForModelId = jest.fn().mockResolvedValue({ card: { vendorModelId: 'gpt-x' }, provider: { id: 'prov-team' } });
    runPanel = jest.fn().mockResolvedValue({
      verdict: 'pass', passed: true, policy: 'any_fail_blocks', failures: [], passedRules: [], checkers: [], cost: 0, tokens: 0,
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentNodeExecutor,
        AgentTemplateResolver,
        AgentSubAgentExecutors,
        { provide: AgentVerifierHelper, useValue: { runPanel } },
        { provide: ModelRouterService, useValue: { providerForModelId } },
        { provide: LlmProvidersService, useValue: { chat } },
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

  const llmNode = (data: Record<string, any>): AgentPipelineNode =>
    ({ id: 'answer', type: 'llm_call', data: { userPrompt: 'hi', ...data } }) as any;

  it('an llm_call node naming a provider calls it as the gateway principal', async () => {
    await executor.execute(llmNode({ providerId: 'prov-team' }), context(), 'org-1', undefined, options());
    expect(chat).toHaveBeenCalledWith('prov-team', expect.anything(), 'org-1', teamGateway);
  });

  it('an llm_call node naming a role looks the role up, and calls, as the gateway principal', async () => {
    await executor.execute(llmNode({ roleKey: 'drafter' }), context(), 'org-1', undefined, options());
    expect(providerForModelId).toHaveBeenCalledWith('org-1', 'card-1', teamGateway);
    expect(chat).toHaveBeenCalledWith('prov-team', expect.anything(), 'org-1', teamGateway);
  });

  it('a verify node resolves its checker roles and runs its panel as the gateway principal', async () => {
    const node = {
      id: 'check',
      type: 'verify',
      data: { checkers: [{ name: 'v', roleKey: 'drafter' }], target: 'x', spec: 'y' },
    } as any;
    await executor.execute(node, context(), 'org-1', undefined, options());
    expect(providerForModelId).toHaveBeenCalledWith('org-1', 'card-1', teamGateway);
    expect(runPanel).toHaveBeenCalledWith(expect.anything(), 'org-1', teamGateway, undefined);
  });

  it('a run with no principal still calls as its user, as before', async () => {
    await executor.execute(llmNode({ providerId: 'prov-team' }), context(), 'org-1', 'user-1', { organizationId: 'org-1', userId: 'user-1' } as any);
    expect(chat).toHaveBeenCalledWith('prov-team', expect.anything(), 'org-1', 'user-1');
  });
});
