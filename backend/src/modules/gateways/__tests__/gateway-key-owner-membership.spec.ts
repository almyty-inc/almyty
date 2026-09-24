import { GatewayAuthValidators } from '../gateway-auth-validators.helper';
import { GatewayAuth, GatewayAuthType } from '../../../entities/gateway-auth.entity';
import { ApiKey } from '../../../entities/api-key.entity';
import { hashKey } from '../gateway-auth-utils';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * A gateway key outlives nothing its owner lost.
 *
 * The platform ApiKeyStrategy refuses a key whose owner is no longer an
 * effective member of the key's organization. The gateway API_KEY and
 * BEARER_TOKEN validators looked the key up by hash + isActive + org and
 * stopped there, so removing somebody from the organization (or
 * deactivating the account) left every gateway key they had minted
 * working against that organization's gateways.
 */
describe('gateway API key / bearer token owner checks', () => {
  const KEY = 'gw_owner_check_key_0123456789abcdef';
  const ORG = 'org-a';
  const GATEWAY = 'gateway-1';

  function build(user: any) {
    const gateways = fakeRepository([{ id: GATEWAY, organizationId: ORG }]);
    const apiKeys = fakeRepository<ApiKey>({
      make: () => new ApiKey(),
      seed: [
        {
          id: 'key-1',
          name: 'k',
          keyHash: hashKey(KEY),
          isActive: true,
          organizationId: ORG,
          gatewayId: GATEWAY,
          userId: user.id,
          user,
          scopes: ['gateway:use'],
        } as any,
      ],
    });
    return new GatewayAuthValidators(
      gateways as any,
      fakeRepository() as any,
      apiKeys as any,
      fakeRepository() as any,
      {} as any,
    );
  }

  const apiKeyConfig = {
    id: 'auth-1',
    gatewayId: GATEWAY,
    type: GatewayAuthType.API_KEY,
    isActive: true,
    configuration: {},
  } as unknown as GatewayAuth;
  const bearerConfig = { ...apiKeyConfig, type: GatewayAuthType.BEARER_TOKEN } as GatewayAuth;

  const member = (over: Record<string, any> = {}) => ({
    organizationId: ORG,
    role: 'member',
    isActive: true,
    ...over,
  });

  const cases: Array<[string, any]> = [
    ['owner removed from the organization', { id: 'u1', isActive: true, organizationMemberships: [] }],
    [
      'owner membership deactivated',
      { id: 'u1', isActive: true, organizationMemberships: [member({ isActive: false })] },
    ],
    [
      'owner a member of another org only',
      { id: 'u1', isActive: true, organizationMemberships: [member({ organizationId: 'org-b' })] },
    ],
    ['owner account deactivated', { id: 'u1', isActive: false, organizationMemberships: [member()] }],
  ];

  it.each(cases)('API_KEY refuses when %s', async (_label, user) => {
    const result = await build(user).validateApiKey(apiKeyConfig, { 'x-api-key': KEY }, {});
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('API_KEY_INVALID');
  });

  it.each(cases)('BEARER_TOKEN refuses when %s', async (_label, user) => {
    const result = await build(user).validateBearerToken(bearerConfig, { authorization: `Bearer ${KEY}` });
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('BEARER_TOKEN_INVALID');
  });

  it('accepts a key whose owner is an active, current member, with that role only', async () => {
    const user = {
      id: 'u1',
      isActive: true,
      organizationMemberships: [member({ role: 'admin' }), member({ organizationId: 'org-b', role: 'owner' })],
    };
    const viaKey = await build(user).validateApiKey(apiKeyConfig, { 'x-api-key': KEY }, {});
    expect(viaKey.isValid).toBe(true);
    expect(viaKey.roles).toEqual(['admin']);
    const viaBearer = await build(user).validateBearerToken(bearerConfig, { authorization: `Bearer ${KEY}` });
    expect(viaBearer.isValid).toBe(true);
    expect(viaBearer.roles).toEqual(['admin']);
  });
});
