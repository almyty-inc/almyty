import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { anthropicText, anthropicTool, mainModelConfig, runAgent } from './autonomous-harness';

jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));

/**
 * An autonomous agent's Capabilities section, enforced at run time: the
 * model is offered only what the section allows, and a call to anything
 * else -- a tool, an agent -- is refused with nothing run. Work for the
 * agent's machines goes to a machine with its labels, or nowhere.
 */

const MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p-strong', model: 'claude-sonnet-5' } as const;
const single = { strategy: 'single', roles: [MAIN] } as any;
const tool = (over: Record<string, any>) => ({
  organizationId: 'org-1',
  visibility: 'org',
  status: 'active',
  description: 'x',
  parameters: { type: 'object', properties: {} },
  ...over,
});
const offered = (seen: { bodies: Array<{ body: any }> }) => (seen.bodies[0].body.tools as any[]).map((t) => t.name);

async function run(opts: Omit<Parameters<typeof runAgent>[0], 'models' | 'modelConfig'>) {
  const seen = await runAgent({ models: single, modelConfig: mainModelConfig, ...opts });
  expect(seen.leftover).toEqual({});
  expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
  return seen;
}

describe("an agent's capabilities at run time", () => {
  it('a tool it was not given is refused, and never run', async () => {
    const executeTool = jest.fn();
    const seen = await run({
      agent: { toolIds: ['tool-crm'] },
      tools: [tool({ id: 'tool-refund', name: 'billing_refund' })],
      executeTool,
      streams: {
        'claude-sonnet-5': [
          anthropicTool('claude-sonnet-5', 'billing_refund', { amount: 500 }, 90, 10),
          anthropicText('claude-sonnet-5', 120, ['I cannot do refunds.'], 6),
        ],
      },
    });
    expect(offered(seen)).toContain('crm_lookup');
    expect(offered(seen)).not.toContain('billing_refund');
    expect((seen.run.steps.find((st: any) => st.type === 'tool_call') as any).error).toBe("Tool 'billing_refund' not found");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("an API it was given: every active tool of it, including one added after the agent was saved; no other API's", async () => {
    const executeTool = jest.fn(async () => ({ success: true, data: { status: 'shipped' }, executionTime: 3 }));
    const seen = await run({
      agent: { toolIds: [], agentConfig: { apiIds: ['api-orders'] } },
      tools: [
        tool({ id: 'tool-status', apiId: 'api-orders', name: 'orders_status' }),
        tool({ id: 'tool-draft', apiId: 'api-orders', name: 'orders_cancel', status: 'draft' }),
        tool({ id: 'tool-invoice', apiId: 'api-billing', name: 'billing_invoice' }),
      ],
      executeTool,
      streams: {
        'claude-sonnet-5': [
          anthropicTool('claude-sonnet-5', 'orders_status', { id: '4411' }, 90, 10),
          anthropicText('claude-sonnet-5', 120, ['Shipped.'], 3),
        ],
      },
    });
    expect(offered(seen)).toContain('orders_status');
    expect(offered(seen)).not.toContain('orders_cancel');
    expect(offered(seen)).not.toContain('billing_invoice');
    expect(offered(seen)).not.toContain('crm_lookup');
    expect(executeTool).toHaveBeenCalledWith('tool-status', { id: '4411' }, expect.anything());
  });

  it('only the agents it was given are offered, and a call to another is refused', async () => {
    const other = (id: string, name: string) => ({ id, name, organizationId: 'org-1', status: 'active', isTemporary: false, visibility: 'org', createdBy: 'u-2' });
    const seen = await run({
      agent: { agentConfig: { canCallAgents: true, callableAgentIds: ['agent-billing'] } },
      otherAgents: [other('agent-billing', 'Billing'), other('agent-returns', 'Returns')],
      streams: {
        'claude-sonnet-5': [
          anthropicTool('claude-sonnet-5', 'call_agent_Returns', { input: 'refund 4411' }, 90, 10),
          anthropicText('claude-sonnet-5', 120, ['Returns is not mine to ask.'], 6),
        ],
      },
    });
    expect(offered(seen)).toContain('call_agent_Billing');
    expect(offered(seen)).not.toContain('call_agent_Returns');
    expect((seen.run.steps.find((st: any) => st.type === 'tool_call') as any).error).toBe("Tool 'call_agent_Returns' not found");
    expect(seen.run.steps.some((st: any) => st.type === 'sub_agent_call')).toBe(false);
  });

  it('an empty list offers no agents, whatever the old switch says', async () => {
    const seen = await run({
      agent: { agentConfig: { canCallAgents: true, callableAgentIds: [] } },
      otherAgents: [{ id: 'agent-billing', name: 'Billing', organizationId: 'org-1', status: 'active', isTemporary: false, visibility: 'org', createdBy: 'u-2' }],
      streams: { 'claude-sonnet-5': [anthropicText('claude-sonnet-5', 100, ['Hi.'], 2)] },
    });
    expect(offered(seen).some((n) => n.startsWith('call_agent_'))).toBe(false);
  });

  it('work for its machines goes to a machine with its labels; with none online, the call is refused and says so', async () => {
    const executeTool = jest.fn(async () => ({ success: false, error: 'No machine with gpu=yes is online', executionTime: 1 }));
    const seen = await run({
      agent: { agentConfig: { runnerLabels: { gpu: 'yes' } } },
      executeTool,
      streams: {
        'claude-sonnet-5': [
          anthropicTool('claude-sonnet-5', 'crm_lookup', { account: '4411' }, 90, 10),
          anthropicText('claude-sonnet-5', 120, ['No machine is free.'], 5),
        ],
      },
    });
    expect(executeTool).toHaveBeenCalledWith('tool-crm', { account: '4411' }, expect.objectContaining({ runnerLabels: { gpu: 'yes' } }));
    expect((seen.run.steps.find((st: any) => st.type === 'tool_call') as any).error).toBe('No machine with gpu=yes is online');
  });
});
