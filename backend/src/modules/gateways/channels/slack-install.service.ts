import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

import { Gateway, GatewayType } from '../../../entities/gateway.entity';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';
import { ChannelInstallationService } from './channel-installation.service';
import { ChannelInstallation } from '../../../entities/channel-installation.entity';

/** Bot scopes requested on install. */
export const SLACK_INSTALL_SCOPES = 'chat:write,app_mentions:read,im:history';

/** State nonces are valid for 10 minutes. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Slack OAuth v2 install flow for multi-workspace channel gateways.
 *
 * A Slack channel gateway configured with a `client_id` + `client_secret`
 * (the Slack app's own OAuth credentials, secret stored encrypted)
 * becomes installable into any customer workspace:
 *
 *   1. GET /gateways/:id/install/slack
 *      302 to slack.com/oauth/v2/authorize with the bot scopes and a
 *      signed, expiring `state` nonce bound to the gateway id.
 *   2. GET /gateways/:id/install/slack/callback?code&state
 *      verifies the state, exchanges the code via oauth.v2.access and
 *      stores a ChannelInstallation (team_id + encrypted bot token).
 *
 * The state is HMAC-SHA256 signed with a key derived from
 * ENCRYPTION_KEY, so no server-side session store is needed and a
 * forged/replayed-after-expiry callback is rejected.
 */
@Injectable()
export class SlackInstallService {
  private readonly logger = new Logger(SlackInstallService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly installationService: ChannelInstallationService,
    private readonly envelopeCrypto: EnvelopeCryptoService,
  ) {}

  // ---------------------------------------------------------------------------
  // State signing
  // ---------------------------------------------------------------------------

  private stateKey(): Buffer {
    const secret = process.env.ENCRYPTION_KEY || 'default-encryption-key-change-me!';
    return crypto.createHash('sha256').update(`slack-install-state:${secret}`).digest();
  }

  /** Signed, expiring nonce bound to the gateway id. */
  createState(gatewayId: string, now: number = Date.now()): string {
    const payload = Buffer.from(
      JSON.stringify({
        g: gatewayId,
        e: now + STATE_TTL_MS,
        n: crypto.randomBytes(16).toString('hex'),
      }),
    ).toString('base64url');
    const sig = crypto.createHmac('sha256', this.stateKey()).update(payload).digest('hex');
    return `${payload}.${sig}`;
  }

  /** True only for an untampered, unexpired state minted for this gateway. */
  verifyState(state: string, gatewayId: string, now: number = Date.now()): boolean {
    if (typeof state !== 'string') return false;
    const dot = state.lastIndexOf('.');
    if (dot <= 0) return false;
    const payload = state.slice(0, dot);
    const sig = state.slice(dot + 1);
    const expected = crypto.createHmac('sha256', this.stateKey()).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length) return false;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return parsed?.g === gatewayId && typeof parsed?.e === 'number' && parsed.e > now;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // OAuth flow
  // ---------------------------------------------------------------------------

  /**
   * The gateway's Slack app OAuth `client_id` (public, stored plaintext), or
   * throws 400 when the gateway isn't configured for multi-workspace installs.
   * Split from the secret so the authorize-URL path stays synchronous and
   * never touches the CMK.
   */
  getClientId(gateway: Gateway): string {
    const cfg = gateway.configuration || {};
    const clientId = cfg.client_id || cfg.clientId;
    const rawSecret = cfg.client_secret || cfg.clientSecret;
    if (!clientId || !rawSecret) {
      throw new BadRequestException(
        'This Slack channel is not configured for multi-workspace installs (client_id and client_secret required)',
      );
    }
    return String(clientId);
  }

  /**
   * The gateway's Slack app OAuth client credentials, or throws 400. The
   * `client_secret` is decrypted org-aware: a BYO-KMS org's secret is
   * unwrapped via the customer CMK, platform / plaintext values decrypt
   * exactly as before (prefix routing in EnvelopeCryptoService).
   */
  async getClientCredentials(
    gateway: Gateway,
  ): Promise<{ clientId: string; clientSecret: string }> {
    const cfg = gateway.configuration || {};
    const clientId = this.getClientId(gateway);
    const rawSecret = cfg.client_secret || cfg.clientSecret;
    const clientSecret = await this.envelopeCrypto.decryptForOrg(
      gateway.organizationId,
      String(rawSecret),
    );
    return { clientId, clientSecret };
  }

  isInstallable(gateway: Gateway): boolean {
    if (gateway.type !== GatewayType.SLACK) return false;
    const cfg = gateway.configuration || {};
    return !!(cfg.client_id || cfg.clientId) && !!(cfg.client_secret || cfg.clientSecret);
  }

  /** `<PUBLIC_API_URL|BASE_URL|requestBase>/gateways/:id/install/slack/callback` */
  buildRedirectUri(gateway: Gateway, requestBase?: string): string {
    const base = (
      this.configService.get<string>('PUBLIC_API_URL') ||
      this.configService.get<string>('BASE_URL') ||
      requestBase ||
      ''
    ).replace(/\/$/, '');
    return `${base}/gateways/${gateway.id}/install/slack/callback`;
  }

  /** The slack.com/oauth/v2/authorize URL the install endpoint 302s to. */
  buildAuthorizeUrl(gateway: Gateway, requestBase?: string): string {
    const clientId = this.getClientId(gateway);
    const params = new URLSearchParams({
      client_id: clientId,
      scope: SLACK_INSTALL_SCOPES,
      state: this.createState(gateway.id),
      redirect_uri: this.buildRedirectUri(gateway, requestBase),
    });
    return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
  }

  /**
   * Exchange the OAuth code (oauth.v2.access) and persist the
   * installation. Returns the stored installation (with team metadata).
   */
  async handleCallback(
    gateway: Gateway,
    code: string,
    state: string,
    requestBase?: string,
  ): Promise<ChannelInstallation> {
    if (!code) throw new BadRequestException('Missing code');
    if (!this.verifyState(state || '', gateway.id)) {
      throw new BadRequestException('Invalid or expired state');
    }

    const { clientId, clientSecret } = await this.getClientCredentials(gateway);

    const fetchImpl = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetchImpl as any)('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: this.buildRedirectUri(gateway, requestBase),
      }).toString(),
    });
    const json: any = await res.json().catch(() => ({}));

    if (!json?.ok || !json.access_token || !json.team?.id) {
      this.logger.warn(
        `slack oauth.v2.access failed for gateway ${gateway.id}: ${json?.error || `http ${res.status}`}`,
      );
      throw new BadRequestException(`Slack OAuth exchange failed: ${json?.error || 'unknown error'}`);
    }

    const installation = await this.installationService.upsert(gateway, {
      externalTenantId: json.team.id,
      credentials: { bot_token: json.access_token },
      metadata: {
        teamName: json.team.name || null,
        botUserId: json.bot_user_id || null,
        appId: json.app_id || null,
        scope: json.scope || null,
      },
    });

    this.logger.log(
      `slack workspace ${json.team.id} installed gateway ${gateway.id} (${json.team.name || 'unnamed team'})`,
    );
    return installation;
  }
}
