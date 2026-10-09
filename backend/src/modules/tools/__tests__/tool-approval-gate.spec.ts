import axios from 'axios';

import {
  describeToolAmountRule,
  numericValue,
  paramsHash,
  tripsRule,
} from '../tool-approval-gate.service';
import { AuditAction } from '../../../entities/audit-log.entity';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { userPrincipal } from '../../../common/authorization/execution-access.service';
import { REFUNDS_OVER_500, gatedExecutor } from './gated-executor.harness';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * "Ask before “Refund an order” when amount is over 500": an approval policy's
 * amount rule, enforced by the tool executor itself, so no caller -- an
 * agent's model, a workflow node, a gateway -- can run the call around it.
 */
describe('approval over an amount at the tool call', () => {
  const mockedAxios = axios as unknown as jest.Mock;

  describe('the rule', () => {
    const rule = { argument: 'amount', op: 'gt' as const, amount: 500 };

    it.each([
      [{ amount: 820 }, { value: 820 }],
      [{ amount: '820.50' }, { value: 820.5 }],
      [{ amount: '$1,250' }, { value: 1250 }],
      [{ amount: 500 }, null],
      [{ amount: 120 }, null],
      [{ order: 'NW-1' }, null],
      [{ amount: 'eight hundred' }, { value: null }],
    ])('%j -> %j', (params, expected) => {
      expect(tripsRule(rule, params)).toEqual(expected);
    });

    it('holds a call at the amount only when the rule says "or more"', () => {
      expect(tripsRule({ ...rule, op: 'gte' }, { amount: 500 })).toEqual({ value: 500 });
    });

    it('reads a nested argument', () => {
      expect(tripsRule({ ...rule, argument: 'refund.total' }, { refund: { total: 900 } })).toEqual({ value: 900 });
    });

    it('reads in plain words', () => {
      expect(describeToolAmountRule(REFUNDS_OVER_500.trigger as any)).toBe('Ask before issue_refund when amount is over 500');
      expect(describeToolAmountRule({ ...(REFUNDS_OVER_500.trigger as any), op: 'gte', amount: 1000 })).toBe(
        'Ask before issue_refund when amount is 1,000 or more',
      );
    });

    it('fingerprints parameters regardless of key order', () => {
      expect(paramsHash({ a: 1, b: { c: 2, d: 3 } })).toBe(paramsHash({ b: { d: 3, c: 2 }, a: 1 }));
      expect(paramsHash({ amount: 820 })).not.toBe(paramsHash({ amount: 9000 }));
    });

    it('treats numbers and non-numbers the way a person would', () => {
      expect(numericValue(' 42 ')).toBe(42);
      expect(numericValue('')).toBeNull();
      expect(numericValue(Infinity)).toBeNull();
      expect(numericValue({})).toBeNull();
    });
  });

  describe('the executor', () => {
    let harness: ReturnType<typeof gatedExecutor>;
    const call = (params: Record<string, any>, extra: Record<string, any> = {}) =>
      harness.executor.executeTool('tool-refund', params, {
        organizationId: 'org-1',
        userId: 'u-1',
        principal: userPrincipal('u-1'),
        ...extra,
      });
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    beforeEach(() => {
      mockedAxios.mockReset();
      mockedAxios.mockResolvedValue({ status: 200, data: { refunded: true }, headers: {} });
      const access = membershipFixture();
      access.member('org-1', 'u-1');
      harness = gatedExecutor(access.executionAccess);
    });

    it('runs a call under the amount without asking', async () => {
      const result = await call({ amount: 120, order: 'NW-1' });
      expect(result.success).toBe(true);
      expect(result.approvalRequired).toBeUndefined();
      expect(harness.approvals.created).toHaveLength(0);
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    describe('a caller that cannot wait (a workflow, a gateway or MCP call, the Test button)', () => {
      it('holds the call over the amount: not made, a person is asked, the caller is told it is waiting, and it is audited', async () => {
        const result = await call({ amount: 820, order: 'NW-44120' });
        expect(result.success).toBe(false);
        expect(mockedAxios).not.toHaveBeenCalled();
        expect(harness.approvals.created).toHaveLength(1);
        const [asked] = harness.approvals.created;
        expect(asked).toMatchObject({
          runId: null,
          toolId: 'tool-refund',
          reason: 'Ask before “Refund an order” when amount is over 500. On this call amount is 820.',
          payload: { tool: 'Refund an order', parameters: { amount: 820, order: 'NW-44120' } },
        });
        expect(result).toMatchObject({ approvalId: asked.id, approvalStatus: 'pending' });
        expect(result.error).toBe(
          `Waiting for approval: Ask before “Refund an order” when amount is over 500 (amount is 820). The call was not made yet; it runs once a person approves it in Approvals. Call again with _approvalId "${asked.id}" for the result.`,
        );
        expect(harness.audit.log).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.APPROVAL_GATE,
            resourceId: 'tool-refund',
            status: 'held',
            details: expect.objectContaining({ rule: 'Ask before “Refund an order” when amount is over 500', value: 820 }),
          }),
        );
      });

      it('asks once for the same call made again while it waits', async () => {
        const first = await call({ amount: 820, order: 'NW-44120' });
        const again = await call({ order: 'NW-44120', amount: 820 });
        expect(again.approvalId).toBe(first.approvalId);
        expect(harness.approvals.created).toHaveLength(1);
      });

      it('runs exactly that call once it is approved, once, and gives the caller its result', async () => {
        const held = await call({ amount: 820, order: 'NW-44120' });
        // Still waiting: the caller asking again with the id is told so, and nothing runs.
        const waiting = await call({ amount: 820, order: 'NW-44120', _approvalId: held.approvalId });
        expect(waiting).toMatchObject({ success: false, approvalStatus: 'pending' });
        expect(mockedAxios).not.toHaveBeenCalled();

        await harness.approvals.decide(held.approvalId!, 'approved');
        await settle();
        await settle();
        expect(mockedAxios).toHaveBeenCalledTimes(1);
        expect(mockedAxios.mock.calls[0][0]).toMatchObject({ data: { amount: 820, order: 'NW-44120' } });
        const row = await harness.approvalRequests.findOne({ where: { id: held.approvalId } });
        expect(row.result).toEqual({ success: true, data: { refunded: true }, error: null });

        // The caller collects the result; the refund is not made a second time.
        const collected = await call({ amount: 820, order: 'NW-44120', _approvalId: held.approvalId });
        expect(collected).toMatchObject({ success: true, data: { refunded: true }, approvalId: held.approvalId });
        await harness.gate.runHeld(held.approvalId!, 'org-1');
        expect(mockedAxios).toHaveBeenCalledTimes(1);
      });

      it('gives the caller the refusal when a person rejects it', async () => {
        const held = await call({ amount: 820, order: 'NW-44120' });
        await harness.approvals.decide(held.approvalId!, 'rejected', 'Refund is not due');
        await settle();
        const answer = await call({ amount: 820, order: 'NW-44120', _approvalId: held.approvalId });
        expect(answer).toMatchObject({ success: false, approvalStatus: 'rejected', error: 'Not approved: Refund is not due. The call was not made.' });
        expect(mockedAxios).not.toHaveBeenCalled();
      });

      it("does not let one call's approval id cover a bigger one", async () => {
        const held = await call({ amount: 820 });
        await harness.approvals.decide(held.approvalId!, 'approved');
        await settle();
        mockedAxios.mockClear();
        const bigger = await call({ amount: 9000, _approvalId: held.approvalId });
        expect(bigger).toMatchObject({ success: false, approvalStatus: 'pending' });
        expect(bigger.approvalId).not.toBe(held.approvalId);
        expect(mockedAxios).not.toHaveBeenCalled();
      });
    });

    describe('the autonomous runtime, which pauses and asks itself', () => {
      it('only reports the rule; it raises the request', async () => {
        const result = await call({ amount: 820, order: 'NW-44120' }, { holdForApproval: 'caller' });
        expect(result.error).toBe(
          'Needs approval: Ask before “Refund an order” when amount is over 500 (amount is 820). The call was not made.',
        );
        expect(result.approvalRequired).toMatchObject({ policyId: 'policy-refunds', value: 820, amount: 500 });
        expect(harness.approvals.created).toHaveLength(0);
        expect(mockedAxios).not.toHaveBeenCalled();
      });

      it('runs the call with an approval raised for exactly that call', async () => {
        const held = (await call({ amount: 820, order: 'NW-44120' }, { holdForApproval: 'caller' })).approvalRequired!;
        const approval = await harness.approvalRequests.save({
          organizationId: 'org-1',
          status: 'approved',
          payload: { _gate: { toolId: held.toolId, paramsHash: held.paramsHash, policyId: held.policyId } },
        });
        const result = await call({ order: 'NW-44120', amount: 820 }, { approvedGate: { approvalId: approval.id }, holdForApproval: 'caller' });
        expect(result.success).toBe(true);
        expect(mockedAxios).toHaveBeenCalledTimes(1);
      });

      it('does not run on a pending, rejected or other-organization approval', async () => {
        const held = (await call({ amount: 820 }, { holdForApproval: 'caller' })).approvalRequired!;
        const gate = { toolId: held.toolId, paramsHash: held.paramsHash };
        for (const row of [
          { organizationId: 'org-1', status: 'pending', payload: { _gate: gate } },
          { organizationId: 'org-1', status: 'rejected', payload: { _gate: gate } },
          { organizationId: 'org-2', status: 'approved', payload: { _gate: gate } },
        ]) {
          const approval = await harness.approvalRequests.save(row);
          const result = await call({ amount: 820 }, { approvedGate: { approvalId: approval.id }, holdForApproval: 'caller' });
          expect(result.success).toBe(false);
        }
        expect(mockedAxios).not.toHaveBeenCalled();
      });
    });

    it('ignores a switched-off rule', async () => {
      await harness.policies.update({ id: 'policy-refunds' }, { enabled: false });
      expect((await call({ amount: 820 })).success).toBe(true);
    });

    it("holds another team's agent only when the rule is that team's", async () => {
      await harness.policies.update({ id: 'policy-refunds' }, { teamId: 'team-finance' });
      expect((await call({ amount: 820 }, { agentTeamId: 'team-support' })).success).toBe(true);
      expect((await call({ amount: 820 }, { agentTeamId: 'team-finance' })).success).toBe(false);
      // Nobody to ask about the team: the rule holds the call.
      expect((await call({ amount: 821 })).success).toBe(false);
    });
  });
});
