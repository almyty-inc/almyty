jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));
jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { REFUND_TOOL, gatedExecutor } from '../../tools/__tests__/gated-executor.harness';
import { META_TOOL_DEFINITIONS } from '../../tool-discovery/meta-tools';
import { decideToolMode, estimateToolTokens, thresholdTokens, toolModeProblems, toolModeSettings } from '../agent-tool-mode';
import { anthropicText, anthropicTool, runAgent } from './autonomous-harness';

/**
 * Tool mode (docs/design/code-mode.md, part E): how an agent shows the
 * model its tools. `direct` sends every definition; `discover` sends the
 * three meta-tools (plus pinned tools) and the model finds the rest; `auto`
 * picks discover once the definitions pass a share of the model's context
 * window. Decided once per run, so the tools array never changes mid-run.
 */
describe('tool mode: the decision', () => {
  const defs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `tool_${i}`, description: 'x'.repeat(200), parameters: { type: 'object', properties: {} } }));

  it('defaults to auto, 3% of the context window, 4000 tokens without a card', () => {
    expect(toolModeSettings({})).toEqual({ defaultMode: 'auto', thresholdPercent: 3, fallbackTokens: 4000 });
    expect(thresholdTokens(200_000, null, {})).toBe(6000);
    expect(thresholdTokens(null, null, {})).toBe(4000);
  });

  it('takes every number from the environment, and the agent override over both', () => {
    const env = { AGENT_TOOL_MODE_DEFAULT: 'discover', AGENT_TOOL_MODE_THRESHOLD_PERCENT: '10', AGENT_TOOL_MODE_FALLBACK_TOKENS: '900' };
    expect(toolModeSettings(env)).toEqual({ defaultMode: 'discover', thresholdPercent: 10, fallbackTokens: 900 });
    expect(thresholdTokens(100_000, null, env)).toBe(10_000);
    expect(thresholdTokens(null, null, env)).toBe(900);
    expect(thresholdTokens(100_000, 250, env)).toBe(250);
    expect(decideToolMode({ definitions: [], env }).mode).toBe('discover');
  });

  it('auto discovers only above the threshold; direct and discover are kept as set', () => {
    const big = defs(100);
    expect(estimateToolTokens(big)).toBeGreaterThan(4000);
    expect(decideToolMode({ configured: 'auto', definitions: big, env: {} }).mode).toBe('discover');
    expect(decideToolMode({ configured: 'auto', definitions: defs(3), env: {} }).mode).toBe('direct');
    expect(decideToolMode({ configured: 'auto', definitions: big, contextLength: 1_000_000, env: {} }).mode).toBe('direct');
    expect(decideToolMode({ configured: 'direct', definitions: big, env: {} }).mode).toBe('direct');
    expect(decideToolMode({ configured: 'discover', definitions: defs(1), env: {} }).mode).toBe('discover');
    expect(decideToolMode({ configured: 'nonsense', definitions: defs(1), env: {} })).toMatchObject({ configured: 'auto', mode: 'direct' });
  });

  it('names what is wrong with the settings', () => {
    expect(toolModeProblems({ toolMode: 'auto', toolModeThresholdTokens: 5000, pinnedToolIds: ['3f1c2b6e-0d9a-4c4e-9b1a-2f6d8e7c5a10'] })).toEqual([]);
    expect(toolModeProblems({ toolMode: 'everything' })).toEqual(['Tool mode must be direct, discover, code or auto']);
    expect(toolModeProblems({ toolMode: 'code', codeMode: { writes: { destructive: 'sometimes' } } })).toHaveLength(1);
    // auto never picks code (decision 8); code is kept when a person sets it.
    expect(decideToolMode({ configured: 'code', definitions: [], env: {} }).mode).toBe('code');
    expect(toolModeProblems({ toolModeThresholdTokens: 0 })).toHaveLength(1);
    expect(toolModeProblems({ toolModeThresholdTokens: 1.5 })).toHaveLength(1);
    expect(toolModeProblems({ pinnedToolIds: ['crm'] })).toEqual(['Pinned tools must be a list of tool ids']);
  });
});

