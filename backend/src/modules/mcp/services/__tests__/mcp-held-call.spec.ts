import { heldCallInputRequired, heldCallRetry } from '../mcp-held-call';
import { openRequestState } from '../../core/mcp-request-state';
import { snapshotEnv } from '../../../../test/env';

/**
 * A held tool call (#886) over 2026-07-28 multi round-trip requests: asked
 * of a person who could approve it in Approvals (owner decision 6), decided
 * on the retry through ApprovalsService, and nobody else's to decide.
 */
const ORG = 'org-1';
const APPROVER = 'user-approver';
const MEMBER = 'user-member';
const V = '2026-07-28';
const elicits = { version: V as any, era: 'modern' as const, clientCapabilities: { elicitation: {} } };
const params = { name: 'issue_refund', arguments: { amount: 820, order: 'NW-10428' } };
const held = { approvalRequired: { rule: 'x' }, approvalStatus: 'pending', approvalId: 'appr-1' };

function approvalsFake(status = 'pending', approvers = [APPROVER], approveTo = 'approved') {
  const row: any = {
    id: 'appr-1',
    organizationId: ORG,
    status,
    reason: 'Ask before issue_refund when amount is over 500. On this call amount is 820.',
    payload: { tool: 'Issue refund', parameters: params.arguments },
  };
  return {
    row,
    findInOrganization: jest.fn(async (id: string, org: string) => (id === row.id && org === ORG ? row : null)),
    canDecide: jest.fn(async (r: any, caller: any) => r.status === 'pending' && approvers.includes(caller?.id)),
    approve: jest.fn(async () => ({ ...row, status: approveTo })),
    reject: jest.fn(async () => ({ ...row, status: 'rejected' })),
  };
}

