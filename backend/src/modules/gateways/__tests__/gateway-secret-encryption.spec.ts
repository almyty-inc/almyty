import { GatewaysService } from '../gateways.service';
import { GatewaysController } from '../gateways.controller';
import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { encryptField, isEncrypted, decryptField } from '../../../common/security/field-crypto';
import { MASKED_CHANNEL_SECRET } from '../channels/channel-config.helper';

/**
 * Channel secrets at rest + on the API surface:
 *  - create/update encrypt bot tokens and friends before persisting
 *  - a masked value round-tripped through update never clobbers the
 *    stored secret
 *  - GET responses mask secret keys
 */
describe('GatewaysService — channel secret encryption at rest', () => {
  let gatewayRepository: any;
  let organizationRepository: any;
  let userRepository: any;
  let accessPolicy: any;
  let auditLogService: any;
  let init: any;

  const makeService = () =>
    new GatewaysService(
      gatewayRepository,
      {} as any, // gatewayTool repo
      {} as any, // gatewayAuth repo
      userRepository,
      organizationRepository,
      {} as any, // usageMetric repo
      auditLogService,
      {} as any, // stats helper
      init,
      accessPolicy,
    );

  beforeEach(() => {
    gatewayRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((dto: any) => ({ ...dto })),
      save: jest.fn(async (g: any) => g),
    };
    organizationRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'org-1',
        canAddMoreGateways: () => true,
      }),
    };
    userRepository = {
      findOne: jest.fn().mockResolvedValue({
        hasPermissionInOrganization: () => true,
      }),
    };
    accessPolicy = {
      assertCanScopeToTeam: jest.fn().mockResolvedValue(undefined),
      canAccess: jest.fn().mockResolvedValue({ allowed: true }),
    };
    auditLogService = {
      logCreate: jest.fn(),
      logUpdate: jest.fn(),
      computeChanges: jest.fn().mockReturnValue({}),
    };
    init = {
      validateGatewayConfiguration: jest.fn(),
      createDefaultAuth: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('createGateway encrypts channel secrets before persisting', async () => {
    const service = makeService();

    await service.createGateway(
      {
        name: 'tg-bot',
        type: GatewayType.TELEGRAM,
        agentId: 'agent-1',
        endpoint: '/tg-bot',
        configuration: { bot_token: '123456:plain-token', aiDisclosure: true },
      } as any,
      'org-1',
      'user-1',
    );

    const saved = gatewayRepository.save.mock.calls[0][0];
    expect(isEncrypted(saved.configuration.bot_token)).toBe(true);
    expect(decryptField(saved.configuration.bot_token)).toBe('123456:plain-token');
    // Non-secret keys stay plaintext.
    expect(saved.configuration.aiDisclosure).toBe(true);
  });

  it('createGateway encrypts twilio and whatsapp-cloud secrets too', async () => {
    const service = makeService();

    await service.createGateway(
      {
        name: 'wa-cloud',
        type: GatewayType.WHATSAPP_CLOUD,
        agentId: 'agent-1',
        endpoint: '/wa-cloud',
        configuration: {
          access_token: 'meta-token',
          app_secret: 'app-s',
          verify_token: 'vt',
          phone_number_id: 'pnid-1',
        },
      } as any,
      'org-1',
      'user-1',
    );

    const saved = gatewayRepository.save.mock.calls[0][0];
    expect(isEncrypted(saved.configuration.access_token)).toBe(true);
    expect(isEncrypted(saved.configuration.app_secret)).toBe(true);
    expect(isEncrypted(saved.configuration.verify_token)).toBe(true);
    expect(saved.configuration.phone_number_id).toBe('pnid-1');
  });

  it('updateGateway keeps the stored secret when the client round-trips the mask', async () => {
    const storedToken = encryptField('123456:stored-token');
    gatewayRepository.findOne.mockResolvedValue({
      id: 'gw-1',
      name: 'tg-bot',
      type: GatewayType.TELEGRAM,
      status: GatewayStatus.ACTIVE,
      organizationId: 'org-1',
      endpoint: '/tg-bot',
      configuration: { bot_token: storedToken, aiDisclosure: true },
      isSystem: false,
    } as unknown as Gateway);
    const service = makeService();

    await service.updateGateway(
      'gw-1',
      {
        configuration: { bot_token: MASKED_CHANNEL_SECRET, aiDisclosure: false },
      } as any,
      'org-1',
      'user-1',
    );

    const saved = gatewayRepository.save.mock.calls[0][0];
    expect(saved.configuration.bot_token).toBe(storedToken);
    expect(saved.configuration.aiDisclosure).toBe(false);
  });

  it('updateGateway encrypts a newly provided plaintext secret', async () => {
    gatewayRepository.findOne.mockResolvedValue({
      id: 'gw-1',
      name: 'tg-bot',
      type: GatewayType.TELEGRAM,
      status: GatewayStatus.ACTIVE,
      organizationId: 'org-1',
      endpoint: '/tg-bot',
      configuration: { bot_token: encryptField('old') },
      isSystem: false,
    } as unknown as Gateway);
    const service = makeService();

    await service.updateGateway(
      'gw-1',
      { configuration: { bot_token: '123456:new-token' } } as any,
      'org-1',
      'user-1',
    );

    const saved = gatewayRepository.save.mock.calls[0][0];
    expect(isEncrypted(saved.configuration.bot_token)).toBe(true);
    expect(decryptField(saved.configuration.bot_token)).toBe('123456:new-token');
  });
});

