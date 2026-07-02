import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import * as crypto from 'crypto';

@Injectable()
export class MicrosoftTeamsAdapter extends BaseAdapter {
  private readonly logger = new Logger(MicrosoftTeamsAdapter.name);
  readonly type = 'microsoft_teams';

  /** Bot Framework OpenID metadata document (points at the JWKS). */
  static readonly OPENID_METADATA_URL =
    'https://login.botframework.com/v1/.well-known/openidconfiguration';
  /** Issuer the Bot Framework Connector stamps on activity JWTs. */
  static readonly BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';
  /** Bot Framework signing keys rotate rarely; cache for 24h. */
  static readonly JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  /** Floor between JWKS refetches so unknown kids can't hammer the endpoint. */
  static readonly JWKS_REFRESH_FLOOR_MS = 60 * 1000;
  /** Clock-skew tolerance for exp/nbf, in seconds. */
  static readonly CLOCK_SKEW_SEC = 300;

  private jwksKeys = new Map<string, crypto.KeyObject>();
  private jwksFetchedAt = 0;

  normalizeInbound(rawPayload: any): NormalizedMessage {
    // Bot Framework activity format
    const activity = rawPayload;
    return {
      text: activity.text || '',
      userId: activity.from?.id || activity.from?.aadObjectId || 'unknown',
      threadId: activity.conversation?.id || undefined,
      metadata: {
        activityId: activity.id,
        conversationId: activity.conversation?.id,
        channelId: activity.channelId,
        serviceUrl: activity.serviceUrl,
        tenantId: activity.channelData?.tenant?.id,
        source: 'microsoft_teams',
      },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return {
      type: 'message',
      text: response.text,
    };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    try {
      const serviceUrl = threadContext?.metadata?.serviceUrl || config.service_url;
      const conversationId = threadContext?.metadata?.conversationId || threadContext?.threadId;

      if (!serviceUrl || !conversationId) {
        this.logger.warn('Microsoft Teams: missing serviceUrl or conversationId');
        return;
      }

      // Get access token using bot credentials
      const token = await this.getAccessToken(config.bot_id, config.bot_password);
      if (!token) {
        this.logger.error('Microsoft Teams: failed to get access token');
        return;
      }

      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      const url = `${serviceUrl}/v3/conversations/${conversationId}/activities`;
      await (fetch as any)(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formattedResponse),
      });
    } catch (error) {
      this.logger.error(`Microsoft Teams send failed: ${error.message}`);
    }
  }

  /**
   * Verify the Bot Framework JWT the Connector sends with every inbound
   * activity (Authorization: Bearer <RS256 JWT>):
   *   - issuer must be https://api.botframework.com
   *   - audience must equal the bot's app id (config.bot_id)
   *   - exp/nbf honored with 5-minute skew
   *   - signature checked against the Bot Framework OpenID metadata
   *     JWKS (fetched once, cached for 24h)
   * Requires `bot_id`; without it the audience cannot be validated, so
   * verification is skipped (config is incomplete for sending anyway).
   */
  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>): Promise<boolean> {
    if (!config.bot_id) return true;

    const authz = headers['authorization'] || (headers as any)['Authorization'] || '';
    if (!authz.startsWith('Bearer ')) return false;
    const token = authz.slice(7).trim();

    try {
      const [headerB64, claimsB64, sigB64] = token.split('.');
      if (!headerB64 || !claimsB64 || !sigB64) return false;

      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8'));
      const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString('utf-8'));

      if (header.alg !== 'RS256') return false;
      if (claims.iss !== MicrosoftTeamsAdapter.BOT_FRAMEWORK_ISSUER) return false;

      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audience.includes(config.bot_id)) return false;

      const now = Math.floor(Date.now() / 1000);
      const skew = MicrosoftTeamsAdapter.CLOCK_SKEW_SEC;
      if (typeof claims.exp === 'number' && now > claims.exp + skew) return false;
      if (typeof claims.nbf === 'number' && now < claims.nbf - skew) return false;

      const key = await this.getSigningKey(header.kid);
      if (!key) return false;

      return crypto.verify(
        'RSA-SHA256',
        Buffer.from(`${headerB64}.${claimsB64}`),
        key,
        Buffer.from(sigB64, 'base64url'),
      );
    } catch (err) {
      this.logger.warn(`Teams JWT verification error: ${err.message}`);
      return false;
    }
  }

  /**
   * Resolve an RSA public key by kid from the (cached) Bot Framework
   * JWKS. Refetches when the cache is expired or the kid is unknown
   * (key rotation), but never more than once per minute.
   */
  private async getSigningKey(kid: string | undefined): Promise<crypto.KeyObject | null> {
    if (!kid) return null;
    const now = Date.now();
    const cacheExpired = now - this.jwksFetchedAt > MicrosoftTeamsAdapter.JWKS_CACHE_TTL_MS;
    const needsKey = cacheExpired || !this.jwksKeys.has(kid);
    const refreshAllowed = cacheExpired || now - this.jwksFetchedAt > MicrosoftTeamsAdapter.JWKS_REFRESH_FLOOR_MS;
    if (needsKey && refreshAllowed) {
      await this.loadJwks();
    }
    return this.jwksKeys.get(kid) ?? null;
  }

  /** Fetch the OpenID metadata, follow jwks_uri, import the RSA keys. */
  private async loadJwks(): Promise<void> {
    try {
      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      const metaRes = await (fetch as any)(MicrosoftTeamsAdapter.OPENID_METADATA_URL);
      const meta = await metaRes.json();
      if (!meta?.jwks_uri) {
        this.logger.warn('Bot Framework OpenID metadata missing jwks_uri');
        return;
      }
      const jwksRes = await (fetch as any)(meta.jwks_uri);
      const jwks = await jwksRes.json();

      const next = new Map<string, crypto.KeyObject>();
      for (const jwk of jwks?.keys ?? []) {
        if (!jwk?.kid || jwk.kty !== 'RSA') continue;
        try {
          next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
        } catch {
          // skip malformed keys — better a partial keyset than none
        }
      }
      if (next.size > 0) this.jwksKeys = next;
    } catch (err) {
      this.logger.warn(`Failed to load Bot Framework JWKS: ${err.message}`);
    } finally {
      // Stamp even on failure so a broken endpoint is retried at most
      // once per refresh floor, not on every inbound request.
      this.jwksFetchedAt = Date.now();
    }
  }

  private async getAccessToken(botId: string, botPassword: string): Promise<string | null> {
    try {
      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      const res = await (fetch as any)('https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: botId,
          client_secret: botPassword,
          scope: 'https://api.botframework.com/.default',
        }).toString(),
      });
      const data = await res.json();
      return data.access_token || null;
    } catch (err) {
      this.logger.error(`Failed to get Teams access token: ${err.message}`);
      return null;
    }
  }
}