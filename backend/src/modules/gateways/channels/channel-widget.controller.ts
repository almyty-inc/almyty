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
  NotFoundException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { HostedChatService } from './hosted-chat.service';

import type { Gateway } from '../../../entities/gateway.entity';
import { visitorPrivacyFrom } from '../../../entities/agent-channel.entity';
import { GatewayRateLimitService } from '../gateway-rate-limit.service';
import { ChannelLinkService, ownerOf } from '../channel-link.service';
import { ChannelPolicyService } from '../channel-policy.service';
import { ChannelGatewayService } from './channel-gateway.service';
import { buildWidgetScript, widgetConfigFor } from './widget-script';
import { trustedClientIp } from '../../../common/security/client-ip';
import { ChannelAttachmentReader, attachmentIdsFrom, type ReadAttachments } from './channel-attachments.service';
import { FilesService } from '../../files/files.service';
import { TempFileInterceptor } from '../../files/temp-upload';
import { readFile } from 'fs/promises';

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
 *         when the agent lets visitors do that (403 VISITOR_RIGHT_DISABLED)
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
    // The channel the widget is, whose agent's look it shows. Optional so
    // positional unit tests can construct the controller without it.
    @Optional() private readonly channelLink?: ChannelLinkService,
    // The agent's cost and spend caps and memory rule. Optional for the same
    // reason; Nest always injects it (channel-policy.guard.spec.ts).
    @Optional() private readonly channelPolicy?: ChannelPolicyService,
    // Files a visitor sends with a message: stored, checked, and handed to
    // the agent by reference. Optional for the same reason.
    @Optional() private readonly attachments?: ChannelAttachmentReader,
    @Optional() private readonly files?: FilesService,
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
    // this public endpoint. The look is the owning agent's, with the channel's overrides.
    const gateway = await this.channelGatewayService.findWidgetGateway(id);
    const channel = this.channelLink ? await this.channelLink.channelFor(gateway.organizationId, gateway.id) : null;

    res.setHeader('Cache-Control', 'public, max-age=60');
    return { success: true, data: widgetConfigFor(gateway.configuration, channel ? ownerOf(channel) : null) };
  }

  /**
   * Upload a file to send with the next widget message: an image, a PDF or
   * a text file. Multipart: `file`, and `threadId`, the thread the message
   * will name (the widget makes one up before its first message when it has
   * none yet). The site's and the visitor's message limits apply. The file
   * waits for the message that names it (`attachmentIds`); one never sent
   * is removed a day later, and with the thread when the visitor erases it.
   */
  @Post(':id/widget/attachments')
  @ApiOperation({ summary: 'Upload a file to send with the next widget message' })
  // ChannelAttachmentReader.MAX_BYTES, written out: the upload guard reads the cap as a literal.
  @UseInterceptors(TempFileInterceptor('file', 10 * 1024 * 1024))
  async uploadAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: any,
    @Body() body: { threadId?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.attachments) throw new NotFoundException('Attachments are not available here.');
    if (!file?.path) throw new BadRequestException('file is required');
    const threadId = typeof body?.threadId === 'string' ? body.threadId.trim() : '';
    if (!threadId || threadId.length > 200) throw new BadRequestException('threadId is required');

    const gateway = await this.channelGatewayService.findWidgetGateway(id);
    await this.checkLimits(gateway, threadId, req, res);

    // At most the multer cap, already on disk (files/temp-upload.ts).
    const bytes = await readFile(file.path);
    const stored = await this.attachments.storeUpload(
      bytes,
      file.originalname,
      file.mimetype,
      { organizationId: gateway.organizationId, agentId: gateway.agentId ?? null, gatewayId: gateway.id, threadId },
      'widget_upload',
    );
    if ('refused' in stored) throw new BadRequestException(stored.refused);
    return { success: true, data: stored };
  }

  @Post(':id/widget/messages')
  @ApiOperation({ summary: 'Send a message from the chat widget' })
  async postMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { message?: string; sessionId?: string; threadId?: string; attachmentIds?: unknown },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const attachmentIds = attachmentIdsFrom(body?.attachmentIds);

    if (!message && !attachmentIds.length) throw new BadRequestException('message is required');
    if (message.length > 4000) throw new BadRequestException('message too long (max 4000 chars)');

    const gateway = await this.channelGatewayService.findWidgetGateway(id);

    // The widget script identifies a browser by threadId (sessionId is the
    // older name some embeds still send); either is the visitor.
    await this.checkLimits(
      gateway,
      (typeof body?.sessionId === 'string' && body.sessionId) || (typeof body?.threadId === 'string' && body.threadId) || null,
      req,
      res,
    );

    // The files this message names: uploads to this widget under the same
    // thread, not sent yet. Checked before a run starts, so a bad id costs
    // nothing.
    const sent = await this.uploadedFiles(gateway, typeof body?.threadId === 'string' ? body.threadId : '', attachmentIds);

    // The spend allowance this channel draws on, and the per-run cost cap
    // and memory rule for the run this message starts.
    const policy = this.channelPolicy ? await this.channelPolicy.admit(gateway) : null;

    const result = await this.channelGatewayService.handleWidgetMessage(
      gateway,
      {
        message,
        sessionId: body?.sessionId,
        threadId: body?.threadId,
      },
      policy,
      sent,
    );
    return { success: true, data: result };
  }

  /**
   * The site's allowance, then this visitor's share of it.
   *
   * Each widget session (and each address) gets its own share, so one
   * browser cannot use up the whole site's allowance.
   *
   * Both halves used to be values the caller chose. `endUserId` still
   * is — the widget runs on a third-party page with no session of
   * ours, so the only browser identity available is the threadId it
   * echoes back, and a caller who wants a fresh bucket can simply
   * invent one. It is kept because it keeps an honest browser honest,
   * but it is not the control. The control is the address, and that
   * was forgeable too: it came from the leftmost X-Forwarded-For hop,
   * the one entry in the header the caller writes. trustedClientIp
   * counts from the right, so the key is now the address our ingress
   * actually saw.
   */
  private async checkLimits(gateway: Gateway, visitor: string | null, req: Request, res: Response): Promise<void> {
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

    const own = await this.gatewayRateLimit.checkVisitor(gateway, {
      endUserId: visitor,
      clientHash: HostedChatService.hashClient(trustedClientIp(req as any)),
    });
    if (own.limited) {
      if (own.retryAfterSeconds) res.setHeader('Retry-After', String(own.retryAfterSeconds));
      throw new HttpException(
        { code: own.code ?? 'VISITOR_RATE_LIMITED', message: own.message ?? 'Too many messages. Please wait a moment.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** The thread's unsent uploads a message names, as the agent gets them; 400 when any is not the thread's. */
  private async uploadedFiles(gateway: Gateway, threadId: string, ids: string[]): Promise<ReadAttachments> {
    if (!ids.length) return { lines: [], parts: [], fileIds: [] };
    const files =
      this.files && threadId
        ? await this.files.findUnsentUploads(gateway.organizationId, ids, { gatewayId: gateway.id, threadId })
        : null;
    if (!files) throw new BadRequestException('An attachment was not found. Upload it again.');
    return ChannelAttachmentReader.fromFiles(files);
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

  /** The agent (or the channel) may switch visitor self-service off; say so with the hosted chat's code. */
  private async requireVisitorRight(gateway: Gateway, right: 'visitorCanDelete' | 'visitorCanExport'): Promise<void> {
    const channel = this.channelLink ? await this.channelLink.channelFor(gateway.organizationId, gateway.id) : null;
    if ((channel ? ownerOf(channel).privacy : visitorPrivacyFrom(null))[right]) return;
    throw new HttpException(
      { code: 'VISITOR_RIGHT_DISABLED', message: 'This chat does not offer that. Please contact the operator of this site.' },
      HttpStatus.FORBIDDEN,
    );
  }
}
