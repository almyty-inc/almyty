import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelEvent } from '../../../../entities/channel-event.entity';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';

/**
 * In-app chat widget. The widget has no push transport of its own:
 * inbound messages arrive via POST /gateways/:id/widget/messages and
 * replies are persisted here as channel_events rows
 * (payload.kind = 'widget_message') which the widget retrieves via
 * GET /gateways/:id/widget/messages?threadId=... (polling) — or live
 * over the run's SSE stream using the runId returned on POST.
 */
@Injectable()
export class ChatWidgetAdapter extends BaseAdapter {
  private readonly logger = new Logger(ChatWidgetAdapter.name);
  readonly type = 'chat_widget';

  /**
   * The widget is embedded in a public page and posts from the visitor's
   * browser, so there is no shared secret to verify. Abuse is bounded by
   * the surface's rate limits and cost cap, not by inbound auth.
   */
  protected readonly inboundIsUnauthenticatedByDesign = true;

  constructor(
    @InjectRepository(ChannelEvent)
    private readonly eventRepository: Repository<ChannelEvent>,
  ) {
    super();
  }

  normalizeInbound(rawPayload: any): NormalizedMessage {
    return {
      text: rawPayload.message || rawPayload.text || '',
      userId: rawPayload.userId || rawPayload.sessionId || 'anonymous',
      threadId: rawPayload.threadId || rawPayload.sessionId,
      metadata: { source: 'chat_widget' },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { message: response.text, attachments: response.attachments };
  }

  /**
   * Persist the reply so the widget can poll it. threadContext carries
   * gateway/run identity from ChannelGatewayService's dispatch.
   *
   * There is no platform to accept or refuse anything here: the insert
   * IS the delivery, so a failed insert throws out of `save` on its own
   * and missing identity — which means the reply has nowhere to be
   * filed and the visitor will never see it — is a refusal too, rather
   * than a warning nobody reads.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const gatewayId = threadContext?.gatewayId;
    const organizationId = threadContext?.organizationId;
    const threadId = threadContext?.threadId;
    if (!gatewayId || !organizationId || !threadId) {
      const missing = [
        !gatewayId && 'gatewayId',
        !organizationId && 'organizationId',
        !threadId && 'threadId',
      ].filter(Boolean).join(', ');
      this.sendFailed(`${missing} missing, so the reply could not be filed for the widget`);
    }
    await this.eventRepository.save(
      this.eventRepository.create({
        organizationId,
        gatewayId,
        channelType: this.type,
        direction: 'outbound',
        status: 'processed',
        payload: {
          kind: 'widget_message',
          threadId,
          message: formattedResponse.message,
          attachments: formattedResponse.attachments ?? null,
        },
        runId: threadContext?.runId ?? null,
      }),
    );
  }
}