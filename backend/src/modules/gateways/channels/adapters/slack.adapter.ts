import { Injectable, Logger } from '@nestjs/common';
import {
  BaseAdapter,
  NormalizedMessage,
  AdapterResponse,
  AttachmentFetchLimits,
  FetchedAttachment,
  InboundAttachment,
} from './base.adapter';
import { isImage, textWithMedia } from '../reply-media';
import * as crypto from 'crypto';
import { toSlackMrkdwn } from './channel-markdown';

@Injectable()
export class SlackAdapter extends BaseAdapter {
  private readonly logger = new Logger(SlackAdapter.name);
  readonly type = 'slack';

  /** Where Slack serves a file's bytes; only this host is sent the bot token. */
  static readonly FILE_HOSTS = ['files.slack.com'];
  /** Slack renders at most this many image blocks usefully in one message. */
  static readonly MAX_IMAGES = 5;
  /** A section block's text limit. */
  static readonly SECTION_CHARS = 3000;

  /** Display names looked up with users.info, per bot token and user, for an hour. */
  private readonly names = new Map<string, { name: string | undefined; at: number }>();
  private static readonly NAME_TTL_MS = 60 * 60 * 1000;
  private static readonly NAME_CACHE_MAX = 2000;

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const event = rawPayload.event || rawPayload;
    // A file shared into the conversation: its private download link, which
    // needs the bot token (and the files:read scope) to read.
    const files: InboundAttachment[] = (Array.isArray(event.files) ? event.files : [])
      .filter((f: any) => f && (f.url_private_download || f.url_private))
      .map((f: any) => ({
        url: f.url_private_download || f.url_private,
        type: typeof f.mimetype === 'string' ? f.mimetype : 'application/octet-stream',
        name: f.name || f.title || 'attachment',
        ...(typeof f.size === 'number' ? { size: f.size } : {}),
      }));
    const profile = event.user_profile;
    return {
      text: event.text || '',
      userId: event.user || 'unknown',
      threadId: event.thread_ts || event.ts,
      ...(files.length ? { attachments: files } : {}),
      ...(event.user
        ? { sender: { id: event.user, name: profile?.display_name || profile?.real_name || undefined } }
        : {}),
      group: SlackAdapter.isGroupConversation(event),
      metadata: { channel: event.channel, ts: event.ts, source: 'slack' },
    };
  }

  /**
   * A channel, a private channel or a group DM has several people in it; a
   * direct message has one. `channel_type` says so on message events; an
   * app_mention carries none, and its channel id's first letter does (D is
   * a direct message).
   */
  static isGroupConversation(event: any): boolean {
    if (typeof event?.channel_type === 'string') return event.channel_type !== 'im';
    return typeof event?.channel === 'string' && !event.channel.startsWith('D');
  }

  /** Slack's private file links take the bot token, and only on Slack's file host. */
  async fetchAttachment(
    attachment: InboundAttachment,
    config: Record<string, any>,
    limits: AttachmentFetchLimits,
  ): Promise<FetchedAttachment | null> {
    if (!config.bot_token || !BaseAdapter.onHost(attachment.url, SlackAdapter.FILE_HOSTS)) return null;
    return this.fetchBytes(attachment.url!, limits, { Authorization: `Bearer ${config.bot_token}` });
  }

  /**
   * The sender's display name when the event did not carry their profile:
   * users.info, with the bot token (users:read scope). Nothing when Slack
   * will not say; the message is then prefixed with a short id instead.
   */
  async senderName(normalized: NormalizedMessage, config: Record<string, any>): Promise<string | undefined> {
    const id = normalized.sender?.id;
    if (normalized.sender?.name || !id || !config.bot_token) return normalized.sender?.name;
    const key = `${crypto.createHash('sha256').update(String(config.bot_token)).digest('hex').slice(0, 16)}:${id}`;
    const cached = this.names.get(key);
    if (cached && Date.now() - cached.at < SlackAdapter.NAME_TTL_MS) return cached.name;
    let name: string | undefined;
    try {
      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      const res = await (fetch as any)(`https://slack.com/api/users.info?user=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${config.bot_token}` },
        signal: AbortSignal.timeout(5_000),
      });
      const body = await this.readJsonBody(res);
      if (body?.ok === true) {
        const profile = body.user?.profile;
        name = profile?.display_name || profile?.real_name || body.user?.real_name || body.user?.name || undefined;
      }
    } catch {
      // A name is a nicety; the short id stands in.
    }
    if (this.names.size >= SlackAdapter.NAME_CACHE_MAX) this.names.clear();
    this.names.set(key, { name, at: Date.now() });
    return name;
  }

  /**
   * The channels the bot is in, for picking where a scheduled result goes:
   * conversations.list with the bot token (channels:read, and groups:read
   * for private channels). Empty when Slack will not say -- a missing
   * scope, a revoked token -- and the page then offers the channels the
   * bot has been written to in, and a box to type an ID.
   */
  async listChannels(config: Record<string, any>): Promise<Array<{ id: string; name: string }>> {
    if (!config.bot_token) return [];
    try {
      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      const res = await (fetch as any)(
        'https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200',
        { headers: { Authorization: `Bearer ${config.bot_token}` }, signal: AbortSignal.timeout(5_000) },
      );
      const body = await this.readJsonBody(res);
      if (body?.ok !== true || !Array.isArray(body.channels)) return [];
      return body.channels
        .filter((c: any) => c && typeof c.id === 'string' && c.is_member !== false)
        .map((c: any) => ({ id: c.id, name: typeof c.name === 'string' ? c.name : c.id }));
    } catch {
      return [];
    }
  }

  /**
   * Slack's `event_id` is the envelope id and is identical on every
   * retry of the same event (the retry also carries
   * X-Slack-Retry-Num). `channel:ts` is the message's own identity and
   * covers the socket-mode shape, which has no envelope.
   */
  deliveryId(rawPayload: any): string | undefined {
    if (rawPayload?.event_id) return `slack:${rawPayload.event_id}`;
    const event = rawPayload?.event ?? rawPayload;
    if (event?.ts) return `slack:${event.channel ?? 'nochannel'}:${event.ts}`;
    return undefined;
  }

  /**
   * Images in the reply go as image blocks under the text, which Slack
   * fetches from their links; a PDF or other file stays a link, since Slack
   * takes those only as an upload.
   */
  formatOutbound(response: AdapterResponse): any {
    const images = (response.attachments ?? []).filter(isImage).slice(0, SlackAdapter.MAX_IMAGES);
    // The agent writes markdown; Slack shows its own mrkdwn (**b** would arrive as text).
    const text = toSlackMrkdwn(textWithMedia(response, images));
    if (!images.length) return { text };
    const sections: any[] = [];
    for (let i = 0; i < text.length; i += SlackAdapter.SECTION_CHARS) {
      sections.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(i, i + SlackAdapter.SECTION_CHARS) } });
    }
    return {
      text,
      blocks: [
        ...sections,
        ...images.map((image) => ({ type: 'image', image_url: image.url, alt_text: (image.name || 'image').slice(0, 2000) })),
      ],
    };
  }

  /**
   * Post the reply with chat.postMessage.
   *
   * Slack's Web API answers HTTP 200 on a refusal and puts the verdict
   * in the body: `{ok: true, ts, channel}` when the message was posted,
   * `{ok: false, error: "not_in_channel" | "channel_not_found" |
   * "invalid_auth" | ...}` when it was not. So `res.ok` alone proves
   * nothing and `json.ok` is the contract — the same field
   * `testConnection` reads off auth.test.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.bot_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: threadContext?.channel,
        text: formattedResponse.text,
        thread_ts: threadContext?.threadId,
        // Images the reply carries, as image blocks (formatOutbound).
        ...(Array.isArray(formattedResponse.blocks) ? { blocks: formattedResponse.blocks } : {}),
      }),
    });

    const body = await this.readJsonBody(res);
    if (this.httpRejected(res)) {
      this.sendFailed(
        `chat.postMessage returned HTTP ${this.httpStatus(res)}${body?.error ? ` (${body.error})` : ''}`,
      );
    }
    if (body?.ok !== true) {
      // The platform's own word for what went wrong is the only thing
      // that tells an operator "the bot is not in that channel" rather
      // than "something happened".
      const detail = body?.error ?? 'chat.postMessage did not confirm the post';
      const hint = body?.response_metadata?.messages?.[0];
      this.sendFailed(`chat.postMessage refused the reply: ${detail}${hint ? ` (${hint})` : ''}`);
    }
  }

  /**
   * Slack requires a replay window and we did not have one.
   *
   * A signature authenticates a request; it does not date it. Without a
   * freshness check a captured Slack delivery stays valid until the
   * signing secret is rotated, and the delivery claim does not close the
   * gap: slash commands and interactive payloads carry neither
   * `event_id` nor `event.ts`, so `deliveryId` returns undefined for
   * them and every replay is processed as a new message — a new agent
   * run, a new LLM bill, each time. Slack's own guidance is to refuse
   * anything more than five minutes from now. Same tolerance as
   * SVIX_TIMESTAMP_TOLERANCE_SECONDS, which already did this correctly
   * one file over.
   */
  static readonly TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>, rawBody?: string): Promise<boolean> {
    // Fail closed: an unconfigured signing secret means we cannot tell a
    // real Slack event from a forged one, so we refuse rather than run
    // the agent on it.
    if (!config.signing_secret) return false;
    const timestamp = headers['x-slack-request-timestamp'];
    const signature = headers['x-slack-signature'];
    if (!timestamp || !signature) return false;

    // Age before HMAC: a stale timestamp is a refusal whatever it is
    // signed with, and refusing here means the replay never reaches the
    // pipeline rather than depending on the dedupe claim to notice it.
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(Date.now() / 1000 - ts) > SlackAdapter.TIMESTAMP_TOLERANCE_SECONDS) return false;

    const sigBasestring = `v0:${timestamp}:${rawBody ?? JSON.stringify(payload)}`;
    const mySignature = 'v0=' + crypto.createHmac('sha256', config.signing_secret).update(sigBasestring).digest('hex');
    // timingSafeEqual throws on a length mismatch, which a forged header
    // can trivially cause — compare lengths first so a bad signature is
    // a rejection rather than a 500.
    const a = Buffer.from(mySignature);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Slack event payloads carry the workspace (team) id at the top level
   * (`team_id`), and events forwarded from other workspaces carry it on
   * the event itself (`event.team`). Used to resolve multi-workspace
   * installations to the installing workspace's own bot token.
   */
  extractTenantId(rawPayload: any): string | undefined {
    return (
      rawPayload?.team_id ||
      rawPayload?.event?.team ||
      rawPayload?.team?.id ||
      undefined
    );
  }
}