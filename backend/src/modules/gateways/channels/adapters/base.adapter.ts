/**
 * Base adapter pattern for all interface types.
 * Each adapter normalizes inbound messages and formats outbound responses.
 */

import {
  assertOutboundUrlAllowed,
  readCappedText,
  safeFetch,
  ssrfSafeDispatcher,
} from '../../../../common/security/safe-fetch';
import { parseMediaType } from '../../../files/media-type';

/** A platform's answer to a send is a status document; anything bigger is not read. */
const MAX_REPLY_BYTES = 1024 * 1024;
/** A send to a configured URL, start to finish. */
const SEND_TIMEOUT_MS = 30_000;

/**
 * One file someone sent, as the adapter found it in the delivery.
 *
 * How to get the bytes differs per platform, so the adapter records
 * whatever it has and its own `fetchAttachment` knows what to do with it:
 * a link (`url`, https only), a platform handle to look up first (`ref`:
 * a Telegram file_id, a WhatsApp media id, a Matrix mxc:// URI, a Signal
 * attachment id), or the bytes themselves when they came in the delivery
 * (`data`: an email's MIME part). `type`, `name` and `size` are what the
 * sender's side claims and are checked against the bytes before use.
 */
export interface InboundAttachment {
  url?: string;
  ref?: string;
  data?: Buffer;
  type: string;
  name: string;
  size?: number;
}

/** Who wrote a message, as the platform names them. */
export interface MessageSender {
  /** The platform's own id for the sender (the same value as `userId`). */
  id: string;
  /** Their display name on the platform, when the delivery carries one. */
  name?: string;
}

export interface NormalizedMessage {
  text: string;
  userId: string;
  threadId?: string;
  attachments?: InboundAttachment[];
  /**
   * The person who wrote, for a conversation that has several: the agent
   * reads each message there as "Name: text" (channel-speaker.ts).
   */
  sender?: MessageSender;
  /** The conversation has several people in it (a group, a channel, a room). */
  group?: boolean;
  metadata?: Record<string, any>;
}

/** A file to send with a reply: a public https link, its type and its name. */
export interface OutboundAttachment {
  url: string;
  type: string;
  name: string;
}

export interface AdapterResponse {
  text: string;
  attachments?: OutboundAttachment[];
  /**
   * The text with the media it links to taken out (reply-media.ts). An
   * adapter that sends `attachments` as media sends this instead of `text`,
   * so the person does not get the picture and the link to it; one that
   * sends text only keeps `text`, links and all.
   */
  textWithoutMedia?: string;
  metadata?: Record<string, any>;
}

/** The bytes of one fetched attachment and the type the platform served them as. */
export interface FetchedAttachment {
  bytes: Buffer;
  type?: string;
}

/** How much one attachment fetch may read, and for how long. */
export interface AttachmentFetchLimits {
  maxBytes: number;
  timeoutMs: number;
}

/**
 * A reply the platform did not accept.
 *
 * Raised by `sendResponse` so the dispatch path can tell a delivered
 * reply from a rejected one. The distinction is not academic: every
 * adapter used to swallow the platform's answer, so the outbound event
 * row said `processed` with no error whether Slack had posted the
 * message or answered `{ok: false, error: "not_in_channel"}`, and the
 * only record of a customer's unanswered question was a green row.
 *
 * `reason` carries the platform's own wording — its error code, its
 * message, its status — never our configuration, and never a token.
 */
export class ChannelSendError extends Error {
  constructor(
    readonly channel: string,
    readonly reason: string,
  ) {
    super(`${channel}: ${reason}`);
    this.name = 'ChannelSendError';
  }
}

export abstract class BaseAdapter {
  abstract readonly type: string;

  /**
   * Refuse an outbound target the server must not be made to request.
   *
   * Six adapters dial a URL out of `gateway.configuration` —
   * `webhook_url`, `callback_url`, `api_url`, `homeserver_url`,
   * `service_url` — and that configuration is whatever an org admin
   * typed. Nothing on the channel write path validated any of it, so a
   * gateway pointed at `http://169.254.169.254/` sent the agent's reply
   * there; the webhook adapter additionally put the response body into
   * its ChannelSendError, which made it a read primitive rather than a
   * blind one.
   *
   * The adapters that talk to a hard-coded vendor host (slack, telegram,
   * discord, sms, whatsapp, email) do not need this.
   */
  protected assertEgress(url: string): string {
    return assertOutboundUrlAllowed(url);
  }