describe('tool mode: an autonomous run', () => {
  const MODEL = 'claude-sonnet-5';
  const BILLING = {
    id: 'tool-billing',
    organizationId: 'org-1',
    name: 'billing_invoice',
    description: 'Fetch the invoice of an order',
    parameters: { type: 'object', properties: { order: { type: 'string' } } },
  };
  const toolNames = (body: any) => (body.tools ?? []).map((t: any) => t.name);
  // What the tools answered, as the model received it on its next call (after the opening user message).
  const toolResults = (body: any) => JSON.stringify(body.messages.slice(1));

  it('in direct mode the model sees every tool and no meta-tools', async () => {
    const result = await runAgent({
      models: null,
      agent: { agentConfig: { toolMode: 'direct' } },
      streams: { [MODEL]: [anthropicText(MODEL, 50, ['Done.'], 3)] },
    });
    expect(toolNames(result.bodies[0].body)).toContain('crm_lookup');
    expect(toolNames(result.bodies[0].body)).not.toContain('search_tools');
    expect(result.run.workingMemory.toolMode).toMatchObject({ mode: 'direct', configured: 'direct' });
  });

  it('in discover mode it finds a tool, calls it through call_tool, and the tools array never changes', async () => {
    const executeTool = jest.fn(async (_id: string, _params: any) => ({ success: true, data: { account: '4411', eta: 'Monday' }, executionTime: 4 }));
    const result = await runAgent({
      models: null,
      agent: { toolIds: ['tool-crm', 'tool-billing'], agentConfig: { toolMode: 'discover' } },
      tools: [BILLING],
      executeTool,
      streams: {
        [MODEL]: [
          anthropicTool(MODEL, 'search_tools', { query: 'look up an order' }, 60, 10),
          anthropicTool(MODEL, 'get_tool', { name: 'crm_lookup' }, 80, 10),
          anthropicTool(MODEL, 'call_tool', { name: 'crm_lookup', arguments: { account: '4411' } }, 100, 10),
          anthropicText(MODEL, 120, ['It arrives Monday.'], 5),
        ],
      },
    });

    expect(result.run.status).toBe(AgentRunStatus.COMPLETED);
    expect(result.run.output).toContain('It arrives Monday.');

    // The same tools array on every call: the meta-tools and the built-ins, never the agent's own tools.
    const arrays = result.bodies.map((b) => JSON.stringify(b.body.tools));
    expect(new Set(arrays).size).toBe(1);
    const names = toolNames(result.bodies[0].body);
    expect(names.slice(0, 3)).toEqual(META_TOOL_DEFINITIONS.map((d) => d.name));
    expect(names).not.toContain('crm_lookup');
    expect(names).not.toContain('billing_invoice');
    expect(JSON.stringify(result.bodies[0].body.system)).toContain('[FINDING TOOLS]');

    // search_tools ranked the CRM tool first; get_tool showed its arguments.
    const afterSearch = toolResults(result.bodies[1].body);
    expect(afterSearch.indexOf('crm_lookup')).toBeGreaterThan(-1);
    expect(afterSearch.indexOf('crm_lookup')).toBeLessThan(afterSearch.indexOf('billing_invoice') === -1 ? Infinity : afterSearch.indexOf('billing_invoice'));
    expect(toolResults(result.bodies[2].body)).toContain('inputSchema');

    // call_tool ran the real tool, with the inner arguments, once.
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][0]).toBe('tool-crm');
    expect(executeTool.mock.calls[0][1]).toEqual({ account: '4411' });
    expect(result.run.steps.filter((st: any) => st.type === 'tool_call').map((st: any) => st.input.tool)).toEqual([
      'search_tools',
      'get_tool',
      'crm_lookup',
    ]);
  });

  it('call_tool reaches only the tools of this agent', async () => {
    const executeTool = jest.fn();
    const result = await runAgent({
      models: null,
      agent: { agentConfig: { toolMode: 'discover' } },
      tools: [BILLING], // in the organization, not on this agent
      executeTool,
      streams: {
        [MODEL]: [
          anthropicTool(MODEL, 'call_tool', { name: 'billing_invoice', arguments: { order: '4411' } }, 60, 10),
          anthropicText(MODEL, 80, ['I cannot.'], 3),
        ],
      },
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(toolResults(result.bodies[1].body)).toContain("Tool 'billing_invoice' not found");
  });

  it('shows pinned tools in full in discover mode', async () => {
    const result = await runAgent({
      models: null,
      agent: { toolIds: ['tool-crm', 'tool-billing'], agentConfig: { toolMode: 'discover', pinnedToolIds: ['tool-billing'] } },
      tools: [BILLING],
      streams: { [MODEL]: [anthropicText(MODEL, 50, ['Done.'], 3)] },
    });
    const names = toolNames(result.bodies[0].body);
    expect(names).toContain('billing_invoice');
    expect(names).not.toContain('crm_lookup');
  });

  it('auto keeps the first decision for the whole run, even if the threshold would now say otherwise', async () => {
    const result = await runAgent({
      models: null,
      agent: { agentConfig: { toolMode: 'auto', toolModeThresholdTokens: 1 } },
      run: { workingMemory: { toolMode: { mode: 'direct', configured: 'auto', estimatedTokens: 40, thresholdTokens: 4000 } } },
      streams: { [MODEL]: [anthropicText(MODEL, 50, ['Done.'], 3)] },
    });
    expect(toolNames(result.bodies[0].body)).toContain('crm_lookup');
    expect(result.run.workingMemory.toolMode.mode).toBe('direct');
  });

  it('auto discovers when the definitions pass the agent threshold', async () => {
    const result = await runAgent({
      models: null,
      agent: { agentConfig: { toolMode: 'auto', toolModeThresholdTokens: 1 } },
      streams: { [MODEL]: [anthropicText(MODEL, 50, ['Done.'], 3)] },
    });
    expect(toolNames(result.bodies[0].body)).toContain('search_tools');
    expect(result.run.workingMemory.toolMode).toMatchObject({ mode: 'discover', configured: 'auto', thresholdTokens: 1 });
  });
});

