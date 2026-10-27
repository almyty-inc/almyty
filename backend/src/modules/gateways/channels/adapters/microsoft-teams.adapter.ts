import { Injectable, Logger } from '@nestjs/common';
import {
  ActionPress,
  BaseAdapter,
  NormalizedMessage,
  AdapterResponse,
  AttachmentFetchLimits,
  FetchedAttachment,
  InboundAttachment,
} from './base.adapter';
import { isImage, textWithMedia } from '../reply-media';
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
    const attachments = MicrosoftTeamsAdapter.attachmentsOf(activity);
    const from = activity.from;
    const senderId = from?.id || from?.aadObjectId;
    return {
      text: activity.text || '',
      userId: activity.from?.id || activity.from?.aadObjectId || 'unknown',
      threadId: activity.conversation?.id || undefined,
      ...(attachments.length ? { attachments } : {}),
      ...(senderId ? { sender: { id: senderId, name: from?.name || undefined } } : {}),
      // A group chat or a team channel has several people in it; a personal chat has one.
      group: ['groupChat', 'channel'].includes(activity.conversation?.conversationType) || activity.conversation?.isGroup === true,
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

  /**
   * Files on a Teams activity. An image pasted into the message is an
   * attachment with an image content type and a `contentUrl` on the Bot
   * Framework's attachment service, read with the bot's token. A file
   * shared in a personal chat is a `file.download.info` card whose
   * `downloadUrl` is a pre-authorized SharePoint link, read with nothing.
   * The `text/html` copy of the message itself is not a file.
   */
  static attachmentsOf(activity: any): InboundAttachment[] {
    const out: InboundAttachment[] = [];
    for (const a of Array.isArray(activity?.attachments) ? activity.attachments : []) {
      if (a?.contentType === 'application/vnd.microsoft.teams.file.download.info' && a.content?.downloadUrl) {
        out.push({ url: a.content.downloadUrl, ref: 'download', type: 'application/octet-stream', name: a.name || 'attachment' });
      } else if (typeof a?.contentType === 'string' && a.contentType.startsWith('image/') && a.contentUrl) {
        out.push({ url: a.contentUrl, ref: 'inline', type: a.contentType, name: a.name || 'image' });
      }
    }
    return out;
  }

  /** The Bot Framework's attachment service, which takes the bot token. */
  static readonly INLINE_HOSTS = ['smba.trafficmanager.net', '.botframework.com', '.asm.skype.com'];
  /** Where a shared file's pre-authorized download link points. */
  static readonly DOWNLOAD_HOSTS = ['.sharepoint.com'];

  async fetchAttachment(
    attachment: InboundAttachment,
    config: Record<string, any>,
    limits: AttachmentFetchLimits,
  ): Promise<FetchedAttachment | null> {
    if (attachment.ref === 'download') {
      if (!BaseAdapter.onHost(attachment.url, MicrosoftTeamsAdapter.DOWNLOAD_HOSTS)) return null;
      return this.fetchBytes(attachment.url!, limits);
    }
    if (!BaseAdapter.onHost(attachment.url, MicrosoftTeamsAdapter.INLINE_HOSTS)) return null;
    const token = config.bot_id && config.bot_password ? await this.getAccessToken(config.bot_id, config.bot_password) : null;
    if (!token) return null;
    return this.fetchBytes(attachment.url!, limits, { Authorization: `Bearer ${token}` });
  }

  /** The Bot Framework activity id, stable across a retried POST. */
  deliveryId(rawPayload: any): string | undefined {
    return rawPayload?.id ? `microsoft_teams:${rawPayload.id}` : undefined;
  }

  /**
   * Images go as attachments Teams shows in the message, by link. A PDF or
   * other file would need the file-consent flow, so it stays a link.
   * Buttons (Approve, Reject) go as an Adaptive Card with the text in its
   * body and one Action.Submit per button, its data naming the action.
   */
  formatOutbound(response: AdapterResponse): any {
    const images = (response.attachments ?? []).filter(isImage).slice(0, MicrosoftTeamsAdapter.MAX_IMAGES);
    const text = textWithMedia(response, images);
    const card = MicrosoftTeamsAdapter.actionCard(text, response.actions);
    const attachments = [
      ...images.map((image) => ({ contentType: image.type, contentUrl: image.url, name: image.name })),
      ...(card ? [card] : []),
    ];
    if (card) return { type: 'message', attachments };
    return attachments.length ? { type: 'message', text, attachments } : { type: 'message', text };
  }

  /** The key an Action.Submit's data carries the action under. */
  static readonly ACTION_KEY = 'almytyAction';

  /**
   * The text as TextBlocks, one per line: a card's markdown folds single
   * line breaks, which would run an email's To, Subject and text together.
   * A blank line becomes space above the next block.
   */
  static textBlocks(text: string): any[] {
    const blocks: any[] = [];
    let gap = false;
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        gap = blocks.length > 0;
        continue;
      }
      blocks.push({ type: 'TextBlock', text: line, wrap: true, spacing: blocks.length === 0 ? 'None' : gap ? 'Medium' : 'None' });
      gap = false;
    }
    return blocks.length ? blocks : [{ type: 'TextBlock', text: '', wrap: true }];
  }
  /** An Adaptive Card with the text and a button per action, or null when there are no actions. */
  static actionCard(text: string, actions: AdapterResponse['actions']): any | null {
    const buttons = (actions ?? []).filter((a) => a && typeof a.id === 'string');
    if (!buttons.length) return null;
    return {
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4',
        body: MicrosoftTeamsAdapter.textBlocks(text),
        actions: buttons.map((a) => ({
          type: 'Action.Submit',
          title: a.label,
          data: { [MicrosoftTeamsAdapter.ACTION_KEY]: a.id },
          ...(a.style === 'primary' ? { style: 'positive' } : a.style === 'danger' ? { style: 'destructive' } : {}),
        })),
      },
    };
  }

  /**
   * A pressed card button: Teams posts it as a message activity whose
   * `value` is the Action.Submit's data, on the same messaging endpoint
   * and with the same Bot Framework token as any message.
   */
  actionOf(rawPayload: any): ActionPress | null {
    const value = rawPayload?.value;
    const data = value && typeof value === 'object' ? value[MicrosoftTeamsAdapter.ACTION_KEY] : undefined;
    const userId = rawPayload?.from?.id || rawPayload?.from?.aadObjectId;
    if (rawPayload?.type !== 'message' || typeof data !== 'string' || !userId) return null;
    return {
      data,
      userId,
      userName: rawPayload.from?.name || undefined,
      group: ['groupChat', 'channel'].includes(rawPayload.conversation?.conversationType) || rawPayload.conversation?.isGroup === true,
      context: {
        serviceUrl: rawPayload.serviceUrl,
        conversationId: rawPayload.conversation?.id,
        replyToId: rawPayload.replyToId,
      },
    };
  }

  /**
   * Answer in the conversation the card is in. Teams has no answer only
   * the presser sees for a submit, so a refusal is said there too; settled,
   * the card is replaced by its outcome so it cannot be pressed again.
   */
  async answerAction(config: Record<string, any>, press: ActionPress, text: string, settled: boolean): Promise<void> {
    const metadata = { serviceUrl: press.context?.serviceUrl, conversationId: press.context?.conversationId };
    await this.sendResponse(config, { type: 'message', text }, { metadata });
    if (!settled || !press.context?.replyToId) return;
    await this.updateActivity(config, metadata, String(press.context.replyToId), { type: 'message', text }).catch(() => undefined);
  }

  /** Replace an activity the bot posted (PUT on the conversation's activity). */
  private async updateActivity(
    config: Record<string, any>,
    metadata: { serviceUrl?: string; conversationId?: string },
    activityId: string,
    activity: any,
  ): Promise<void> {
    if (!metadata.serviceUrl || !metadata.conversationId) return;
    const token = await this.getAccessToken(config.bot_id, config.bot_password);
    if (!token) return;
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const url = `${metadata.serviceUrl}/v3/conversations/${metadata.conversationId}/activities/${encodeURIComponent(activityId)}`;
    this.assertEgress(url);
    const res = await (fetch as any)(url, this.egressInit({
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...activity, id: activityId }),
    }));
    if (this.httpRejected(res)) this.sendFailed(`the Bot Framework refused the update: HTTP ${this.httpStatus(res)}`);
  }

  /** Images one reply shows. */
  static readonly MAX_IMAGES = 5;

  /**
   * Post the reply as an activity on the conversation.
   *
   * The Bot Framework Connector is HTTP-shaped: 200/201 with a
   * ResourceResponse `{id}` on success, and a 4xx carrying
   * `{error: {code, message}}` on failure — 401 `Unauthorized` on a
   * rotated bot password, 403 `BotDisabledByAdmin`, 404 once the
   * conversation is gone. So the status is the verdict and
   * `error.message`/`error.code` are the wording to keep.
   *
   * A missing serviceUrl or conversationId, and a token request the
   * Connector refused, are refusals as well: in each case no activity
   * was posted, and saying so is the difference between a diagnosable
   * gateway and a silent one.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const serviceUrl = threadContext?.metadata?.serviceUrl || config.service_url;
    const conversationId = threadContext?.metadata?.conversationId || threadContext?.threadId;

    if (!serviceUrl || !conversationId) {
      this.sendFailed(
        `the activity carried no ${!serviceUrl ? 'serviceUrl' : 'conversationId'} to reply on`,
      );
    }

    // Get access token using bot credentials
    const token = await this.getAccessToken(config.bot_id, config.bot_password);
    if (!token) {
      this.sendFailed('the Bot Framework would not issue an access token for these bot credentials');
    }

    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const url = `${serviceUrl}/v3/conversations/${conversationId}/activities`;
    this.assertEgress(url);
    const res = await (fetch as any)(url, this.egressInit({
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(formattedResponse),
    }));

    const answer = await this.readJsonBody(res);
    const error = answer?.error;
    if (this.httpRejected(res) || error) {
      const detail = error?.message ?? `HTTP ${this.httpStatus(res)}`;
      this.sendFailed(
        `the Bot Framework refused the reply: ${detail}${error?.code ? ` (${error.code})` : ''}`,
      );
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
    // Fail closed: bot_id is the audience the Bot Framework JWT is
    // checked against, so without it there is nothing to verify the
    // activity came from Teams rather than from anyone with the URL.
    if (!config.bot_id) return false;

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