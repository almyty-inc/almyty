/**
 * Base adapter pattern for all interface types.
 * Each adapter normalizes inbound messages and formats outbound responses.
 */

import {
  assertOutboundUrlAllowed,
  ssrfSafeDispatcher,
} from '../../../../common/security/safe-fetch';
export interface NormalizedMessage {
  text: string;
  userId: string;
  threadId?: string;
  attachments?: Array<{ url: string; type: string; name: string }>;
  metadata?: Record<string, any>;
}

export interface AdapterResponse {
  text: string;
  attachments?: Array<{ url: string; type: string; name: string }>;
  metadata?: Record<string, any>;
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
   * through undici (`httpAgent` does nothing for `fetch`), and a redirect
   * refused rather than followed.
   */
  protected egressInit<T extends Record<string, any>>(init: T): T {
    return { ...init, redirect: 'error', dispatcher: ssrfSafeDispatcher };
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
      const text = await res.text();
      return typeof text === 'string' ? text.trim().slice(0, limit) : '';
    } catch {
      return '';
    }
  }
}