  /**
   * The fetch init every gated adapter send shares: DNS pinned at connect
   * through undici (`httpAgent` does nothing for `fetch`), a redirect
   * refused rather than followed, and a deadline for the whole exchange
   * (undici's own timers are idle timers, reset by every byte).
   */
  protected egressInit<T extends Record<string, any>>(init: T): T {
    return {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(SEND_TIMEOUT_MS),
      redirect: 'error',
      dispatcher: ssrfSafeDispatcher,
    };
  }

  /**
   * Normalize an inbound message from the external platform
   */
  abstract normalizeInbound(rawPayload: any): NormalizedMessage;

  /**
   * Format an outbound response for the external platform
   */
  abstract formatOutbound(response: AdapterResponse): any;

  /**
   * Send a response back to the external platform.
   *
   * Contract: resolve ONLY when the platform accepted the message, and
   * throw `ChannelSendError` otherwise. Checking the transport is not
   * enough — Slack, Telegram and the Graph API answer HTTP 200 and put
   * their refusal in the body — so each adapter checks its platform's
   * own success signal as well, and puts the platform's error string in
   * the thrown reason.
   */
  abstract sendResponse(interfaceConfig: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void>;

  /**
   * Declared by the two adapters that genuinely have no inbound webhook
   * to verify: discord, whose inbound arrives over an authenticated
   * gateway websocket rather than HTTP, and the chat widget, which is
   * public by design. Nothing else may set it. Every other adapter
   * either verifies inbound or refuses it.
   */
  protected readonly inboundIsUnauthenticatedByDesign: boolean = false;

  /**
   * Verify that an inbound request really came from the platform it
   * claims to.
   *
   * Fails CLOSED. An adapter that does not override this refuses every
   * inbound request, and an adapter that overrides it must refuse when
   * its secret is unconfigured rather than waving the request through.
   * The previous default returned true, which meant a publicly
   * reachable gateway with no secret set accepted forged payloads from
   * anyone and ran the agent on them.
   */
  async verifyWebhook(_payload: any, _headers: Record<string, string>, _config: Record<string, any>, _rawBody?: string): Promise<boolean> {
    return this.inboundIsUnauthenticatedByDesign;
  }

  /**
   * Extract the external tenant id (workspace/org on the platform's
   * side — e.g. Slack team_id) from an inbound payload. Used to resolve
   * multi-workspace installations: when a gateway has installations,
   * the installation matching this id supplies the credentials for the
   * reply. Returning undefined (the default) keeps the gateway's own
   * single-workspace configuration.
   */
  extractTenantId(_rawPayload: any): string | undefined {
    return undefined;
  }

  /**
   * The platform's own id for THIS delivery, stable across retries.
   *
   * Every hosted platform here redelivers: Slack on any response slower
   * than three seconds, Telegram until the update is acknowledged,
   * Twilio and the Bot Framework on a dropped connection. A signature
   * check authenticates a redelivery, it does not recognize one, so the
   * pipeline needs the platform's id to tell a retry from a new message.
   *
   * Returning undefined (the default) means this channel offers nothing
   * stable to key on and the delivery is processed as new. Adapters must
   * NOT synthesize a key from the clock or a random value: a key that
   * differs between two deliveries of the same message is worse than no
   * key, because it looks like a guarantee and is not one.
   */
  deliveryId(_rawPayload: any, _headers?: Record<string, string>): string | undefined {
    return undefined;
  }

  /**
   * Whether this delivery is a message a person sent, to be answered.
   *
   * Most platforms post only messages to a channel webhook, and the
   * default says yes. The iMessage relays post everything to the one URL:
   * our own outbound echoes, delivery statuses and reactions. Answering
   * one of those would at best waste a run and at worst have the agent
   * reply to itself, so those adapters say no and the pipeline
   * acknowledges the delivery without starting anything.
   * Asked only after the delivery has been verified.
   */
  carriesMessage(_rawPayload: any): boolean {
    return true;
  }

  /**
   * The sender's display name, for the "Name: text" a group conversation
   * shows the agent (channel-speaker.ts). The default is what the delivery
   * carried; an adapter whose deliveries leave the name out, and whose API
   * can say it, looks it up. Asked only for a message in a group.
   */
  async senderName(normalized: NormalizedMessage, _config: Record<string, any>): Promise<string | undefined> {
    return normalized.sender?.name;
  }
  /**
   * The bytes of one file someone sent, fetched the way this platform
   * wants (channel-attachments.service.ts calls this, with its limits).
   *
   * The default takes a public https link and fetches it like any URL
   * someone else chose: through the egress guard, no credentials of ours,
   * a deadline and a size cap. An adapter whose files need its bot token,
   * or a lookup from a handle to a link first, overrides this; one whose
   * platform delivers no files never reaches it. Null means there is
   * nothing this adapter can fetch for that attachment.
   *
   * The link is never logged or put in an error: a signed CDN link is a
   * credential for the file, and a Telegram file link carries the bot token.
   */
  async fetchAttachment(
    attachment: InboundAttachment,
    _config: Record<string, any>,
    limits: AttachmentFetchLimits,
  ): Promise<FetchedAttachment | null> {
    if (!attachment.url || !/^https:\/\//i.test(attachment.url)) return null;
    return this.fetchBytes(attachment.url, limits);
  }

  /**
   * GET a file through the egress guard: https only, the address pinned at
   * connect, each redirect hop re-checked (and any Authorization header
   * dropped when a hop leaves the origin), a deadline for the whole
   * exchange and a cap on the body. Throws on a refusal or a non-2xx.
   */
  protected async fetchBytes(
    url: string,
    limits: AttachmentFetchLimits,
    headers?: Record<string, string>,
  ): Promise<FetchedAttachment> {
    const res = await safeFetch(url, {
      method: 'GET',
      ...(headers ? { headers } : {}),
      maxBytes: limits.maxBytes,
      timeoutMs: limits.timeoutMs,
      maxRedirects: 3,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`the file host answered HTTP ${res.status}`);
    }
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      type: parseMediaType(res.headers.get('content-type')) ?? undefined,
    };
  }

  /**
   * Whether a link a delivery handed over points at one of the platform's
   * own hosts. Checked before a credential goes with the request: the link
   * is in the payload, and only the platform's host gets the bot token.
   */
  protected static onHost(url: string | undefined, hosts: string[]): boolean {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return false;
      const host = parsed.hostname.toLowerCase();
      return hosts.some((h) => host === h || (h.startsWith('.') && host.endsWith(h)));
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Delivery confirmation
  // ---------------------------------------------------------------------

  /**
   * Refuse the send. Every adapter raises this instead of logging and
   * returning, because a caller that cannot tell a delivered reply from
   * a rejected one records "delivered" for both.
   */
  protected sendFailed(reason: string): never {
    throw new ChannelSendError(this.type, reason);
  }

  /**
   * Whether the transport itself refused the request.
   *
   * Only says yes when the response object actually carries a refusal.
   * A fetch shim that returns nothing useful is not evidence of failure,
   * and the platform's own body-level verdict — which is where Slack,
   * Telegram and the Graph API put it — is checked separately by each
   * adapter.
   */
  protected httpRejected(res: any): boolean {
    if (!res) return false;
    if (typeof res.ok === 'boolean') return !res.ok;
    if (typeof res.status === 'number') return res.status < 200 || res.status >= 300;
    return false;
  }

  /** The response's status, for an error message, or '?' when absent. */
  protected httpStatus(res: any): string {
    return typeof res?.status === 'number' ? String(res.status) : '?';
  }

  /**
   * The response body as JSON, for the platforms that answer with a
   * structured error document (Slack, Telegram, Graph, Twilio, Resend,
   * Matrix, Teams, Google Chat). Null when there is no readable JSON —
   * a proxy's HTML error page, say — and the caller then falls back to
   * the status code.
   */
  protected async readJsonBody(res: any): Promise<any> {
    if (typeof res?.json !== 'function') return null;
    try {
      // A real response is read through the cap: the other end of a
      // configured URL decides how much it sends.
      if (res instanceof Response) return JSON.parse(await readCappedText(res, MAX_REPLY_BYTES)) ?? null;
      return (await res.json()) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The response body as text, for the endpoints whose failures are not
   * JSON: the self-hosted signal-cli and IRC bridges and the generic
   * outbound webhook, where whatever the operator put behind the URL
   * answers. Truncated, because it goes into an event row an operator
   * reads, not a log sink.
   */
  protected async readTextBody(res: any, limit = 300): Promise<string> {
    if (typeof res?.text !== 'function') return '';
    try {
      const text = res instanceof Response ? await readCappedText(res, MAX_REPLY_BYTES) : await res.text();
      return typeof text === 'string' ? text.trim().slice(0, limit) : '';
    } catch {
      return '';
    }
  }
}
