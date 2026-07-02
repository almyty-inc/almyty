import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';

/**
 * Signal via a self-hosted signal-cli REST bridge
 * (https://github.com/bbernhard/signal-cli-rest-api). almyty does not
 * speak the Signal protocol itself; `config.api_url` points at the
 * bridge and `config.phone_number` is the bridge-registered account.
 *
 * Outbound (almyty -> bridge): POST {api_url}/v2/send
 *   { "message": string,
 *     "number": string,              // our registered account (sender)
 *     "recipients": [string] }       // E.164 number, or "group.<id>" for
 *                                    // a group (the id from GET /v1/groups)
 *
 * Inbound (bridge -> almyty): the envelope shape produced by
 * GET /v1/receive/{number} (or the bridge's json-rpc / websocket modes):
 *   { "envelope": {
 *       "source": "+4915...", "sourceNumber": "+4915...",
 *       "sourceUuid": "...", "sourceName": "Alice",
 *       "timestamp": 1700000000000,
 *       "dataMessage": {
 *         "timestamp": 1700000000000, "message": "text",
 *         "groupInfo": { "groupId": "<base64>", "type": "DELIVER" },
 *         "attachments": [{ "contentType": "image/png", "filename": "a.png",
 *                            "id": "<attachment id>", "size": 1234 }] },
 *       "syncMessage": { "sentMessage": { ...same as dataMessage... } } },
 *     "account": "+4915..." }
 */
@Injectable()
export class SignalAdapter extends BaseAdapter {
  private readonly logger = new Logger(SignalAdapter.name);
  readonly type = 'signal';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    // signal-cli REST API format
    const envelope = rawPayload.envelope || rawPayload;
    // Note-to-self / linked-device messages arrive as syncMessage.sentMessage
    const dataMessage = envelope.dataMessage || envelope.syncMessage?.sentMessage || {};
    const attachments = Array.isArray(dataMessage.attachments) && dataMessage.attachments.length
      ? dataMessage.attachments.map((a: any) => ({
          // The bridge exposes attachments by id under /v1/attachments/<id>
          url: a.id || '',
          type: a.contentType || 'application/octet-stream',
          name: a.filename || a.id || 'attachment',
        }))
      : undefined;
    return {
      text: dataMessage.message || dataMessage.body || '',
      userId: envelope.source || envelope.sourceNumber || envelope.sourceUuid || 'unknown',
      threadId: dataMessage.groupInfo?.groupId || envelope.source || envelope.sourceNumber || undefined,
      attachments,
      metadata: {
        timestamp: dataMessage.timestamp || envelope.timestamp,
        groupId: dataMessage.groupInfo?.groupId,
        sourceName: envelope.sourceName,
        sourceUuid: envelope.sourceUuid,
        source: 'signal',
      },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { message: response.text };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    try {
      const apiUrl = config.api_url;
      const phoneNumber = config.phone_number;
      if (!apiUrl || !phoneNumber) {
        this.logger.warn('Signal: api_url or phone_number not configured');
        return;
      }

      // Group replies address the group id ("group." prefixed, per the
      // bridge's send contract); direct replies address the sender.
      const groupId = threadContext?.metadata?.groupId;
      const recipient = groupId
        ? (String(groupId).startsWith('group.') ? String(groupId) : `group.${groupId}`)
        : threadContext?.userId || threadContext?.threadId;
      if (!recipient) {
        this.logger.warn('Signal: no recipient available');
        return;
      }

      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      const res = await (fetch as any)(`${apiUrl}/v2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: formattedResponse.message,
          number: phoneNumber,
          recipients: [recipient],
        }),
      });
      if (res && res.ok === false) {
        const detail = await res.text?.().catch(() => '');
        this.logger.error(`Signal send failed: HTTP ${res.status} ${detail || ''}`.trim());
      }
    } catch (error) {
      this.logger.error(`Signal send failed: ${error.message}`);
    }
  }
}