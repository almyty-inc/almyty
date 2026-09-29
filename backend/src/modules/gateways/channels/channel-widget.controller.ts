import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  Optional,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { HostedChatService } from './hosted-chat.service';

import type { Gateway } from '../../../entities/gateway.entity';
import { appPrivacyFrom } from '../../../entities/agent-app.entity';
import { GatewayRateLimitService } from '../gateway-rate-limit.service';
import { GatewayAppLinkService } from '../gateway-app-link.service';
import { AppPlacePolicyService } from '../app-place-policy.service';
import { ChannelGatewayService } from './channel-gateway.service';
import { buildWidgetScript, widgetConfigFor } from './widget-script';
import { trustedClientIp } from '../../../common/security/client-ip';

/**
 * Public (unauthenticated) surface for the embedded chat widget — the
 * widget runs on third-party pages with no almyty session.
 *
 * Loop:
 *   0. GET /gateways/:id/widget.js
 *      -> self-contained embed script (bubble + panel) customers drop
 *         into their site: <script src=".../gateways/<id>/widget.js" async>
 *   1. POST /gateways/:id/widget/messages  { message, threadId? }
 *      -> { runId, threadId }  (threadId is a server-minted run UUID on
 *         the first message; the widget echoes it back afterwards)
 *   2. GET /gateways/:id/widget/messages?threadId=...&after=
 *      -> agent replies persisted by ChatWidgetAdapter, oldest first
 *   3. GET /gateways/:id/widget/threads/:threadId/export
 *      DELETE /gateways/:id/widget/threads/:threadId
 *      -> the visitor's own copy of the conversation, or its erasure,
 *         when the app lets visitors do that (403 VISITOR_RIGHT_DISABLED)
 *
 * Security: the gateway must be an active chat_widget gateway (404
 * otherwise), per-gateway rate limits are enforced on POST, and thread
 * ids are unguessable UUIDs, so replies cannot be enumerated.
 */
@Controller('gateways')
@ApiTags('Chat widget')
export class ChannelWidgetController {
  constructor(
    private readonly channelGatewayService: ChannelGatewayService,
    private readonly gatewayRateLimit: GatewayRateLimitService,
    // The app the widget is a place of, whose look it shows. Optional so
    // positional unit tests can construct the controller without it.
    @Optional() private readonly appLink?: GatewayAppLinkService,
    // The app's cost and spend caps and memory rule. Optional for the same
    // reason; Nest always injects it (app-place-policy.guard.spec.ts).
    @Optional() private readonly places?: AppPlacePolicyService,
  ) {}

  @Get(':id/widget.js')
  @ApiOperation({ summary: 'Self-contained chat widget embed script' })
  async widgetScript(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    // 404s unless the gateway exists, is a chat_widget and is active —
    // the script is only served for deployable widgets.
    await this.channelGatewayService.findWidgetGateway(id);

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // helmet's default Cross-Origin-Resource-Policy is same-origin, which
    // makes a browser refuse this script on every site but ours -- that
    // is, everywhere it is meant to be embedded. The script is public by
    // design and carries no data; which sites may then TALK to the
    // gateway is the allowed-origins list, enforced by SurfaceCorsService.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    return res.send(buildWidgetScript(id));
  }

  @Get(':id/widget-config')
  @ApiOperation({ summary: 'Public sanitized widget presentation config' })
  async widgetConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Same gate as widget.js: 404 unless the gateway exists, is a
    // chat_widget and is active. The response is a strict whitelist of
    // presentation fields (see widgetConfigFor) — the raw configuration
    // jsonb also holds channel credentials and must never leak through
    // this public endpoint. The look is the owning app's.
    const gateway = await this.channelGatewayService.findWidgetGateway(id);
    const place = this.appLink ? await this.appLink.distributionFor(gateway.organizationId, gateway.id) : null;

