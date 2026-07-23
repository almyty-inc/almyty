import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';
import { ChannelEvent } from '../../../entities/channel-event.entity';
import { getChannelConfig } from './channel-config.helper';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';

/**
 * Automatic inbound-webhook registration for channel gateways whose
 * platform exposes an API for it. When an org deploys an agent to a
 * channel (gateway created/activated), the platform is pointed at the
 * gateway's public unified-endpoint URL automatically; on deactivate/
 * delete the registration is removed:
 *
 *   - telegram:        setWebhook / deleteWebhook (Bot API)
 *   - whatsapp (Twilio) and sms (Twilio): look up the IncomingPhoneNumber
 *     by phone_number and update its SmsUrl/SmsMethod (cleared on
 *     unregister)
 *
 * The public URL is `<PUBLIC_API_URL>/<orgSlug><gateway.endpoint>` —
 * the same /:orgSlug/:resourceSlug path the unified endpoint serves.
 * Without PUBLIC_API_URL registration is skipped with a warning (local
 * dev has no public inbound URL to register).
 *
 * Invoked from the GatewaysService CRUD seams the same way the
 * discord transport is (@Optional() injection, fire-and-forget):
 * registration must never fail a CRUD request. The outcome is
 * recorded on gateway.metadata.webhookRegistration and as a channel
 * event so operators can see whether a deploy actually wired up.
 *
 * On a successful Twilio registration, configuration.webhook_url is
 * set to the registered URL — the Twilio signature check needs the
 * exact signed URL, and after auto-registration that IS the public
 * unified-endpoint URL.
 */
@Injectable()
export class ChannelWebhookRegistrar {
  private readonly logger = new Logger(ChannelWebhookRegistrar.name);

  private static readonly REGISTRABLE_TYPES: ReadonlySet<GatewayType> = new Set([
    GatewayType.TELEGRAM,
    GatewayType.WHATSAPP,
    GatewayType.SMS,
  ]);

  constructor(
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(ChannelEvent)
    private readonly eventRepository: Repository<ChannelEvent>,
    private readonly configService: ConfigService,
    // Optional so positional unit tests can construct the registrar; when
    // present, warms a BYO-KMS org's DEK before the sync getChannelConfig
    // token reads below.
    @Optional() private readonly envelopeCrypto?: EnvelopeCryptoService,
  ) {}

  static isRegistrable(type: GatewayType): boolean {
    return ChannelWebhookRegistrar.REGISTRABLE_TYPES.has(type);
  }

  /**
   * Reconcile the platform webhook with the gateway state: active ->
   * register, anything else -> unregister. Never throws.
   */
  async sync(gateway: Gateway): Promise<void> {
    if (!ChannelWebhookRegistrar.isRegistrable(gateway.type)) return;
    try {
      if (gateway.status === GatewayStatus.ACTIVE) {
        await this.register(gateway);
      } else {
        await this.unregister(gateway);
      }
    } catch (err: any) {
      this.logger.warn(
        `webhook registration sync failed (gateway ${gateway.id}): ${err?.message ?? err}`,
      );
    }
  }

