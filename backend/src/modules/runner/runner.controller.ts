import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
  HttpException,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RunnerService, RegisterRunnerInput } from './runner.service';
import { RunnerCallService, RunnerCallError } from './runner-call.service';
import { RegisterRunnerDto } from './dto/register-runner.dto';
import { AgentSpawnDto, AgentStatusDto } from './dto/agent-call.dto';

@Controller('runners')
@UseGuards(JwtAuthGuard)
export class RunnerController {
  constructor(
    private readonly service: RunnerService,
    private readonly calls: RunnerCallService,
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
