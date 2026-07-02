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
   * Verify webhook signature/authenticity (optional)
   */
  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>, rawBody?: string): Promise<boolean> {
    return true; // Override in specific adapters
  }
}
