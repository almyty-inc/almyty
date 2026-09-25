import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { trustedClientIp } from '../../../common/security/client-ip';
import { withholdsCandidateAnswers } from '../../agents/final-answer';
import { gatewayPrincipal } from '../../../common/authorization/execution-access.service';

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

  /**
   * The visitor's address, as the outermost trusted proxy saw it.
   *
   * This used to take the leftmost X-Forwarded-For entry: the one hop in
   * that header the caller writes. Since the per-IP bucket is keyed on
   * the result, and this surface starts an LLM run on the tenant's own
   * provider keys, that let one caller mint a fresh counter per request
   * with `X-Forwarded-For: <anything>`. trustedClientIp counts from the
   * right instead; see its doc comment for TRUSTED_PROXY_HOPS.
   */
  private clientIp(req: Request): string | undefined {
    return trustedClientIp(req as any);
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
        ...(await this.hostedChat.publicBranding(gateway)),
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
    return { success: true, data: await this.hostedChat.publicBranding(gateway) };
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

  @Delete(':slug/conversations/:conversationId')
  @ApiOperation({ summary: 'Delete one of this visitor conversations' })
  async deleteConversation(
    @Param('slug') slug: string,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { gateway, endUser } = await this.admitted(slug, req, res);
    this.requireVisitorRight(gateway, 'visitorCanDelete');
    await this.hostedChat.deleteConversation(endUser, conversationId);
    return { success: true };
  }

  @Delete(':slug/me')
  @ApiOperation({ summary: 'Erase everything this chat holds about the visitor' })
  async deleteMe(@Param('slug') slug: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { gateway, endUser } = await this.admitted(slug, req, res);
    this.requireVisitorRight(gateway, 'visitorCanDelete');
    await this.hostedChat.deleteVisitor(gateway, endUser);
    res.clearCookie(HostedChatService.SESSION_COOKIE, { path: '/' });
    return { success: true };
  }

  @Get(':slug/export')
  @ApiOperation({ summary: 'Download everything this chat holds about the visitor' })
  async exportMe(@Param('slug') slug: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { gateway, endUser } = await this.admitted(slug, req, res);
    this.requireVisitorRight(gateway, 'visitorCanExport');
    // The expensive one: a visitor's whole history in one response.
    const own = await this.gatewayRateLimit.checkVisitor(gateway, {
      endUserId: endUser.id,
      clientHash: HostedChatService.hashClient(this.clientIp(req)),
    });
    if (own.limited) {
      if (own.retryAfterSeconds) res.setHeader('Retry-After', String(own.retryAfterSeconds));
      throw new HttpException({ code: own.code ?? 'VISITOR_RATE_LIMITED', message: own.message }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const data = await this.hostedChat.exportVisitor(gateway, endUser);
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-my-data.json"`);
    return data;
  }

  /** The shared preamble: resolve the surface and the visitor, issue the cookie, apply the auth gate. */
  private async admitted(slug: string, req: Request, res: Response): Promise<{ gateway: Gateway; endUser: EndUser }> {
    const gateway = await this.hostedChat.findBySlug(slug);
    const { endUser, issuedSessionKey } = await this.hostedChat.resolveEndUser(
      gateway,
      this.sessionFrom(req),
      this.clientIp(req),
    );
    this.setSessionCookie(res, issuedSessionKey);
    await this.requireVisitor(gateway, endUser);
    return { gateway, endUser };
  }

  /** A product may switch visitor self-service off; say so with a stable code. */
  private requireVisitorRight(gateway: Gateway, right: 'visitorCanDelete' | 'visitorCanExport'): void {
    if (hostedChatConfigFrom(gateway.configuration)[right]) return;
    throw new HttpException(
      { code: 'VISITOR_RIGHT_DISABLED', message: 'This chat does not offer that. Please contact the operator of this app.' },
      HttpStatus.FORBIDDEN,
    );
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
        { code: rate.code ?? 'SURFACE_RATE_LIMITED', message: rate.message ?? 'This chat is busy right now, please try again shortly.' },
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

    // This visitor's own share. The surface ceiling above is for the
    // product as a whole; this is what keeps one person (or one address)
    // from spending everyone else's.
    const own = await this.gatewayRateLimit.checkVisitor(gateway, {
      endUserId: endUser.id,
      clientHash: HostedChatService.hashClient(this.clientIp(req)),
    });
    if (own.limited) {
      if (own.retryAfterSeconds) res.setHeader('Retry-After', String(own.retryAfterSeconds));
      throw new HttpException(
        { code: own.code ?? 'VISITOR_RATE_LIMITED', message: own.message ?? 'Too many messages. Please wait a moment.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

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
      {
        conversationId: conversation.id,
        endUserId: endUser.id,
        metadata: {
          // Whether this product lets visitor conversations feed shared
          // memory; the runtime's auto-save policy reads it off the run.
          visitorMemory: hostedChatConfigFrom(gateway.configuration).visitorMemory,
          // The visitor watches the reply arrive, so the answer is written
          // by a call without tools and streams word by word; see
          // agents/final-answer.ts and stream() below.
          composeFinalAnswer: true,
        },
        // Runs in the gateway's scope: the surface serves its agent only
        // while the gateway's own visibility covers it, on every message.
        principal: gatewayPrincipal(gateway),
      },

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
    const withholdCandidateChunks = withholdsCandidateAnswers(run.agent);

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

    // A visitor sees the answer, never the working. Every step of an
    // autonomous run streams its model output as `llm.chunk`, and a step
    // that goes on to call tools streams its narration too: what it is
    // about to look up, what the last tool returned, instructions echoed
    // from the system prompt.
    //
    // Runs started here compose their answer (agents/final-answer.ts):
    // every call that offers tools is announced as working (`llm.started`
    // with `answer: false`) and nothing of it is sent, and the answer is
    // written by a call that offers none (`answer: true`), which streams
    // token by token as it arrives. Should that call fail, its
    // `llm.response` carries the draft, which then goes out whole.
    //
    // A step not announced either way is held until the provider's stream
    // has said, with certainty, what the step is (`llm.step_kind`, see
    // StreamChunk.stepKind):
    //
    //   text -> the held chunks go out, and the rest stream live
    //   tool -> the held chunks are dropped, and nothing more is sent
    //
    // A step whose provider never says (Gemini, custom endpoints, any
    // type on the non-streaming fallback) streams nothing, and its answer
    // goes out as one token event when its `llm.response` lands with no
    // tool calls. That is also where anything the stream did not carry
    // is made up. The response is the last word: if it contradicts what
    // was streamed, the page is told to `reset` the reply. With a verify
    // panel on the final output, or a multi-model strategy that checks or
    // judges candidate answers, nothing is sent before the answer is
    // chosen; the page reconciles from the transcript on `done`.
    type StepStream = { kind: 'text' | 'tool' | null; held: string[]; sent: string; working?: boolean };
    const steps = new Map<number, StepStream>();
    const stepOf = (data: any): number | null => (typeof data?.step === 'number' ? data.step : null);
    const stateOf = (step: number): StepStream => {
      let state = steps.get(step);
      if (!state) {
        state = { kind: null, held: [], sent: '' };
        steps.set(step, state);
      }
      return state;
    };
    const sendToken = (state: StepStream | null, content: string) => {
      res.write(`event: token\ndata: ${JSON.stringify({ content })}\n\n`);
      if (state) state.sent += content;
    };
    const retract = (state: StepStream | undefined) => {
      if (!state?.sent) return;
      res.write(`event: reset\ndata: {}\n\n`);
      state.sent = '';
    };

    const onEvent = (event: any) => {
      if (closed) return;
      const type = event?.type;
      const data = event?.data;
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(type)) {
        res.write(`event: done\ndata: ${JSON.stringify({ reason: type })}\n\n`);
        close();
        return;
      }
      if (withholdCandidateChunks) return;
      const step = stepOf(data);

      if (type === 'llm.started') {
        // A fresh attempt at this step. Whatever an earlier attempt held
        // or showed is not this attempt's answer.
        if (step === null) return;
        retract(steps.get(step));
        steps.delete(step);
        // Announced: a working call is never shown, and the answer call
        // offers no tools, so it cannot turn out to be anything but text.
        if (data?.answer === false) steps.set(step, { kind: 'tool', held: [], sent: '', working: true });
        else if (data?.answer === true) steps.set(step, { kind: 'text', held: [], sent: '' });
        return;
      }

      if (type === 'llm.chunk') {
        const content = data?.content;
        if (step === null || typeof content !== 'string' || !content) return;
        const state = stateOf(step);
        if (state.kind === 'tool') return;
        if (state.kind === 'text') sendToken(state, content);
        else state.held.push(content);
        return;
      }

      if (type === 'llm.step_kind') {
        if (step === null) return;
        const state = stateOf(step);
        if (state.kind) return; // the first verdict is the one the provider was certain of
        if (data?.kind === 'tool') {
          state.kind = 'tool';
          state.held = [];
          retract(state);
        } else if (data?.kind === 'text') {
          state.kind = 'text';
          for (const content of state.held) sendToken(state, content);
          state.held = [];
        }
        return;
      }

      if (type === 'llm.response') {
        const state = step === null ? undefined : steps.get(step);
        if (step !== null) steps.delete(step);
        // A working step's reply is never the visitor's, unless the runtime
        // says it now is: the answer call failed and its draft stands in.
        if (state?.working && data?.answer !== true) return;
        const calledTools = Array.isArray(data?.toolCalls) && data.toolCalls.length > 0;
        if (calledTools) {
          retract(state);
          return;
        }
        const content = data?.content;
        if (typeof content !== 'string' || !content) return;
        const sent = state?.sent ?? '';
        if (content.startsWith(sent)) {
          const rest = content.slice(sent.length);
          if (rest) sendToken(null, rest);
        } else {
          retract(state);
          sendToken(null, content);
        }
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
