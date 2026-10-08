import axios from 'axios';

import { asksFirst } from '../tool-approval-gate.service';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { userPrincipal } from '../../../common/authorization/execution-access.service';
import { REFUND_TOOL, REFUNDS_OVER_500, gatedExecutor } from './gated-executor.harness';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

const LOOKUP_TOOL = {
  ...REFUND_TOOL,
  id: 'tool-lookup',
  name: 'list_refunds',
  sideEffect: 'read',
  httpConfig: { method: 'GET', path: 'https://billing.example.com/refunds' },
};
const REFUND = { ...REFUND_TOOL, sideEffect: 'write' };

const agentWith = (alwaysOn: Record<string, any>) => ({
  id: 'agent-1',
  organizationId: 'org-1',
  name: 'Support agent',
  alwaysOn: { enabled: true, brief: 'x', wakeOn: {}, report: 'when_acted', ...alwaysOn },
});

/**
 * Always on's "ask first" (docs/always-on.md, "Act or propose"): a run of an
 * always-on agent's standing thread asks a person before a tool that may
 * change something (`propose`), or before the tools on its list (`act`).
 * Enforced by the same gate as amount rules, at the tool call, so no path
 * the run takes to a tool goes around it. Other runs of the agent are not
 * held by it.
 */
describe('ask first, for always-on runs', () => {
  const mockedAxios = axios as unknown as jest.Mock;
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
  });

  function harness(alwaysOn: Record<string, any>, triggerType = 'always_on', policies: any[] = []) {
    const m = membershipFixture();
    m.member('org-1', 'u-1');
    return gatedExecutor(m.executionAccess, {
      policies,
      tools: [REFUND, LOOKUP_TOOL],
      agents: [agentWith(alwaysOn)],
      runs: [{ id: 'run-1', agentId: 'agent-1', organizationId: 'org-1', metadata: { triggerType } }],
    });
  }
  const call = (h: ReturnType<typeof harness>, toolId: string, params: Record<string, any>, extra: Record<string, any> = {}) =>
    h.executor.executeTool(toolId, params, {
      organizationId: 'org-1',
      userId: 'u-1',
      principal: userPrincipal('u-1'),
      runId: 'run-1',
      agentId: 'agent-1',
      holdForApproval: 'caller',
      ...extra,
    });

  it('propose: asks before a tool that may change something, and makes no call', async () => {
    const h = harness({ actMode: 'propose' });
    const result = await call(h, 'tool-refund', { amount: 20 });
    expect(result.success).toBe(false);
    expect(result.approvalRequired).toMatchObject({ kind: 'tool_call', toolId: 'tool-refund', policyId: 'always-on:agent-1' });
    expect(result.error).toContain('it is on the list of things to ask about first');
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('propose: looks things up on its own', async () => {
    const h = harness({ actMode: 'propose' });
    const result = await call(h, 'tool-lookup', {});
    expect(result.success).toBe(true);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });

  it('act: asks only before the tools on its list', async () => {
    const free = harness({ actMode: 'act', askFirstToolIds: [] });
    expect((await call(free, 'tool-refund', { amount: 20 })).success).toBe(true);
    const listed = harness({ actMode: 'act', askFirstToolIds: ['tool-refund'] });
    expect((await call(listed, 'tool-refund', { amount: 20 })).approvalRequired?.kind).toBe('tool_call');
  });

  it('does not hold the agent\'s other runs (a visitor\'s chat, a schedule)', async () => {
    const h = harness({ actMode: 'propose' }, 'scheduled');
    expect((await call(h, 'tool-refund', { amount: 20 })).success).toBe(true);
  });

  it('amount rules still apply in both modes, and say why in their own words', async () => {
    const h = harness({ actMode: 'act', askFirstToolIds: [] }, 'always_on', [REFUNDS_OVER_500]);
    const result = await call(h, 'tool-refund', { amount: 820 });
    expect(result.approvalRequired).toMatchObject({ policyId: 'policy-refunds', value: 820 });
    expect(result.approvalRequired?.kind).not.toBe('tool_call');
  });

  it('runs the call once a person approves exactly that call', async () => {
    const h = harness({ actMode: 'propose' });
    const held = (await call(h, 'tool-refund', { amount: 20 })).approvalRequired!;
    const approval = await h.approvalRequests.save({
      organizationId: 'org-1',
      status: 'approved',
      payload: { _gate: { kind: 'tool_call', toolId: held.toolId, paramsHash: held.paramsHash, policyId: held.policyId } },
    });
    const result = await call(h, 'tool-refund', { amount: 20 }, { approvedGate: { approvalId: approval.id } });
    expect(result.success).toBe(true);
    // An approval for 20 does not cover 9000.
    const bigger = await call(h, 'tool-refund', { amount: 9000 }, { approvedGate: { approvalId: approval.id } });
    expect(bigger.success).toBe(false);
  });

  it('decides by the agent\'s settings', () => {
    expect(asksFirst({ actMode: 'propose' }, { id: 't', sideEffect: 'read' })).toBe(false);
    expect(asksFirst({ actMode: 'propose' }, { id: 't', sideEffect: 'destructive' })).toBe(true);
    expect(asksFirst({ actMode: 'act', askFirstToolIds: ['t'] }, { id: 't', sideEffect: 'read' })).toBe(true);
    expect(asksFirst(null, { id: 't', sideEffect: 'write' })).toBe(false);
  });
});