describe('held tool calls over input_required', () => {
  const restore = snapshotEnv('ENCRYPTION_KEY');
  afterEach(restore);
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'd'.repeat(64);
  });

  describe('after the call was held', () => {
    it('asks an approver on a client that declared elicitation, with a state bound to them and this call', async () => {
      const approvals = approvalsFake();
      const ask: any = await heldCallInputRequired(held, params, elicits, APPROVER, ORG, approvals);
      expect(ask.resultType).toBe('input_required');
      expect(Object.keys(ask.inputRequests)).toEqual(['approval-appr-1']);
      expect(ask.inputRequests['approval-appr-1'].params.message).toContain('amount is 820');
      expect(openRequestState(ask.requestState, { principal: APPROVER, method: 'tools/call', params })).toEqual({
        payload: { kind: 'held_call', data: { approvalId: 'appr-1' } },
      });
    });

    it.each([
      ['a member who could not approve it', MEMBER, elicits, held],
      ['an anonymous caller', null, elicits, held],
      ['a client without elicitation', APPROVER, { ...elicits, clientCapabilities: {} }, held],
      ['a legacy client', APPROVER, { version: '2025-11-25', era: 'legacy' }, held],
      ['a call that was not held', APPROVER, elicits, {}],
      ['a held call already decided', APPROVER, elicits, { ...held, approvalStatus: 'rejected' }],
    ])('keeps the legacy "waiting for approval" answer for %s', async (_label, user, ctx, result) => {
      expect(await heldCallInputRequired(result as any, params, ctx as any, user as any, ORG, approvalsFake())).toBeNull();
    });

    it('keeps it when the approval is another organization\'s', async () => {
      expect(await heldCallInputRequired(held, params, elicits, APPROVER, 'org-2', approvalsFake())).toBeNull();
    });
  });

  describe('on the retry', () => {
    async function asked(approvals = approvalsFake()) {
      const ask: any = await heldCallInputRequired(held, params, elicits, APPROVER, ORG, approvals);
      return { approvals, state: ask.requestState as string };
    }
    const retry = (state: string, inputResponses?: unknown) => ({ ...params, requestState: state, ...(inputResponses !== undefined ? { inputResponses } : {}) });

    it('approves through ApprovalsService and calls again with the approval id', async () => {
      const { approvals, state } = await asked();
      const out = await heldCallRetry(
        retry(state, { 'approval-appr-1': { action: 'accept', content: { decision: 'approve', reason: 'customer verified' } } }),
        elicits, APPROVER, ORG, approvals,
      );
      expect(out).toEqual({ approvalId: 'appr-1', decided: true });
      expect(approvals.approve).toHaveBeenCalledWith('appr-1', { decidedBy: APPROVER, decisionReason: 'customer verified' }, { id: APPROVER }, ORG);
    });

    it('rejects on reject or decline', async () => {
      for (const response of [{ action: 'accept', content: { decision: 'reject' } }, { action: 'decline' }]) {
        const { approvals, state } = await asked();
        expect(await heldCallRetry(retry(state, { 'approval-appr-1': response }), elicits, APPROVER, ORG, approvals)).toEqual({
          approvalId: 'appr-1',
          decided: true,
        });
        expect(approvals.reject).toHaveBeenCalled();
        expect(approvals.approve).not.toHaveBeenCalled();
      }
    });

    it('asks again when the answer is missing or incomplete', async () => {
      for (const responses of [undefined, {}, { 'approval-appr-1': { action: 'accept', content: {} } }]) {
        const { approvals, state } = await asked();
        const out: any = await heldCallRetry(retry(state, responses), elicits, APPROVER, ORG, approvals);
        expect(out.again.resultType).toBe('input_required');
        expect(approvals.approve).not.toHaveBeenCalled();
        expect(approvals.reject).not.toHaveBeenCalled();
      }
    });

    it('stops asking when the person closed the form, leaving the request pending', async () => {
      // A headless client (Claude Code with -p) answers every form with
      // "cancel"; asking again would loop until it gives up.
      const { approvals, state } = await asked();
      const out = await heldCallRetry(retry(state, { 'approval-appr-1': { action: 'cancel' } }), elicits, APPROVER, ORG, approvals);
      expect(out).toEqual({ approvalId: 'appr-1', decided: false });
      expect(approvals.approve).not.toHaveBeenCalled();
      expect(approvals.reject).not.toHaveBeenCalled();
    });

    it('does not ask an approver again once an approval policy waits for others', async () => {
      const { approvals, state } = await asked(approvalsFake('pending', [APPROVER], 'pending'));
      const out = await heldCallRetry(retry(state, { 'approval-appr-1': { action: 'accept', content: { decision: 'approve' } } }), elicits, APPROVER, ORG, approvals);
      expect(out).toEqual({ approvalId: 'appr-1', decided: false });
    });

    it('lets the call report an approval decided meanwhile', async () => {
      const { approvals, state } = await asked();
      approvals.row.status = 'approved';
      expect(await heldCallRetry(retry(state, { 'approval-appr-1': { action: 'accept', content: { decision: 'reject' } } }), elicits, APPROVER, ORG, approvals)).toEqual({
        approvalId: 'appr-1',
        decided: false,
      });
      expect(approvals.reject).not.toHaveBeenCalled();
    });

    it('refuses a state replayed by another user, moved to another call, or tampered with', async () => {
      const { approvals, state } = await asked();
      const decision = { 'approval-appr-1': { action: 'accept', content: { decision: 'approve' } } };
      await expect(heldCallRetry(retry(state, decision), elicits, MEMBER, ORG, approvals)).rejects.toMatchObject({ code: -32602, message: expect.stringContaining('another caller') });
      await expect(
        heldCallRetry({ ...retry(state, decision), arguments: { amount: 10_000, order: 'NW-10428' } }, elicits, APPROVER, ORG, approvals),
      ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining('different request') });
      const raw = Buffer.from(state, 'base64url');
      raw[20] ^= 1;
      await expect(heldCallRetry(retry(raw.toString('base64url'), decision), elicits, APPROVER, ORG, approvals)).rejects.toMatchObject({ code: -32602 });
      expect(approvals.approve).not.toHaveBeenCalled();
    });

    it('refuses a requestState from a legacy request and an inputResponses that is not an object', async () => {
      const { approvals, state } = await asked();
      await expect(heldCallRetry(retry(state), { version: '2025-11-25', era: 'legacy' } as any, APPROVER, ORG, approvals)).rejects.toMatchObject({ code: -32602 });
      await expect(heldCallRetry(retry(state, ['no']), elicits, APPROVER, ORG, approvals)).rejects.toMatchObject({ code: -32602 });
      await expect(heldCallRetry(retry(state, { 'approval-appr-1': 'yes' }), elicits, APPROVER, ORG, approvals)).rejects.toMatchObject({ code: -32602 });
    });

    it('lets ApprovalsService refuse a person whose rights changed since they were asked', async () => {
      const approvals = approvalsFake();
      const { state } = await asked(approvals);
      approvals.canDecide.mockResolvedValue(false);
      const out = await heldCallRetry(retry(state, { 'approval-appr-1': { action: 'accept', content: { decision: 'approve' } } }), elicits, APPROVER, ORG, approvals);
      expect(out).toEqual({ approvalId: 'appr-1', decided: false });
      expect(approvals.approve).not.toHaveBeenCalled();
    });
  });
});