describe('GatewaysController — API responses mask channel secrets', () => {
  const req = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };

  const storedGateway = {
    id: 'gw-1',
    name: 'tg-bot',
    type: GatewayType.TELEGRAM,
    status: GatewayStatus.ACTIVE,
    organizationId: 'org-1',
    endpoint: '/tg-bot',
    configuration: {
      bot_token: encryptField('123456:stored-token'),
      signing_secret: 'legacy-plaintext',
      aiDisclosure: true,
    },
  };

  const makeController = (gatewaysService: any) =>
    new GatewaysController(
      gatewaysService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

  it('GET /gateways/:id masks secret keys and keeps the rest', async () => {
    const controller = makeController({
      getGateway: jest.fn().mockResolvedValue({ ...storedGateway }),
    });

    const res = await controller.getGateway('gw-1', req);

    expect(res.data.configuration.bot_token).toBe(MASKED_CHANNEL_SECRET);
    expect(res.data.configuration.signing_secret).toBe(MASKED_CHANNEL_SECRET);
    expect(res.data.configuration.aiDisclosure).toBe(true);
    // Neither the ciphertext nor the plaintext leaks.
    expect(JSON.stringify(res)).not.toContain('stored-token');
    expect(JSON.stringify(res)).not.toContain('legacy-plaintext');
  });

  it('GET /gateways masks secret keys on every row', async () => {
    const controller = makeController({
      getGateways: jest.fn().mockResolvedValue({
        gateways: [{ ...storedGateway }, { ...storedGateway, id: 'gw-2' }],
        total: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
      }),
    });

    const res = await controller.getGateways({} as any, req);

    for (const gw of res.data.gateways) {
      expect(gw.configuration.bot_token).toBe(MASKED_CHANNEL_SECRET);
      expect(gw.configuration.signing_secret).toBe(MASKED_CHANNEL_SECRET);
    }
    expect(res.data.total).toBe(2);
  });

  it('PATCH /gateways/:id response masks secrets', async () => {
    const controller = makeController({
      updateGateway: jest.fn().mockResolvedValue({ ...storedGateway }),
    });

    const res = await controller.updateGateway('gw-1', {} as any, req);

    expect(res.data.configuration.bot_token).toBe(MASKED_CHANNEL_SECRET);
  });
});
