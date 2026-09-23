import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import * as crypto from 'crypto';

@Injectable()
export class SlackAdapter extends BaseAdapter {
  private readonly logger = new Logger(SlackAdapter.name);
  readonly type = 'slack';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const event = rawPayload.event || rawPayload;
    return {
      text: event.text || '',
      userId: event.user || 'unknown',
      threadId: event.thread_ts || event.ts,
      metadata: { channel: event.channel, ts: event.ts, source: 'slack' },
    };
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

  formatOutbound(response: AdapterResponse): any {
    return { text: response.text };
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