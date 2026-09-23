import {
  Controller,
  Post,
  Get,
  Patch,
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
import { RunnerService } from './runner.service';
import { RunnerCallService, RunnerCallError } from './runner-call.service';
import { CodingRelayService } from './coding-relay.service';
import { CreateRunnerDto, RegisterRunnerDto, UpdateRunnerDto } from './dto/register-runner.dto';
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

  /**
   * Called by the daemon (`almyty-runner start`) with the user's own
   * login. Owner and organization come from that credential; the body
   * only carries the name and what the daemon detected.
   */
  @Post('register')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async register(@Request() req: any, @Body() body: RegisterRunnerDto) {
    const { userId, organizationId } = this.context(req);
    const result = await this.service.register(body, userId, organizationId);
    return {
      success: true,
      data: {
        runner: result.runner,
        effectiveConfig: result.effectiveConfig,
      },
    };
  }

  /**
   * Create the runner record from the web setup page ("Generate
   * command"). The daemon later registers under the same name and
   * fills it in; until then it is pending and can be edited or deleted.
   */
  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async create(@Request() req: any, @Body() body: CreateRunnerDto) {
    const { userId, organizationId } = this.context(req);
    const data = await this.service.create(body, userId, organizationId);
    return { success: true, data };
  }

  @Get()
  async list(@Request() req: any) {
    const { userId, organizationId } = this.context(req);
    const data = await this.service.listVisible(userId, organizationId);
    return { success: true, data };
  }

  @Get(':id')
  async getOne(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const { userId, organizationId } = this.context(req);
    const data = await this.service.getOne(id, userId, organizationId);
    return { success: true, data };
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async update(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRunnerDto,
  ) {
    const { userId, organizationId } = this.context(req);
    const data = await this.service.update(id, userId, organizationId, body);
    return { success: true, data };
  }

  @Delete(':id')
  async unregister(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const { userId, organizationId } = this.context(req);
    await this.service.unregister(id, userId, organizationId);
    return { success: true };
  }

  // ── coding-agent orchestration ──────────────────────────────────────
  //
  // Thin, ownership-scoped proxies over RunnerCallService.dispatch for the
  // runner's agent.* surface. getOwned enforces that the caller owns the
  // runner before any dispatch leaves the backend.

  /** Catalog of coding-agent platforms this runner can drive. */
  @Get(':id/agents')
  async agentList(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.requireOwnedRunner(req, id);
    return this.dispatch(req, id, 'agent.list', {});
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
    return this.dispatch(req, id, 'agent.spawn', params, workspaceId);
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
    return this.dispatch(req, id, 'agent.status', params, workspaceId);
  }

  // ── chat-to-runner coding bridge ────────────────────────────────────
  //
  // coding.* rides the same dispatch envelope as agent.*, but the authz
  // scope is the runner's VISIBILITY, not ownership: any org member the
  // access policy lets use the runner may drive coding sessions on it
  // (an org-wide runner: every member; a team runner: its team; a private
  // runner: its owner only). 404 unknown or unusable runner, 403 cross-org.
  // Output streams back over the per-session SSE endpoint, relayed from
  // the runner's event envelopes by CodingRelayService.

  /** Coding CLIs actually installed on the runner machine (fresh probe). */
  @Get(':id/coding/agents')
  async codingAgents(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.requireOrgRunner(req, id);
    return this.dispatch(req, id, 'coding.list', {});
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
    return this.dispatch(req, id, 'coding.start', { ...body });
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
    return this.dispatch(req, id, 'coding.status', { sessionId });
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
    return this.dispatch(req, id, 'coding.input', { sessionId, data: body.data });
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
    return this.dispatch(req, id, 'coding.stop', { sessionId, force: body?.force === true });
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

  private context(req: any): { userId: string; organizationId: string } {
    const userId = req.user?.id;
    const organizationId = req.user?.currentOrganizationId;
    if (!userId || !organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    return { userId, organizationId };
  }

  /** agent.* orchestration is the runner owner's only: 404 otherwise. */
  private async requireOwnedRunner(req: any, id: string): Promise<void> {
    const { userId, organizationId } = this.context(req);
    await this.service.getOwned(id, userId, organizationId);
  }

  /**
   * Gate for the coding bridge: 404 unknown runner or one the caller may
   * not use (someone else's private runner, a team runner of a team they
   * are not on), 403 when the runner belongs to a different organization.
   */
  private async requireOrgRunner(req: any, id: string): Promise<void> {
    const { userId, organizationId } = this.context(req);
    await this.service.getUsable(id, userId, organizationId);
  }

  private assertSessionId(sessionId: string): void {
    if (!CODING_SESSION_ID_RE.test(sessionId)) {
      throw new HttpException('invalid coding session id', HttpStatus.BAD_REQUEST);
    }
  }

  private async dispatch(
    req: any,
    runnerId: string,
    method: string,
    params: unknown,
    workspaceId?: string,
  ) {
    try {
      // The caller travels with the dispatch so resolveForDispatch
      // re-checks visibility at the point of use, not just at the gate.
      const resp = await this.calls.dispatch(runnerId, method, params, workspaceId, {
        callerUserId: req.user?.id ?? null,
      });
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
