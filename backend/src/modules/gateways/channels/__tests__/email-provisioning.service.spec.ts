import { Logger } from '@nestjs/common';
import { EmailProvisioningService } from '../email-provisioning.service';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';

/**
 * Inbound-address provisioning for email channel gateways. Covers the
 * address derivation (<gatewaySlug>@<EMAIL_INBOUND_DOMAIN>), the skip
 * path when the env var is unset (send-only/manual config untouched),
 * the manual-override guard, the outcome recording on the gateway row
 * + channel-event log, and the recipient -> gateway fallback resolver
 * used by the global inbound route.
 */
describe('EmailProvisioningService', () => {
  const DOMAIN = 'inbound.almyty.example';

  let service: EmailProvisioningService;
  let gatewayRepository: { update: jest.Mock; createQueryBuilder: jest.Mock };
  let eventRepository: { create: jest.Mock; save: jest.Mock };
  let configService: { get: jest.Mock };
  let queryBuilder: any;

  const makeGateway = (over: Partial<Gateway> = {}): Gateway =>
    ({
      id: 'gw-1',
      type: GatewayType.EMAIL,
      status: GatewayStatus.ACTIVE,
      organizationId: 'org-1',
      endpoint: '/support-bot',
      configuration: { resend_api_key: 're_test' },
      metadata: null,
      ...over,
    } as unknown as Gateway);

  beforeEach(() => {
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    gatewayRepository = {
      update: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    eventRepository = {
      create: jest.fn((e) => e),
      save: jest.fn().mockResolvedValue(undefined),
    };
    configService = { get: jest.fn().mockReturnValue(DOMAIN) };
    service = new EmailProvisioningService(
      gatewayRepository as any,
      eventRepository as any,
      configService as any,
    );
  });

  describe('sync — provisioning', () => {
    it('derives <gatewaySlug>@<EMAIL_INBOUND_DOMAIN> and stores it on configuration.inbound_address', async () => {
      const gateway = makeGateway();
      await service.sync(gateway);

      const configUpdate = gatewayRepository.update.mock.calls.find((c) => c[1].configuration);
      expect(configUpdate[0]).toBe('gw-1');
      expect(configUpdate[1].configuration.inbound_address).toBe('support-bot@inbound.almyty.example');
      // Pre-existing config keys survive.
      expect(configUpdate[1].configuration.resend_api_key).toBe('re_test');

      // Outcome recorded on the gateway row...
      const metaUpdate = gatewayRepository.update.mock.calls.find((c) => c[1].metadata);
      expect(metaUpdate[1].metadata.emailProvisioning).toMatchObject({
        status: 'provisioned',
        address: 'support-bot@inbound.almyty.example',
        error: null,
      });
      // ...and in the channel-event log.
      expect(eventRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          gatewayId: 'gw-1',
          direction: 'outbound',
          status: 'processed',
          payload: expect.objectContaining({
            kind: 'email_provisioning',
            status: 'provisioned',
            address: 'support-bot@inbound.almyty.example',
          }),
        }),
      );
    });

    it('sanitizes the endpoint into a valid mail local part', () => {
      expect(
        EmailProvisioningService.localPartFor(makeGateway({ endpoint: '/Gateways/My Bot!' } as Partial<Gateway>)),
      ).toBe('gateways-my-bot');
      expect(
        EmailProvisioningService.localPartFor(makeGateway({ endpoint: '///' } as Partial<Gateway>)),
      ).toBe('gw-1');
    });

    it('skips with a logged warning and a metadata record when EMAIL_INBOUND_DOMAIN is unset', async () => {
      configService.get.mockReturnValue(undefined);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const gateway = makeGateway();
      await service.sync(gateway);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('EMAIL_INBOUND_DOMAIN'));
      // No configuration write — the send-only/manual path is untouched.
      const configUpdate = gatewayRepository.update.mock.calls.find((c) => c[1].configuration);
      expect(configUpdate).toBeUndefined();
      const metaUpdate = gatewayRepository.update.mock.calls.find((c) => c[1].metadata);
      expect(metaUpdate[1].metadata.emailProvisioning).toMatchObject({
        status: 'skipped',
        error: 'EMAIL_INBOUND_DOMAIN not configured',
      });
      warnSpy.mockRestore();
    });

    it('leaves a manually configured inbound_address alone', async () => {
      const gateway = makeGateway({
        configuration: { inbound_address: 'custom@corp.example' },
      } as Partial<Gateway>);
      await service.sync(gateway);

      const configUpdate = gatewayRepository.update.mock.calls.find((c) => c[1].configuration);
      expect(configUpdate).toBeUndefined();
      const metaUpdate = gatewayRepository.update.mock.calls.find((c) => c[1].metadata);
      expect(metaUpdate[1].metadata.emailProvisioning).toMatchObject({
        status: 'skipped',
        error: 'manual inbound_address present',
      });
    });

    it('re-derives when the previous address was auto-provisioned (endpoint rename)', async () => {
      const gateway = makeGateway({
        endpoint: '/renamed-bot',
        configuration: { inbound_address: 'support-bot@inbound.almyty.example' },
        metadata: {
          emailProvisioning: { status: 'provisioned', address: 'support-bot@inbound.almyty.example' },
        },
      } as Partial<Gateway>);
      await service.sync(gateway);

      const configUpdate = gatewayRepository.update.mock.calls.find((c) => c[1].configuration);
      expect(configUpdate[1].configuration.inbound_address).toBe('renamed-bot@inbound.almyty.example');
    });

    it('ignores non-email and non-active gateways', async () => {
      await service.sync(makeGateway({ type: GatewayType.SLACK } as Partial<Gateway>));
      await service.sync(makeGateway({ status: GatewayStatus.INACTIVE } as Partial<Gateway>));
      expect(gatewayRepository.update).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
    });

    it('never throws, even when persistence blows up', async () => {
      gatewayRepository.update.mockRejectedValue(new Error('db down'));
      await expect(service.sync(makeGateway())).resolves.toBeUndefined();
    });
  });

  describe('resolveGatewayByRecipient', () => {
    it('resolves the active email gateway owning the recipient address, across orgs', async () => {
      const gateway = makeGateway();
      queryBuilder.getOne.mockResolvedValue(gateway);

      const found = await service.resolveGatewayByRecipient([
        'Support Bot <Support-Bot@Inbound.Almyty.example>',
      ]);

      expect(found).toBe(gateway);
      expect(queryBuilder.where).toHaveBeenCalledWith('gateway.type = :type', {
        type: GatewayType.EMAIL,
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('gateway.status = :status', {
        status: GatewayStatus.ACTIVE,
      });
      // Address normalized to the bare lowercase mailbox before matching.
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        "LOWER(gateway.configuration ->> 'inbound_address') IN (:...addresses)",
        { addresses: ['support-bot@inbound.almyty.example'] },
      );
      // No org filter — this is the cross-org fallback by design.
      const clauses = [
        queryBuilder.where.mock.calls,
        queryBuilder.andWhere.mock.calls,
      ].flat();
      expect(clauses.some(([sql]) => String(sql).includes('organizationId'))).toBe(false);
    });

    it('returns null without querying when no recipient is resolvable', async () => {
      expect(await service.resolveGatewayByRecipient([])).toBeNull();
      expect(await service.resolveGatewayByRecipient(['not-an-address'])).toBeNull();
      expect(gatewayRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
