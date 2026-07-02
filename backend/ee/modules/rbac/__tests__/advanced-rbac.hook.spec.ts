import { AdvancedRbacHookImpl } from '../advanced-rbac.hook';

/**
 * EE (advanced_rbac): the hook bound to ADVANCED_RBAC_HOOK bridges the core
 * RolesGuard to custom-role grants + ABAC. Unlicensed → no grants, always
 * abstain (community parity).
 */
describe('AdvancedRbacHookImpl', () => {
  function make(entitled: boolean) {
    const customRoles = {
      hasPermission: jest.fn(async () => true),
      evaluateAccess: jest.fn(async () => ({
        allowed: false,
        effect: 'default' as const,
        reason: 'no applicable policy',
      })),
    };
    const license = { has: jest.fn((f: string) => entitled && f === 'advanced_rbac') };
    const hook = new AdvancedRbacHookImpl(customRoles as any, license as any);
    return { hook, customRoles, license };
  }

  describe('hasPermission', () => {
    it('delegates to the custom-role resolver when entitled', async () => {
      const { hook, customRoles } = make(true);

      expect(await hook.hasPermission('org-1', 'user-1', 'delete')).toBe(true);
      expect(customRoles.hasPermission).toHaveBeenCalledWith('org-1', 'user-1', 'delete');
    });

    it('returns false without the advanced_rbac entitlement', async () => {
      const { hook, customRoles } = make(false);

      expect(await hook.hasPermission('org-1', 'user-1', 'delete')).toBe(false);
      expect(customRoles.hasPermission).not.toHaveBeenCalled();
    });
  });

  describe('evaluateAccess', () => {
    it('maps an ABAC deny to a deny decision', async () => {
      const { hook, customRoles } = make(true);
      customRoles.evaluateAccess.mockResolvedValue({
        allowed: false,
        effect: 'deny' as any,
        reason: 'denied by policy "lockout"',
      });

      const decision = await hook.evaluateAccess('org-1', 'delete', { subject: { id: 'u1' } });

      expect(decision).toEqual({ effect: 'deny', reason: 'denied by policy "lockout"' });
      expect(customRoles.evaluateAccess).toHaveBeenCalledWith('org-1', 'delete', {
        subject: { id: 'u1' },
      });
    });

    it('maps an ABAC allow to an allow decision', async () => {
      const { hook, customRoles } = make(true);
      customRoles.evaluateAccess.mockResolvedValue({
        allowed: true,
        effect: 'allow' as any,
        reason: 'allowed by policy "daytime"',
      });

      const decision = await hook.evaluateAccess('org-1', 'read', {});

      expect(decision.effect).toBe('allow');
    });

    it("maps 'default' (no applicable policy) to abstain — never fail-closed", async () => {
      const { hook } = make(true);

      const decision = await hook.evaluateAccess('org-1', 'read', {});

      expect(decision.effect).toBe('abstain');
    });

    it('abstains without the advanced_rbac entitlement', async () => {
      const { hook, customRoles } = make(false);

      const decision = await hook.evaluateAccess('org-1', 'read', {});

      expect(decision).toEqual({ effect: 'abstain' });
      expect(customRoles.evaluateAccess).not.toHaveBeenCalled();
    });
  });
});
