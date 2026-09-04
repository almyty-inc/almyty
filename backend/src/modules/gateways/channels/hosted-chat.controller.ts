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
import type { Gateway } from '../../../entities/gateway.entity';
import type { EndUser } from '../../../entities/end-user.entity';

import { GatewayRateLimitService } from '../gateway-rate-limit.service';
import { AgentRuntimeService } from '../../agents/agent-runtime.service';
import { hostedChatConfigFrom, slugFromHost } from './hosted-chat.config';

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

  /**
   * Refuse a visitor the surface requires to be signed in. 401 with a
   * stable code; the page knows the auth mode from branding and shows the
   * matching sign-in. An SSO surface on an org without the entitlement
   * closes rather than opening up.
   */
  private async requireVisitor(gateway: Gateway, endUser: EndUser): Promise<void> {
    if (!this.hostedChat.requiresAuth(gateway)) return;
    if (!(await this.hostedChat.authModeAvailable(gateway))) {
      throw new HttpException(
        { code: 'AUTH_MODE_UNAVAILABLE', message: 'This chat requires a sign-in method its organization is not entitled to.' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (this.hostedChat.isAuthorized(gateway, endUser)) return;
    throw new HttpException(
      { code: 'AUTH_REQUIRED', message: 'Sign in to use this chat.', authMode: this.hostedChat.authMode(gateway) },
      HttpStatus.UNAUTHORIZED,
    );
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

  /**
   * Resolve the surface a request is for, by Host header.
   *
   * A Tier 2 custom domain has no slug in its URL, so the browser asks
   * for `/public/chat/by-host` and the server works out which surface
   * that hostname belongs to. Declared before the ':slug' route because
   * Nest matches in declaration order and 'by-host' would otherwise be
   * read as a slug.
   */
  @Get('by-host')
  @ApiOperation({ summary: 'Resolve a hosted chat surface from the Host header' })
  async byHost(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');

    // A subdomain of our own base domain is Tier 1 and resolves by slug.
    const slug = slugFromHost(host);
    const gateway = slug
      ? await this.hostedChat.findBySlug(slug)
      : await this.hostedChat.findByCustomDomain(host.split(':')[0]);

    if (!gateway) throw new HttpException('Chat app not found', HttpStatus.NOT_FOUND);

    res.setHeader('Cache-Control', 'public, max-age=30');
    // Vary on Host: the same path returns a different tenant's branding
    // per hostname, and a shared cache must not conflate them.
    res.setHeader('Vary', 'Host, X-Forwarded-Host');
    return {
      success: true,
      data: {
        ...this.hostedChat.publicBranding(gateway),
        slug: hostedChatConfigFrom(gateway.configuration).slug,
      },
    };
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

  @Get(':slug/me')
  @ApiOperation({ summary: 'Who this visitor is, and whether the surface admits them' })
  async me(
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
    const authMode = this.hostedChat.authMode(gateway);
    return {
      success: true,
      data: {
        authMode,
        available: await this.hostedChat.authModeAvailable(gateway),
        authenticated: this.hostedChat.isAuthorized(gateway, endUser),
        email: endUser.email ?? null,
        displayName: endUser.displayName ?? null,
      },
    };
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

    await this.requireVisitor(gateway, endUser);
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
    await this.requireVisitor(gateway, endUser);

    const conversation = body?.conversationId
      ? await this.hostedChat.findConversation(endUser, body.conversationId)
      : await this.hostedChat.startConversation(gateway, endUser, message);

    const run = await this.agentRuntimeService.startRun(
      gateway.agentId,
      gateway.organizationId,
      // No dashboard user started this. Attributing the visitor through
      // `userId` used to write their id into a column that references
      // `users`, and every conversation write after it failed, so a
      // hosted chat could not answer at all.
      null,
      message,
      // Still traceable back to whoever actually sent it, in the column
      // that means a visitor.
      { conversationId: conversation.id, endUserId: endUser.id },
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
    await this.requireVisitor(gateway, endUser);

    // A run id is a UUID, but it is still a caller-supplied identifier
    // on a public endpoint, so confirm it belongs to this visitor rather
    // than trusting it.
    const owned = await this.hostedChat.runBelongsToEndUser(runId, endUser);
    if (!owned) throw new HttpException('Not found', HttpStatus.NOT_FOUND);

    // Ownership is necessary but not sufficient: scope the run to this
    // gateway's organization and agent before exposing any of its events.
    const run = await this.agentRuntimeService.getRun(
      runId,
      gateway.organizationId,
      gateway.agentId,
    );
    const verify = run.agent?.agentConfig?.verify;
    const withholdCandidateChunks = !!(
      verify?.enabled &&
      Array.isArray(verify.checkers) &&
      verify.checkers.length > 0 &&
      (verify.triggers ?? ['on_final_output']).includes('on_final_output')
    );

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx would otherwise buffer the stream
    res.flushHeaders?.();

    let closed = false;
    const abortController = new AbortController();
    const close = () => {
      if (closed) return;
      closed = true;
      abortController.abort();
      clearInterval(heartbeat);
      try {
        res.end();
      } catch {
        /* socket already gone */
      }
    };

    const onEvent = (event: any) => {
      if (closed) return;
      if (
        !withholdCandidateChunks &&
        (event?.type === 'llm.chunk' || event?.type === 'token')
      ) {
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

    req.on('close', close);

    try {
      // Redis Streams are the cross-pod source of truth. A hosted request and
      // its worker frequently land on different API pods, so a process-local
      // EventEmitter cannot reliably deliver completion.
      await this.agentRuntimeService.subscribeRunEvents(
        runId,
        onEvent,
        abortController.signal,
      );
    } catch {
      // The done event below tells the browser to reconcile from the persisted
      // transcript even if Redis disconnected after the run had completed.
    }

    if (!closed) {
      res.write(`event: done\ndata: ${JSON.stringify({ reason: 'stream_ended' })}\n\n`);
      close();
    }
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
    await this.requireVisitor(gateway, endUser);

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
