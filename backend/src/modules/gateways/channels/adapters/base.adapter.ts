/**
 * Base adapter pattern for all interface types.
 * Each adapter normalizes inbound messages and formats outbound responses.
 */
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

export abstract class BaseAdapter {
  abstract readonly type: string;

  /**
   * Normalize an inbound message from the external platform
   */
  abstract normalizeInbound(rawPayload: any): NormalizedMessage;

  /**
   * Format an outbound response for the external platform
   */
  abstract formatOutbound(response: AdapterResponse): any;

  /**
   * Send a response back to the external platform
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
  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>, rawBody?: string): Promise<boolean> {
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
  extractTenantId(rawPayload: any): string | undefined {
    return undefined;
  }
}