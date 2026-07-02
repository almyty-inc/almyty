import { ComplianceEnforcementHookImpl } from '../compliance-enforcement.hook';

/**
 * EE (compliance_pack): the hook bound to COMPLIANCE_ENFORCEMENT_HOOK maps
 * the org's effective policy onto the plugin manager's enforcement shape.
 * Unlicensed → null (community parity). Resolved policies are cached per
 * org for a short TTL because the plugin pipeline is hot.
 */
describe('ComplianceEnforcementHookImpl', () => {
  const effective = (over: any = {}) => ({
    organizationId: 'org-1',
    configured: true,
    enforcedPlugins: ['pii-filter', 'security-scanner'],
    securityThreshold: 'high',
    blockOnViolation: true,
    piiCategories: [],
    ...over,
  });

  function make(entitled: boolean, policy: any = effective()) {
    const compliance = { getEffectivePolicy: jest.fn(async () => policy) };
    const license = { has: jest.fn((f: string) => entitled && f === 'compliance_pack') };
    const hook = new ComplianceEnforcementHookImpl(compliance as any, license as any);
    return { hook, compliance, license };
  }

  it('maps the effective policy onto per-plugin settings overrides', async () => {
    const { hook, compliance } = make(true);

    const enforcement = await hook.getEnforcement('org-1');

    expect(compliance.getEffectivePolicy).toHaveBeenCalledWith('org-1');
    expect(enforcement).toEqual({
      enforcedPlugins: {
        'pii-filter': {},
        'security-scanner': { severityThreshold: 'high', blockOnThreat: true },
      },
      blockOnViolation: true,
    });
  });

  it('returns null when the policy enforces nothing', async () => {
    const { hook } = make(true, effective({ enforcedPlugins: [] }));

    expect(await hook.getEnforcement('org-1')).toBeNull();
  });

  it('returns null without the compliance_pack entitlement', async () => {
    const { hook, compliance } = make(false);

    expect(await hook.getEnforcement('org-1')).toBeNull();
    expect(compliance.getEffectivePolicy).not.toHaveBeenCalled();
  });

  it('caches the resolved policy per org within the TTL', async () => {
    const { hook, compliance } = make(true);

    await hook.getEnforcement('org-1');
    await hook.getEnforcement('org-1');
    await hook.getEnforcement('org-2');

    expect(compliance.getEffectivePolicy).toHaveBeenCalledTimes(2);
    expect(compliance.getEffectivePolicy).toHaveBeenNthCalledWith(1, 'org-1');
    expect(compliance.getEffectivePolicy).toHaveBeenNthCalledWith(2, 'org-2');
  });

  it('re-reads after the TTL expires', async () => {
    const { hook, compliance } = make(true);
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now');
    try {
      spy.mockReturnValue(now);
      await hook.getEnforcement('org-1');
      spy.mockReturnValue(now + 31_000);
      await hook.getEnforcement('org-1');
    } finally {
      spy.mockRestore();
    }

    expect(compliance.getEffectivePolicy).toHaveBeenCalledTimes(2);
  });
});