    res.setHeader('Cache-Control', 'public, max-age=60');
    return { success: true, data: widgetConfigFor(gateway.configuration, place?.app ?? null) };
  }

  @Post(':id/widget/messages')
  @ApiOperation({ summary: 'Send a message from the chat widget' })
  async postMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { message?: string; sessionId?: string; threadId?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const message = typeof body?.message === 'string' ? body.message.trim() : '';

    if (!message) throw new BadRequestException('message is required');
    if (message.length > 4000) throw new BadRequestException('message too long (max 4000 chars)');

    const gateway = await this.channelGatewayService.findWidgetGateway(id);

    const rate = await this.gatewayRateLimit.check(gateway);
    if (rate.limited) {
      if (rate.retryAfterSeconds) {
        res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      }
      throw new HttpException(
        rate.message ?? 'Gateway rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Each widget session (and each address) gets its own share, so one
    // browser cannot use up the whole site's allowance.
    //
    // Both halves used to be values the caller chose. `endUserId` still
    // is — the widget runs on a third-party page with no session of
    // ours, so the only browser identity available is the threadId it
    // echoes back, and a caller who wants a fresh bucket can simply
    // invent one. It is kept because it keeps an honest browser honest,
    // but it is not the control. The control is the address, and that
    // was forgeable too: it came from the leftmost X-Forwarded-For hop,
    // the one entry in the header the caller writes. trustedClientIp
    // counts from the right, so the key is now the address our ingress
    // actually saw.
    const own = await this.gatewayRateLimit.checkVisitor(gateway, {
      // The widget script identifies a browser by threadId (sessionId is
      // the older name some embeds still send); either is the visitor.
      endUserId:
        (typeof body?.sessionId === 'string' && body.sessionId) ||
        (typeof body?.threadId === 'string' && body.threadId) ||
        null,

      clientHash: HostedChatService.hashClient(trustedClientIp(req as any)),
    });
    if (own.limited) {
      if (own.retryAfterSeconds) res.setHeader('Retry-After', String(own.retryAfterSeconds));
      throw new HttpException(
        { code: own.code ?? 'VISITOR_RATE_LIMITED', message: own.message ?? 'Too many messages. Please wait a moment.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // The app's allowance across every place and visitor, and its per-run
    // cost cap and memory rule for the run this message starts.
    const place = this.places ? await this.places.admit(gateway) : null;

    const result = await this.channelGatewayService.handleWidgetMessage(
      gateway,
      {
        message,
        sessionId: body?.sessionId,
        threadId: body?.threadId,
      },
      place,
    );
    return { success: true, data: result };
  }

  @Get(':id/widget/messages')
  @ApiOperation({ summary: 'Poll agent replies for a widget thread' })
  async listMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('threadId') threadId?: string,
    @Query('after') after?: string,
  ) {
    if (!threadId) throw new BadRequestException('threadId is required');

    let afterDate: Date | undefined;
    if (after) {
      afterDate = new Date(after);
      if (isNaN(afterDate.getTime())) {
        throw new BadRequestException('after must be an ISO-8601 timestamp');
      }
    }

    const gateway = await this.channelGatewayService.findWidgetGateway(id);
    const messages = await this.channelGatewayService.listWidgetMessages(
      gateway.id,
      threadId,
      afterDate,
    );
    return { success: true, data: messages };
  }

  /**
   * Everything the widget holds about this browser's conversation, for the
   * visitor to keep. The widget has no session of ours, so the visitor is
   * the thread: the unguessable id the browser was handed on its first
   * message and keeps on the customer's site.
   */
  @Get(':id/widget/threads/:threadId/export')
  @ApiOperation({ summary: 'Download this widget conversation' })
  async exportThread(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId') threadId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const gateway = await this.channelGatewayService.findWidgetGateway(id);
    await this.requireVisitorRight(gateway, 'visitorCanExport');
    const own = await this.gatewayRateLimit.checkVisitor(gateway, {
      endUserId: threadId,
      clientHash: HostedChatService.hashClient(trustedClientIp(req as any)),
    });
    if (own.limited) {
      if (own.retryAfterSeconds) res.setHeader('Retry-After', String(own.retryAfterSeconds));
      throw new HttpException({ code: own.code ?? 'VISITOR_RATE_LIMITED', message: own.message }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const data = await this.channelGatewayService.exportWidgetThread(gateway, threadId);
    res.setHeader('Content-Disposition', 'attachment; filename="my-chat.json"');
    return data;
  }

  /** Erase this browser's conversation: its runs, transcript and stored replies. */
  @Delete(':id/widget/threads/:threadId')
  @ApiOperation({ summary: 'Delete this widget conversation' })
  async deleteThread(@Param('id', ParseUUIDPipe) id: string, @Param('threadId') threadId: string) {
    const gateway = await this.channelGatewayService.findWidgetGateway(id);
    await this.requireVisitorRight(gateway, 'visitorCanDelete');
    await this.channelGatewayService.deleteWidgetThread(gateway, threadId);
    return { success: true };
  }

  /** The app may switch visitor self-service off; say so with the hosted chat's code. */
  private async requireVisitorRight(gateway: Gateway, right: 'visitorCanDelete' | 'visitorCanExport'): Promise<void> {
    const place = this.appLink ? await this.appLink.distributionFor(gateway.organizationId, gateway.id) : null;
    if (appPrivacyFrom(place?.app?.privacy)[right]) return;
    throw new HttpException(
      { code: 'VISITOR_RIGHT_DISABLED', message: 'This chat does not offer that. Please contact the operator of this site.' },
      HttpStatus.FORBIDDEN,
    );
  }
}