  /** Remove the platform webhook registration (gateway deleted). Never throws. */
  async remove(gateway: Gateway): Promise<void> {
    if (!ChannelWebhookRegistrar.isRegistrable(gateway.type)) return;
    try {
      await this.unregister(gateway, /* recordOnGateway */ false);
    } catch (err: any) {
      this.logger.warn(
        `webhook unregistration failed (gateway ${gateway.id}): ${err?.message ?? err}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Register / unregister
  // ---------------------------------------------------------------------------

  private async register(gateway: Gateway): Promise<void> {
    // Warm the org's DEK so the sync getChannelConfig token reads below can
    // unwrap a BYO-KMS gateway's `encrypted:kms:` secrets (no-op otherwise).
    await this.envelopeCrypto?.warmOrg(gateway.organizationId);
    const publicUrl = await this.buildPublicUrl(gateway);
    if (!publicUrl) {
      await this.record(gateway, 'register', 'skipped', null, 'PUBLIC_API_URL not configured');
      return;
    }

    try {
      switch (gateway.type) {
        case GatewayType.TELEGRAM:
          await this.telegramSetWebhook(gateway, publicUrl);
          break;
        case GatewayType.WHATSAPP:
        case GatewayType.SMS:
          await this.twilioSetWebhook(gateway, publicUrl);
          // The Twilio signature covers the exact URL it calls — keep
          // the adapter's verification config in lockstep.
          await this.persistConfig(gateway, { webhook_url: publicUrl });
          break;
      }
      await this.record(gateway, 'register', 'registered', publicUrl);
      this.logger.log(`registered ${gateway.type} webhook for gateway ${gateway.id}: ${publicUrl}`);
    } catch (err: any) {
      await this.record(gateway, 'register', 'failed', publicUrl, err?.message ?? String(err));
      this.logger.warn(
        `webhook registration failed (gateway ${gateway.id}, ${gateway.type}): ${err?.message ?? err}`,
      );
    }
  }

  private async unregister(gateway: Gateway, recordOnGateway = true): Promise<void> {
    // Warm the org's DEK before the sync getChannelConfig token reads.
    await this.envelopeCrypto?.warmOrg(gateway.organizationId);
    try {
      switch (gateway.type) {
        case GatewayType.TELEGRAM:
          await this.telegramDeleteWebhook(gateway);
          break;
        case GatewayType.WHATSAPP:
        case GatewayType.SMS:
          await this.twilioSetWebhook(gateway, '');
          break;
      }
      if (recordOnGateway) {
        await this.record(gateway, 'unregister', 'unregistered', null);
      }
      this.logger.log(`unregistered ${gateway.type} webhook for gateway ${gateway.id}`);
    } catch (err: any) {
      if (recordOnGateway) {
        await this.record(gateway, 'unregister', 'failed', null, err?.message ?? String(err));
      }
      this.logger.warn(
        `webhook unregistration failed (gateway ${gateway.id}, ${gateway.type}): ${err?.message ?? err}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Platform calls
  // ---------------------------------------------------------------------------

  private async telegramSetWebhook(gateway: Gateway, publicUrl: string): Promise<void> {
    const token = getChannelConfig(gateway.configuration, gateway.organizationId).bot_token;
    if (!token) throw new Error('bot_token not configured');
    const res = await this.fetch(
      `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(publicUrl)}`,
      { method: 'POST' },
    );
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok === false) {
      throw new Error(json?.description || `setWebhook failed (${res.status})`);
    }
  }

  private async telegramDeleteWebhook(gateway: Gateway): Promise<void> {
    const token = getChannelConfig(gateway.configuration, gateway.organizationId).bot_token;
    if (!token) throw new Error('bot_token not configured');
    const res = await this.fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
      method: 'POST',
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok === false) {
      throw new Error(json?.description || `deleteWebhook failed (${res.status})`);
    }
  }

  /**
   * Point the Twilio number's inbound message webhook at `url`
   * (empty string clears it). Two-step: resolve the IncomingPhoneNumber
   * SID for the configured phone_number, then update its SmsUrl.
   */
  private async twilioSetWebhook(gateway: Gateway, url: string): Promise<void> {
    const cfg = getChannelConfig(gateway.configuration, gateway.organizationId);
    const accountSid = cfg.twilio_account_sid;
    const authToken = cfg.twilio_auth_token;
    const phoneNumber = cfg.phone_number;
    if (!accountSid || !authToken || !phoneNumber) {
      throw new Error('twilio_account_sid, twilio_auth_token and phone_number are required');
    }
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const lookupRes = await this.fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`,
      { headers: { Authorization: `Basic ${auth}` } },
    );
    if (!lookupRes.ok) {
      throw new Error(`twilio number lookup failed (${lookupRes.status})`);
    }
    const lookup: any = await lookupRes.json().catch(() => ({}));
    const numberSid = lookup?.incoming_phone_numbers?.[0]?.sid;
    if (!numberSid) {
      throw new Error(`phone number ${phoneNumber} not found on twilio account`);
    }

    const updateRes = await this.fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${numberSid}.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ SmsUrl: url, SmsMethod: 'POST' }).toString(),
      },
    );
    if (!updateRes.ok) {
      throw new Error(`twilio webhook update failed (${updateRes.status})`);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * `<PUBLIC_API_URL>/<orgSlug><endpoint>` — the unified-endpoint URL
   * platforms deliver webhooks to. Null (-> skip + warning) when
   * PUBLIC_API_URL or the org slug is unavailable.
   */
  private async buildPublicUrl(gateway: Gateway): Promise<string | null> {
    const base = (this.configService.get<string>('PUBLIC_API_URL') || '').replace(/\/$/, '');
    if (!base) {
      this.logger.warn(
        `PUBLIC_API_URL is not set — skipping webhook registration for gateway ${gateway.id}`,
      );
      return null;
    }
    const org = await this.organizationRepository.findOne({
      where: { id: gateway.organizationId },
    });
    const slug = (org as any)?.slug;
    if (!slug) {
      this.logger.warn(
        `organization ${gateway.organizationId} has no slug — skipping webhook registration for gateway ${gateway.id}`,
      );
      return null;
    }
    const endpoint = gateway.endpoint?.startsWith('/') ? gateway.endpoint : `/${gateway.endpoint}`;
    return `${base}/${slug}${endpoint}`;
  }

  /** Record the outcome on the gateway row and in the channel-event log. */
  private async record(
    gateway: Gateway,
    action: 'register' | 'unregister',
    status: 'registered' | 'unregistered' | 'failed' | 'skipped',
    url: string | null,
    error?: string,
  ): Promise<void> {
    try {
      const metadata: Record<string, any> = {
        ...(gateway.metadata || {}),
        webhookRegistration: {
          action,
          status,
          url,
          error: error ?? null,
          at: new Date().toISOString(),
        },
      };
      await this.gatewayRepository.update(gateway.id, { metadata });
    } catch (err: any) {
      this.logger.warn(`failed to record webhook registration on gateway: ${err?.message ?? err}`);
    }
    try {
      await this.eventRepository.save(
        this.eventRepository.create({
          organizationId: gateway.organizationId,
          gatewayId: gateway.id,
          channelType: gateway.type,
          direction: 'outbound',
          status: status === 'failed' ? 'failed' : 'processed',
          payload: { kind: 'webhook_registration', action, status, url },
          errorMessage: error ?? null,
          runId: null,
        }),
      );
    } catch (err: any) {
      this.logger.warn(`failed to log webhook registration event: ${err?.message ?? err}`);
    }
  }

  private async persistConfig(gateway: Gateway, patch: Record<string, any>): Promise<void> {
    try {
      const configuration = { ...(gateway.configuration || {}), ...patch };
      await this.gatewayRepository.update(gateway.id, { configuration });
      gateway.configuration = configuration;
    } catch (err: any) {
      this.logger.warn(`failed to persist webhook_url on gateway config: ${err?.message ?? err}`);
    }
  }

  private async fetch(url: string, init?: any): Promise<any> {
    const fetchImpl = globalThis.fetch || (await import('node-fetch')).default;
    return (fetchImpl as any)(url, init);
  }
}
