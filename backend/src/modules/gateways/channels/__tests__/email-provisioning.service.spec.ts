import { Logger } from '@nestjs/common';
import { EmailProvisioningService } from '../email-provisioning.service';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';
import {
  ClauseModel,
  ExecutedQuery,
  RecordingQueryBuilder,
  clause,
  matchingRows,
  organizationScope,
} from '../../__tests__/recording-query-builder';

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
  let queryBuilder: RecordingQueryBuilder;
  let gatewayRows: Gateway[];

  /**
   * The recipient lookup, evaluated against a gateways table. The chain
   * that stood here answered a canned row whatever the WHERE said, so
   * the type or status predicate could go -- delivering mail to a paused
   * gateway, or to a Slack one carrying the same config key -- with the
   * suite green. A clause not listed throws.
   */
  const RECIPIENT_CLAUSES: ClauseModel = {
    'gateway.type = :type': (row, p) => row.type === p.type,
    'gateway.status = :status': (row, p) => row.status === p.status,
    "LOWER(gateway.configuration ->> 'inbound_address') IN (:...addresses)": (row, p) =>
      typeof row.configuration?.inbound_address === 'string' &&
      p.addresses.includes(row.configuration.inbound_address.toLowerCase()),
  };

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
    gatewayRows = [];
    gatewayRepository = {
      update: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(
        (alias: string) =>
          (queryBuilder = new RecordingQueryBuilder(alias, {
            getOne: (query: ExecutedQuery) => matchingRows(query, gatewayRows, RECIPIENT_CLAUSES)[0] ?? null,
          })),
      ),
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
      const inbound = (address: string) => ({ resend_api_key: 're_test', inbound_address: address });
      gatewayRows.push(
        // Each decoy differs from the owner in exactly one predicate, and
        // sits ahead of it, so a dropped predicate hands it back instead.
        makeGateway({ id: 'gw-paused', status: GatewayStatus.INACTIVE, configuration: inbound('support-bot@inbound.almyty.example') }),
        makeGateway({ id: 'gw-slack', type: GatewayType.SLACK, configuration: inbound('support-bot@inbound.almyty.example') }),
        makeGateway({ id: 'gw-other-address', configuration: inbound('billing@inbound.almyty.example') }),
        makeGateway({ id: 'gw-owner', organizationId: 'org-2', configuration: inbound('Support-Bot@inbound.almyty.example') }),
      );

      const found = await service.resolveGatewayByRecipient([
        'Support Bot <Support-Bot@Inbound.Almyty.example>',
      ]);

      expect(found?.id).toBe('gw-owner');
      // Address normalized to the bare lowercase mailbox before matching.
      expect(
        clause(queryBuilder.executed[0], "LOWER(gateway.configuration ->> 'inbound_address') IN (:...addresses)")?.params,
      ).toEqual({ addresses: ['support-bot@inbound.almyty.example'] });
      // No org filter — this is the cross-org fallback by design.
      expect(organizationScope(queryBuilder.executed[0], 'gateway')).toBeUndefined();
    });

    it('resolves nothing when only an inactive or non-email gateway holds the address', async () => {
      const inbound = { inbound_address: 'support-bot@inbound.almyty.example' };
      gatewayRows.push(
        makeGateway({ id: 'gw-paused', status: GatewayStatus.INACTIVE, configuration: inbound }),
        makeGateway({ id: 'gw-slack', type: GatewayType.SLACK, configuration: inbound }),
      );

      expect(await service.resolveGatewayByRecipient(['support-bot@inbound.almyty.example'])).toBeNull();
    });

    it('returns null without querying when no recipient is resolvable', async () => {
      expect(await service.resolveGatewayByRecipient([])).toBeNull();
      expect(await service.resolveGatewayByRecipient(['not-an-address'])).toBeNull();
      expect(gatewayRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
