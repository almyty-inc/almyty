/**
 * A key made for a gateway works the moment it is shown.
 *
 * The A2A channel page offers "Make key" next to a "Keys" checkbox. The
 * staging gate made a key while the gateway's key method was off and the
 * caller was refused with NO_AUTH_CONFIGURED. Making a gateway key now turns
 * the key method on (or adds it) before the key exists.
 */
import { GatewayAuthService } from '../gateway-auth.service';
import { GatewayAuthValidators } from '../gateway-auth-validators.helper';
import { fakeRepository } from '../../../test/fake-repository';
import { GatewayAuth, GatewayAuthType } from '../../../entities/gateway-auth.entity';
import { ApiKey } from '../../../entities/api-key.entity';

const ORG = 'org-1';
const user = { id: 'user-1', organizationMemberships: [{ organizationId: ORG, role: 'admin' }] };

function build(gateways: any[], auths: Array<Partial<GatewayAuth>>) {
  const gatewayRepo = fakeRepository<any>(gateways);
  const authRepo = fakeRepository<GatewayAuth>({ seed: auths, make: () => new GatewayAuth(), idPrefix: 'auth' });
  const apiKeys = fakeRepository<ApiKey>({ make: () => new ApiKey(), idPrefix: 'key' });
  const validators = new GatewayAuthValidators(gatewayRepo as any, fakeRepository<any>([user]) as any, apiKeys as any, fakeRepository<any>([]) as any, { verify: jest.fn() } as any);
  const service = new GatewayAuthService(authRepo as any, gatewayRepo as any, apiKeys as any, validators);
  /** Make a key the way the gateway page does, and attach its owner (relations are not modelled). */
  const makeKey = async (gatewayId: string) => {
    const made = await service.generateApiKey('caller', ORG, user.id, ['gateway:use'], undefined, gatewayId);
    apiKeys.seed({ ...apiKeys.row(made.id)!, user } as any);
    return (made as any).key as string;
  };
  return { service, authRepo, makeKey };
}

const a2a = { id: 'gw-a2a', organizationId: ORG, type: 'a2a', metadata: {} };
const keyMethod = (over: Partial<GatewayAuth> = {}): Partial<GatewayAuth> => ({
  id: 'auth-key', gatewayId: a2a.id, type: GatewayAuthType.API_KEY, isRequired: true, isActive: true,
  configuration: { keyHeader: 'x-api-key' }, createdAt: new Date(0), ...over,
});

describe('making a gateway key turns key sign-in on', () => {
  it('turns an inactive key method back on, so the new key is accepted', async () => {
    const { service, authRepo, makeKey } = build([a2a], [keyMethod({ isActive: false })]);

    const key = await makeKey(a2a.id);

    expect(authRepo.row('auth-key')!.isActive).toBe(true);
    const result = await service.authenticateRequest(a2a.id, { 'x-api-key': key }, {});
    expect(result.errorCode).not.toBe('NO_AUTH_CONFIGURED');
    expect(result.isValid).toBe(true);
  });

  it('adds a key method when the gateway has none', async () => {
    const { service, authRepo, makeKey } = build([a2a], []);

    const key = await makeKey(a2a.id);

    const active = authRepo.rows().filter(row => row.type === GatewayAuthType.API_KEY && row.isActive)
    expect(active).toHaveLength(1);
    expect(active[0].configuration).toMatchObject({ keyHeader: 'x-api-key' });
    expect((await service.authenticateRequest(a2a.id, { 'x-api-key': key }, {})).isValid).toBe(true);
  });

  it('leaves an active key method alone and adds no duplicate', async () => {
    const { authRepo, makeKey } = build([a2a], [keyMethod()]);

    await makeKey(a2a.id);

    expect(authRepo.rows()).toHaveLength(1);
    expect(authRepo.save).not.toHaveBeenCalled();
  });

  it('adds nothing to an endpoint whose access scope never reads sign-in methods', async () => {
    const members = { id: 'gw-mcp', organizationId: ORG, type: 'mcp', accessScope: 'org' };
    const { authRepo, makeKey } = build([members], []);

    await makeKey(members.id);

    expect(authRepo.rows()).toHaveLength(0);
  });

  it('refuses a gateway of another organization before making a key', async () => {
    const other = { ...a2a, id: 'gw-other', organizationId: 'org-2' };
    const { service, authRepo } = build([other], []);

    await expect(service.generateApiKey('caller', ORG, user.id, [], undefined, other.id)).rejects.toThrow('Gateway not found');
    expect(authRepo.rows()).toHaveLength(0);
  });
});
