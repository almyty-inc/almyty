import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { ChannelEvent } from '../../../entities/channel-event.entity';
import { EmailAdapter } from './adapters/email.adapter';

/**
 * Inbound-address provisioning for email channel gateways — the email
 * sibling of ChannelWebhookRegistrar. Deploying an agent to email
 * (gateway created/activated) derives the gateway's inbound address
 *
 *   <gatewaySlug>@<EMAIL_INBOUND_DOMAIN>
 *
 * where the slug is the gateway endpoint sanitized to a mail local
 * part, and stores it on `configuration.inbound_address`. Mail sent to
 * that address becomes agent runs: the unified endpoint resolves the
 * gateway by org/gateway slug, and providers that only support one
 * account-level inbound webhook (Resend) hit the global fallback route
 * (POST /channels/email/inbound), which maps recipient -> gateway via
 * `resolveGatewayByRecipient`.
 *
 * Without EMAIL_INBOUND_DOMAIN provisioning is skipped with a logged
 * warning and a `metadata.emailProvisioning` record (mirroring the
 * PUBLIC_API_URL skip in the webhook registrar) — the send-only /
 * manually configured path keeps working unchanged.
 *
 * Purely local: providers like Resend receive ALL mail for the inbound
 * domain (MX record) and there is no per-address provisioning API, so
 * "provisioning" is deterministic derivation + persistence. Invoked
 * from the GatewaysService CRUD seams the same way the webhook
 * registrar is (@Optional() injection, fire-and-forget): provisioning
 * must never fail a CRUD request.
 */
@Injectable()
export class EmailProvisioningService {
  private readonly logger = new Logger(EmailProvisioningService.name);

  constructor(
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    @InjectRepository(ChannelEvent)
    private readonly eventRepository: Repository<ChannelEvent>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Mail local part for a gateway: the endpoint lowercased, stripped
   * of leading slashes, with everything outside [a-z0-9._-] collapsed
   * to '-'. Falls back to the gateway id when nothing survives.
   */
  static localPartFor(gateway: Gateway): string {
    const slug = (gateway.endpoint || '')
      .toLowerCase()
      .replace(/^\/+/, '')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '');
    return (slug || gateway.id).slice(0, 64);
  }

  /**
   * Reconcile the inbound address with the gateway state. Only acts on
   * active email gateways; never throws.
   */
  async sync(gateway: Gateway): Promise<void> {
    if (gateway.type !== GatewayType.EMAIL) return;
    if (gateway.status !== GatewayStatus.ACTIVE) return;
    try {
      await this.provision(gateway);
    } catch (err: any) {
      this.logger.warn(
        `email provisioning failed (gateway ${gateway.id}): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Gateway deleted. The address is a local derivation — there is
   * nothing to tear down at the provider (Resend keeps receiving for
   * the whole domain; unmatched recipients 404 on the fallback route).
   */
  async remove(gateway: Gateway): Promise<void> {
    if (gateway.type !== GatewayType.EMAIL) return;
    this.logger.log(`email gateway ${gateway.id} removed; inbound address released`);
  }

  /**
   * Global fallback resolver for providers with one account-level
   * inbound webhook: map a delivery's recipient addresses to the
   * active email gateway whose `configuration.inbound_address`
   * matches, across ALL organizations.
   */
  async resolveGatewayByRecipient(recipients: string[]): Promise<Gateway | null> {
    const addresses = [
      ...new Set(
        (recipients || [])
          .map((r) => EmailAdapter.extractAddress(r))
          .filter((a): a is string => !!a),
      ),
    ];
    if (addresses.length === 0) return null;
    return this.gatewayRepository
      .createQueryBuilder('gateway')
      .where('gateway.type = :type', { type: GatewayType.EMAIL })
      .andWhere('gateway.status = :status', { status: GatewayStatus.ACTIVE })
      .andWhere("LOWER(gateway.configuration ->> 'inbound_address') IN (:...addresses)", {
        addresses,
      })
      .getOne();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async provision(gateway: Gateway): Promise<void> {
    const domain = (this.configService.get<string>('EMAIL_INBOUND_DOMAIN') || '')
      .trim()
      .replace(/^@+/, '')
      .toLowerCase();
    const cfg = gateway.configuration || {};

    if (!domain) {
      this.logger.warn(
        `EMAIL_INBOUND_DOMAIN is not set — skipping inbound address provisioning for gateway ${gateway.id} (send-only / manual configuration unchanged)`,
      );
      await this.record(gateway, 'skipped', null, 'EMAIL_INBOUND_DOMAIN not configured');
      return;
    }

    const address = `${EmailProvisioningService.localPartFor(gateway)}@${domain}`;
    const previouslyProvisioned = (gateway.metadata as any)?.emailProvisioning?.address;

    // An operator-set inbound_address (different from anything we
    // derived) wins — provisioning must not clobber manual config.
    if (
      cfg.inbound_address &&
      cfg.inbound_address !== address &&
      cfg.inbound_address !== previouslyProvisioned
    ) {
      await this.record(gateway, 'skipped', cfg.inbound_address, 'manual inbound_address present');
      return;
    }

    if (cfg.inbound_address !== address) {
      const configuration: Record<string, any> = { ...cfg, inbound_address: address };
      await this.gatewayRepository.update(gateway.id, { configuration });
      gateway.configuration = configuration;
    }
    await this.record(gateway, 'provisioned', address);
    this.logger.log(`provisioned inbound address for gateway ${gateway.id}: ${address}`);
  }

  /** Record the outcome on the gateway row and in the channel-event log. */
  private async record(
    gateway: Gateway,
    status: 'provisioned' | 'skipped' | 'failed',
    address: string | null,
    error?: string,
  ): Promise<void> {
    try {
      const metadata: Record<string, any> = {
        ...(gateway.metadata || {}),
        emailProvisioning: {
          status,
          address,
          error: error ?? null,
          at: new Date().toISOString(),
        },
      };
      await this.gatewayRepository.update(gateway.id, { metadata });
      gateway.metadata = metadata;
    } catch (err: any) {
      this.logger.warn(`failed to record email provisioning on gateway: ${err?.message ?? err}`);
    }
    try {
      await this.eventRepository.save(
        this.eventRepository.create({
          organizationId: gateway.organizationId,
          gatewayId: gateway.id,
          channelType: gateway.type,
          direction: 'outbound',
          status: status === 'failed' ? 'failed' : 'processed',
          payload: { kind: 'email_provisioning', status, address },
          errorMessage: error ?? null,
          runId: null,
        }),
      );
    } catch (err: any) {
      this.logger.warn(`failed to log email provisioning event: ${err?.message ?? err}`);
    }
  }
}
