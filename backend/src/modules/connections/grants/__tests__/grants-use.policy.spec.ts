import { GrantsUsePolicy } from '../grants-use.policy';

describe('GrantsUsePolicy (the consumer-side seam)', () => {
  const build = () => {
    const grants = { assertCanUse: jest.fn().mockResolvedValue({ allowed: true }) };
    return { policy: new GrantsUsePolicy(grants as any), grants };
  };
  const credential = (over: Record<string, any>) => ({ id: 'c-1', organizationId: 'org', connectorKey: 'openai', metadata: null, ...over }) as any;

  it('consults grants for a shared connection with a principal, passing purpose and resource', async () => {
    const { policy, grants } = build();
    await policy.assertCanUse({ organizationId: 'org', credential: credential({}), principal: { id: 'u-1', organizationIds: ['org'] }, context: { purpose: 'llm_call', resourceType: 'agent', resourceId: 'a-1' } });
    expect(grants.assertCanUse).toHaveBeenCalledWith({ id: 'u-1', organizationIds: ['org'] }, expect.objectContaining({ id: 'c-1' }), { purpose: 'llm_call', resourceType: 'agent', resourceId: 'a-1' });
  });

  it('lets plain credentials, consumer-managed rows and system calls through without a grant check', async () => {
    const { policy, grants } = build();
    await policy.assertCanUse({ organizationId: 'org', credential: credential({ connectorKey: null }), principal: { id: 'u-1' } });
    await policy.assertCanUse({ organizationId: 'org', credential: credential({ metadata: { managedBy: { kind: 'llm_provider', id: 'p-1' } } }), principal: { id: 'u-1' } });
    await policy.assertCanUse({ organizationId: 'org', credential: credential({}) });
    expect(grants.assertCanUse).not.toHaveBeenCalled();
  });

  it('propagates the refusal', async () => {
    const { policy, grants } = build();
    grants.assertCanUse.mockRejectedValue(Object.assign(new Error('no grant'), { code: 'CONNECTION_NOT_GRANTED' }));
    await expect(policy.assertCanUse({ organizationId: 'org', credential: credential({}), principal: { id: 'u-2' } })).rejects.toMatchObject({ code: 'CONNECTION_NOT_GRANTED' });
  });
});
