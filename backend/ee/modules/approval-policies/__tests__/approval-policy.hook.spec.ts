import { NotFoundException } from '@nestjs/common';
import { ApprovalPolicyHookImpl } from '../approval-policy.hook';

/**
 * EE (approval_policy): the hook bound to APPROVAL_POLICY_HOOK bridges the
 * core ApprovalsService to the policy engine. Unlicensed → both methods
 * return null so the core keeps its OSS single-gate flow. A policy deleted
 * after resolution also scores null (single gate), never a lockout.
 */
describe('ApprovalPolicyHookImpl', () => {
  const policy: any = { id: 'pol-1', name: 'finance dual-control', steps: [] };
  const progress: any = { policyId: 'pol-1', satisfied: false, currentStep: 0 };

  function make(entitled: boolean) {
    const service = {
      resolveForContext: jest.fn(async () => policy),
      get: jest.fn(async () => policy),
      scoreProgress: jest.fn(() => progress),
    };
    const license = { has: jest.fn((f: string) => entitled && f === 'approval_policy') };
    const hook = new ApprovalPolicyHookImpl(service as any, license as any);
    return { hook, service, license };
  }

  describe('resolveForContext', () => {
    it('returns a policy reference when entitled and a policy matches', async () => {
      const { hook, service } = make(true);

      const ref = await hook.resolveForContext('org-1', { reason: 'x' });

      expect(service.resolveForContext).toHaveBeenCalledWith('org-1', { reason: 'x' });
      expect(ref).toEqual({ id: 'pol-1', name: 'finance dual-control' });
    });

    it('returns null when no policy matches', async () => {
      const { hook, service } = make(true);
      service.resolveForContext.mockResolvedValue(null as any);

      expect(await hook.resolveForContext('org-1', {})).toBeNull();
    });

    it('returns null without the approval_policy entitlement', async () => {
      const { hook, service } = make(false);

      expect(await hook.resolveForContext('org-1', {})).toBeNull();
      expect(service.resolveForContext).not.toHaveBeenCalled();
    });
  });

  describe('scoreProgress', () => {
    const approvals = [{ approverId: 'u1', roles: ['admin'] }];

    it('loads the policy and delegates scoring when entitled', async () => {
      const { hook, service } = make(true);

      const result = await hook.scoreProgress('org-1', 'pol-1', approvals);

      expect(service.get).toHaveBeenCalledWith('org-1', 'pol-1');
      expect(service.scoreProgress).toHaveBeenCalledWith(policy, approvals);
      expect(result).toBe(progress);
    });

    it('returns null when the policy no longer exists', async () => {
      const { hook, service } = make(true);
      service.get.mockRejectedValue(new NotFoundException('approval policy not found'));

      expect(await hook.scoreProgress('org-1', 'pol-1', approvals)).toBeNull();
    });

    it('returns null without the approval_policy entitlement', async () => {
      const { hook, service } = make(false);

      expect(await hook.scoreProgress('org-1', 'pol-1', approvals)).toBeNull();
      expect(service.get).not.toHaveBeenCalled();
    });
  });
});
