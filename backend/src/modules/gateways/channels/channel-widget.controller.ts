import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { GatewayRateLimitService } from '../gateway-rate-limit.service';
import { ChannelGatewayService } from './channel-gateway.service';
import { buildWidgetScript } from './widget-script';

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
 *   2. GET /gateways/:id/widget/messages?threadId=...&after=<ISO>
 *      -> agent replies persisted by ChatWidgetAdapter, oldest first
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
    return res.send(buildWidgetScript(id));
  }

  @Post(':id/widget/messages')
  @ApiOperation({ summary: 'Send a message from the chat widget' })
  async postMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { message?: string; sessionId?: string; threadId?: string },
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

    const result = await this.channelGatewayService.handleWidgetMessage(gateway, {
      message,
      sessionId: body?.sessionId,
      threadId: body?.threadId,
    });
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
}
