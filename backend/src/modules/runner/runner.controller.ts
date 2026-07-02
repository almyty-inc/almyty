import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Request,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
  HttpException,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RunnerService, RegisterRunnerInput } from './runner.service';
import { RunnerCallService, RunnerCallError } from './runner-call.service';
import { CodingRelayService } from './coding-relay.service';
import { RegisterRunnerDto } from './dto/register-runner.dto';
import { AgentSpawnDto, AgentStatusDto } from './dto/agent-call.dto';
import {
  CodingInputDto,
  CodingStartDto,
  CodingStopDto,
  CODING_SESSION_ID_RE,
} from './dto/coding-call.dto';

@Controller('runners')
@UseGuards(JwtAuthGuard)
export class RunnerController {
  constructor(
    private readonly service: RunnerService,
    private readonly calls: RunnerCallService,
    private readonly codingRelay: CodingRelayService,
  ) {}

  @Post('register')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async register(@Request() req: any, @Body() body: RegisterRunnerDto) {
    const ownerUserId = req.user?.id;
    const organizationId = req.user?.currentOrganizationId;
    if (!ownerUserId || !organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    const result = await this.service.register(body, ownerUserId, organizationId);
    return {
      success: true,
      data: {
        runner: result.runner,
        effectiveConfig: result.effectiveConfig,
      },
    };
  }

  @Get()
  async list(@Request() req: any) {
    const ownerUserId = req.user?.id;
    const organizationId = req.user?.currentOrganizationId;
    if (!ownerUserId || !organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    const data = await this.service.listForOwner(ownerUserId, organizationId);
    return { success: true, data };
  }

  @Get(':id')
  async getOne(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const ownerUserId = req.user?.id;
    const organizationId = req.user?.currentOrganizationId;
    if (!ownerUserId || !organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    const data = await this.service.getOne(id, ownerUserId, organizationId);
    return { success: true, data };
  }

  @Delete(':id')
  async unregister(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const ownerUserId = req.user?.id;
    const organizationId = req.user?.currentOrganizationId;
    if (!ownerUserId || !organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    await this.service.unregister(id, ownerUserId, organizationId);
    return { success: true };
  }

  // ── coding-agent orchestration ──────────────────────────────────────
  //
  // Thin, ownership-scoped proxies over RunnerCallService.dispatch for the
  // runner's agent.* surface. getOne enforces that the caller owns the runner
  // (and the org/team access policy) before any dispatch leaves the backend.

  /** Catalog of coding-agent platforms this runner can drive. */
  @Get(':id/agents')
  async agentList(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.requireOwnedRunner(req, id);
    return this.dispatch(id, 'agent.list', {});
  }

  /** Launch a coding-agent CLI as an unattended member in a workspace. */
  @Post(':id/agents/spawn')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async agentSpawn(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AgentSpawnDto,
  ) {
    await this.requireOwnedRunner(req, id);
    const { workspaceId, ...params } = body;
    return this.dispatch(id, 'agent.spawn', params, workspaceId);
  }

  /** Non-destructively classify a spawned agent's live status. */
  @Post(':id/agents/status')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async agentStatus(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AgentStatusDto,
  ) {
    await this.requireOwnedRunner(req, id);
    const { workspaceId, ...params } = body;
    return this.dispatch(id, 'agent.status', params, workspaceId);
  }

  // ── chat-to-runner coding bridge ────────────────────────────────────
  //
  // coding.* rides the same dispatch envelope as agent.*, but the authz
  // scope is the ORGANIZATION, not runner ownership: any authenticated org
  // member may drive coding sessions on a runner in their org (404 unknown
  // runner, 403 cross-org). Output streams back over the per-session SSE
  // endpoint, relayed from the runner's event envelopes by CodingRelayService.

  /** Coding CLIs actually installed on the runner machine (fresh probe). */
  @Get(':id/coding/agents')
  async codingAgents(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.requireOrgRunner(req, id);
    return this.dispatch(id, 'coding.list', {});
  }

  /** Start a coding session (spawns the CLI with the task prompt). */
  @Post(':id/coding/sessions')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async codingStart(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CodingStartDto,
  ) {
    await this.requireOrgRunner(req, id);
    return this.dispatch(id, 'coding.start', { ...body });
  }

  /** Session status (or the full list via coding.status without an id). */
  @Get(':id/coding/sessions/:sessionId')
  async codingStatus(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sessionId') sessionId: string,
  ) {
    await this.requireOrgRunner(req, id);
    this.assertSessionId(sessionId);
    return this.dispatch(id, 'coding.status', { sessionId });
  }

  /** Route a line of user input to the session's stdin. */
  @Post(':id/coding/sessions/:sessionId/input')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async codingInput(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sessionId') sessionId: string,
    @Body() body: CodingInputDto,
  ) {
    await this.requireOrgRunner(req, id);
    this.assertSessionId(sessionId);
    return this.dispatch(id, 'coding.input', { sessionId, data: body.data });
  }

  /** Stop the session (TERM; KILL with force). */
  @Post(':id/coding/sessions/:sessionId/stop')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async codingStop(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sessionId') sessionId: string,
    @Body() body: CodingStopDto,
  ) {
    await this.requireOrgRunner(req, id);
    this.assertSessionId(sessionId);
    return this.dispatch(id, 'coding.stop', { sessionId, force: body?.force === true });
  }

  /**
   * SSE stream of one session's coding.output / coding.exit events. Ends
   * when the session exits or the client hangs up. Same streaming headers
   * as the agent-run stream (no-transform + no proxy buffering).
   */
  @Get(':id/coding/sessions/:sessionId/events')
  async codingEvents(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sessionId') sessionId: string,
    @Res() res: ExpressResponse,
  ) {
    await this.requireOrgRunner(req, id);
    this.assertSessionId(sessionId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let cleanedUp = false;
    let unsubscribe = () => {};
    const keepAlive = setInterval(() => {
      if (res.destroyed) return;
      try { res.write(': keep-alive\n\n'); } catch { /* */ }
    }, 15_000);
    keepAlive.unref?.();
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(keepAlive);
      unsubscribe();
    };

    unsubscribe = this.codingRelay.subscribe(id, (event) => {
      if (event.sessionId !== sessionId || res.destroyed) return;
      try {
        res.write(`event: ${event.kind}\ndata: ${JSON.stringify({ type: event.kind, ...event })}\n\n`);
      } catch { /* stream gone; close handler cleans up */ }
      if (event.kind === 'coding.exit') {
        cleanup();
        try { res.end(); } catch { /* */ }
      }
    });
    res.on('close', cleanup);
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private async requireOwnedRunner(req: any, id: string): Promise<void> {
    const ownerUserId = req.user?.id;
    const organizationId = req.user?.currentOrganizationId;
    if (!ownerUserId || !organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    // Throws 404/403 if the caller doesn't own / can't access the runner.
    await this.service.getOne(id, ownerUserId, organizationId);
  }

  /**
   * Org-scoped gate for the coding bridge: 404 unknown runner, 403 when the
   * runner belongs to a different organization than the caller's.
   */
  private async requireOrgRunner(req: any, id: string): Promise<void> {
    const userId = req.user?.id;
    const organizationId = req.user?.currentOrganizationId;
    if (!userId || !organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    await this.service.getOneForOrg(id, organizationId);
  }

  private assertSessionId(sessionId: string): void {
    if (!CODING_SESSION_ID_RE.test(sessionId)) {
      throw new HttpException('invalid coding session id', HttpStatus.BAD_REQUEST);
    }
  }

  private async dispatch(
    runnerId: string,
    method: string,
    params: unknown,
    workspaceId?: string,
  ) {
    try {
      const resp = await this.calls.dispatch(runnerId, method, params, workspaceId);
      if (!resp.ok) {
        throw new HttpException(
          { success: false, error: resp.error },
          HttpStatus.BAD_GATEWAY,
        );
      }
      return { success: true, data: resp.result };
    } catch (e) {
      if (e instanceof RunnerCallError) {
        // Offline / no-session / timeout → 503; a runner-side error → 502.
        const status =
          e.code === 'runner_error' ? HttpStatus.BAD_GATEWAY : HttpStatus.SERVICE_UNAVAILABLE;
        throw new HttpException({ success: false, error: { code: e.code, message: e.message } }, status);
      }
      throw e;
    }
  }
}
