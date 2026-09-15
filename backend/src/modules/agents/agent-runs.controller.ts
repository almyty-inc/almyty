import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { traceFor } from './strategies/run-trace';
import {
  Controller,
  Optional,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  Res,
  ParseUUIDPipe,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';

import { AgentRuntimeService } from './agent-runtime.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('agents')
@ApiTags('Agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentRunsController {
  private readonly logger = new Logger(AgentRunsController.name);

  constructor(
    private readonly runtimeService: AgentRuntimeService,
    // @Optional() so the harnesses that build this controller without the
    // execution repository keep resolving. Adding a required dependency to
    // a controller this widely constructed breaks every one of them, which
    // is a poor trade for one endpoint.
    @Optional()
    @InjectRepository(AgentExecution)
    private readonly executions?: Repository<AgentExecution>,
  ) {}

  /**
   * Where this run's requests actually went.
   *
   * Derived from what the run already recorded rather than from a trace
   * nobody was writing: a node result carries the model that answered,
   * the ones tried before it, what the policy rejected, and the timings.
   */
  @Get(':id/executions/:executionId/trace')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'Where a run\'s requests went, hop by hop' })
  async trace(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @Request() req: any,
  ) {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException(
        { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!this.executions) {
      throw new HttpException(
        { success: false, message: 'Run traces are not available here', error: 'TRACE_UNAVAILABLE' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // Scoped by agent as well as organization: without the agentId any
    // execution in the caller's org would resolve through any agent's URL.
    const execution = await this.executions.findOne({
      where: { id: executionId, organizationId, agentId: id },
    });
    if (!execution) {
      throw new HttpException(
        { success: false, message: 'Run not found', error: 'RUN_NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }

    return { success: true, data: traceFor(execution) };
  }

  // ── Autonomous Agent Runs ──

  @Post(':id/runs')
  @Roles('member', 'admin', 'owner')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Start a new autonomous agent run' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiBody({ description: 'Run input and optional limits' })
  @ApiResponse({ status: 201, description: 'Run started, returns runId' })
  async startRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { input: any; maxSteps?: number; maxCostCents?: number; maxDurationMs?: number; conversationId?: string },
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const userId = req.user.sub || req.user.id;
      const run = await this.runtimeService.startRun(id, organizationId, userId, body.input, {
        maxSteps: body.maxSteps,
        maxCostCents: body.maxCostCents,
        maxDurationMs: body.maxDurationMs,
        conversationId: body.conversationId,
      });

      return {
        success: true,
        data: run,
        message: 'Agent run started',
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'RUN_START_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':id/runs')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'List runs for an agent' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  async listRuns(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Request() req?: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.runtimeService.listRuns(
        id,
        organizationId,
        page ? Number(page) : 1,
        limit ? Number(limit) : 20,
      );

      return {
        success: true,
        data: result.data,
        pagination: { total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages },
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'RUNS_FETCH_FAILED' },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':id/runs/:runId')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get run status and steps' })
  async getRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Pass the :id path segment so the service asserts the run
      // actually belongs to this agent. Previously the :id was
      // decorative — any runId in the caller's org resolved through
      // any /agents/:id/runs/:runId URL.
      const run = await this.runtimeService.getRun(runId, organizationId, id);
      return { success: true, data: run };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'RUN_FETCH_FAILED' },
        error.status || HttpStatus.NOT_FOUND,
      );
    }
  }

  @Get(':id/runs/:runId/stream')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'SSE stream of run progress' })
  async streamRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        res.status(HttpStatus.BAD_REQUEST).json({ success: false, message: 'No organization found' });
        return;
      }

      // Verify run exists AND belongs to this agent path segment.
      await this.runtimeService.getRun(runId, organizationId, id);

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Stream events via Redis Streams (cross-pod)
      const abortController = new AbortController();
      req.on('close', () => abortController.abort());

      try {
        await this.runtimeService.subscribeRunEvents(
          runId,
          (event) => {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          },
          abortController.signal,
        );
      } catch {
        // Stream ended or aborted
      }

      res.write(`event: done\ndata: {}\n\n`);
      if (!res.writableEnded) res.end();
    } catch (error) {
      if (!res.headersSent) {
        res.status(error.status || HttpStatus.BAD_REQUEST).json({ success: false, message: error.message });
      }
    }
  }

  @Post(':id/runs/:runId/input')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Send input to a waiting run (human-in-the-loop)' })
  async sendRunInput(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() body: { input: string },
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const run = await this.runtimeService.sendInput(runId, organizationId, body.input, id);
      return { success: true, data: run, message: 'Input sent to run' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'RUN_INPUT_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':id/runs/:runId/cancel')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Cancel a running run' })
  async cancelRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const run = await this.runtimeService.cancelRun(runId, organizationId, id);
      return { success: true, data: run, message: 'Run cancelled' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'RUN_CANCEL_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
