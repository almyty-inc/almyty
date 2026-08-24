import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '../../../common/decorators/public.decorator';
import { HostedChatService } from './hosted-chat.service';
import { GatewayRateLimitService } from '../gateway-rate-limit.service';
import { AgentRuntimeService } from '../../agents/agent-runtime.service';
import { hostedChatConfigFrom } from './hosted-chat.config';

/**
 * The public API behind {slug}.almyty.app.
 *
 * Every route here is unauthenticated by design and reachable by anyone
 * on the internet, so each one resolves the surface by slug first, then
 * resolves the visitor from their own cookie, and only ever operates on
 * rows already scoped to that pair. Nothing accepts an organization,
 * agent or end-user id from the caller.
 */
@Controller('public/chat')
@ApiTags('Hosted chat')
@Public()
export class HostedChatController {
  /** Anonymous sessions outlive a browser restart but not forever. */
  static readonly SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

  constructor(
    private readonly hostedChat: HostedChatService,
    private readonly gatewayRateLimit: GatewayRateLimitService,
    private readonly agentRuntimeService: AgentRuntimeService,
  ) {}

  /**
   * Attach the session cookie when a visitor is new.
   *
   * httpOnly so page scripts cannot read it, sameSite lax so a link from
   * elsewhere still lands logged in, and no explicit Domain so the
   * browser scopes it to the tenant's own host. That last detail is what
   * stops one tenant's chat app seeing another's session.
   */
  private setSessionCookie(res: Response, issued: string | null): void {
    if (!issued) return;
    res.cookie(HostedChatService.SESSION_COOKIE, issued, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: HostedChatController.SESSION_MAX_AGE_MS,
      path: '/',
    });
  }

  private sessionFrom(req: Request): string | undefined {
    return (req as any).cookies?.[HostedChatService.SESSION_COOKIE];
  }

  private clientIp(req: Request): string | undefined {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    return req.ip;
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Branding and greeting for a hosted chat app' })
  async branding(@Param('slug') slug: string, @Res({ passthrough: true }) res: Response) {
    const gateway = await this.hostedChat.findBySlug(slug);
    // Short cache: branding changes should show up quickly after a save,
    // but this is the first request of every page load.
    res.setHeader('Cache-Control', 'public, max-age=30');
    return { success: true, data: this.hostedChat.publicBranding(gateway) };
  }

  @Get(':slug/conversations')
  @ApiOperation({ summary: 'This visitor conversations' })
  async listConversations(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const gateway = await this.hostedChat.findBySlug(slug);
    const { endUser, issuedSessionKey } = await this.hostedChat.resolveEndUser(
      gateway,
      this.sessionFrom(req),
      this.clientIp(req),
    );
    this.setSessionCookie(res, issuedSessionKey);

    const conversations = await this.hostedChat.listConversations(endUser);
    return {
      success: true,
      data: conversations.map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt })),
    };
  }

  @Post(':slug/messages')
  @ApiOperation({ summary: 'Send a message to the hosted agent' })
  async postMessage(
    @Param('slug') slug: string,
    @Body() body: { message?: string; conversationId?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) throw new BadRequestException('message is required');
    if (message.length > 4000) {
      throw new BadRequestException('message too long (max 4000 chars)');
    }

    const gateway = await this.hostedChat.findBySlug(slug);

    // Surface-level ceiling first: it protects the tenant's spend even
    // when a single visitor is behaving.
    const rate = await this.gatewayRateLimit.check(gateway);
    if (rate.limited) {
      if (rate.retryAfterSeconds) res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      throw new HttpException(
        rate.message ?? 'This chat is busy right now, please try again shortly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const { endUser, issuedSessionKey } = await this.hostedChat.resolveEndUser(
      gateway,
      this.sessionFrom(req),
      this.clientIp(req),
    );
    this.setSessionCookie(res, issuedSessionKey);

    const conversation = body?.conversationId
      ? await this.hostedChat.findConversation(endUser, body.conversationId)
      : await this.hostedChat.startConversation(gateway, endUser, message);

    const run = await this.agentRuntimeService.startRun(
      gateway.agentId,
      gateway.organizationId,
      // The run is attributed to the visitor, not to a dashboard user,
      // so a hosted chat run is traceable back to who actually sent it.
      endUser.id,
      message,
      { conversationId: conversation.id },
    );

    return {
      success: true,
      data: { runId: run.id, conversationId: conversation.id },
    };
  }

  @Get(':slug/stream')
  @ApiOperation({ summary: 'Stream an in-flight reply' })
  async stream(
    @Param('slug') slug: string,
    @Query('runId') runId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!runId) throw new BadRequestException('runId is required');

    const gateway = await this.hostedChat.findBySlug(slug);
    const { endUser } = await this.hostedChat.resolveEndUser(
      gateway,
      this.sessionFrom(req),
      this.clientIp(req),
    );

    // A run id is a UUID, but it is still a caller-supplied identifier
    // on a public endpoint, so confirm it belongs to this visitor rather
    // than trusting it.
    const owned = await this.hostedChat.runBelongsToEndUser(runId, endUser);
    if (!owned) throw new HttpException('Not found', HttpStatus.NOT_FOUND);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx would otherwise buffer the stream
    res.flushHeaders?.();

    const emitter = this.agentRuntimeService.getRunEmitter(runId);
    if (!emitter) {
      // The run already finished, or this process is not the one running
      // it. Either way the client should fall back to fetching the
      // finished reply rather than hanging on an open socket.
      res.write(`event: done\ndata: ${JSON.stringify({ reason: 'not_streaming' })}\n\n`);
      return res.end();
    }

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      emitter.off('event', onEvent);
      clearInterval(heartbeat);
      try {
        res.end();
      } catch {
        /* socket already gone */
      }
    };

    const onEvent = (event: any) => {
      if (closed) return;
      if (event?.type === 'token' || event?.type === 'step.completed') {
        res.write(`event: token\ndata: ${JSON.stringify(event.data ?? {})}\n\n`);
        return;
      }
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(event?.type)) {
        res.write(`event: done\ndata: ${JSON.stringify({ reason: event.type })}\n\n`);
        close();
      }
    };

    // Proxies drop idle connections; a comment frame keeps it warm
    // without being visible to the EventSource consumer.
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': keep-alive\n\n');
    }, 25_000);
    heartbeat.unref?.();

    emitter.on('event', onEvent);
    req.on('close', close);
    return undefined;
  }

  @Get(':slug/conversations/:conversationId/messages')
  @ApiOperation({ summary: 'Replay a conversation for this visitor' })
  async messages(
    @Param('slug') slug: string,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const gateway = await this.hostedChat.findBySlug(slug);
    const { endUser, issuedSessionKey } = await this.hostedChat.resolveEndUser(
      gateway,
      this.sessionFrom(req),
      this.clientIp(req),
    );
    this.setSessionCookie(res, issuedSessionKey);

    const conversation = await this.hostedChat.findConversation(endUser, conversationId);
    const messages = await this.hostedChat.listMessages(conversation);

    const config = hostedChatConfigFrom(gateway.configuration);
    return {
      success: true,
      data: {
        conversationId: conversation.id,
        title: conversation.title,
        aiDisclosure: config.aiDisclosure,
        messages,
      },
    };
  }
}