describe('tool mode: an approval rule holds a call made through call_tool', () => {
  const mockedAxios = axios as unknown as jest.Mock;
  const MODEL = 'claude-sonnet-5';

  it('asks a person with the inner arguments, then makes exactly that call', async () => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { refunded: true }, headers: {} });
    const access = membershipFixture();
    access.member('org-1', 'u-1');
    const harness = gatedExecutor(access.executionAccess);
    const approvals = {
      create: jest.fn(async (input: any) => harness.approvalRequests.save({ ...input, status: 'pending', principal: undefined })),
    };
    const result = await runAgent({
      models: null,
      agent: { toolIds: ['tool-refund'], agentConfig: { toolMode: 'discover' } },
      tools: [REFUND_TOOL],
      approvals,
      executeTool: jest.fn((toolId: string, params: any, options: any) => harness.executor.executeTool(toolId, params, options)),
      streams: {
        [MODEL]: [
          anthropicTool(MODEL, 'call_tool', { name: 'issue_refund', arguments: { amount: 820, order: 'NW-44120' } }, 120, 20),
          anthropicText(MODEL, 180, ['The refund has been issued.'], 12),
        ],
      },
    });

    expect(mockedAxios).not.toHaveBeenCalled();
    expect(result.run.status).toBe(AgentRunStatus.WAITING_APPROVAL);
    expect(approvals.create.mock.calls[0][0].payload).toMatchObject({ parameters: { amount: 820, order: 'NW-44120' } });

    const [row] = await harness.approvalRequests.find({ where: { runId: 'run-1' } });
    await harness.approvalRequests.update({ id: row.id }, { status: 'approved' });
    await result.runRepository.update({ id: 'run-1' }, { status: AgentRunStatus.RUNNING });
    await result.drive();

    expect(mockedAxios).toHaveBeenCalledTimes(1);
    expect(mockedAxios.mock.calls[0][0]).toMatchObject({ data: expect.objectContaining({ amount: 820, order: 'NW-44120' }) });
    expect(result.runRepository.row('run-1')!.status).toBe(AgentRunStatus.COMPLETED);
  });
});

describe('tool mode: guards', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');

  it('call_tool runs through the same path as a direct call (no executor call site of its own)', () => {
    // The step's own call and the replay of an approved held call; nothing else.
    expect(source.match(/toolExecutorService\.executeTool\(/g) ?? []).toHaveLength(2);
    expect(source).toMatch(/callName = typeof callParams\.name === 'string'/);
    // The approval hold sees the inner arguments, not the call_tool envelope.
    expect(source).toMatch(/holdForApproval\(run, agent, matchingTool, \{ id: toolCall\.id, parameters: callParams \}/);
  });

  it('discovery searches only this run\'s executable tools', () => {
    expect(source).toMatch(/this\.answerDiscovery\(toolCall\.name, callParams, tools, run\.organizationId\)/);
    expect(source).toMatch(/const tools = await this\.s\.executionAccess\.filterExecutable\(/);
  });
});
