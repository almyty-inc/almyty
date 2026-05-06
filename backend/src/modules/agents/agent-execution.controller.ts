import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  Res,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';

import { AgentsService } from './agents.service';
import { AgentExecutionEngine, StreamEvent } from './agent-execution.engine';
import { AgentStatus } from '../../entities/agent.entity';
import { InvokeAgentDto } from './dto/invoke-agent.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Agent invoke / stream endpoints. Split out of the main
 * AgentsController so the controller can stay focused on agent CRUD.
 */
@Controller('agents')
@ApiTags('Agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentExecutionController {
  private readonly logger = new Logger(AgentExecutionController.name);

  constructor(
    private readonly agentsService: AgentsService,
    private readonly executionEngine: AgentExecutionEngine,
  ) {}

  @Post(':id/invoke')
  @Roles('member', 'admin', 'owner')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Invoke/execute an agent' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiBody({ description: 'Agent invocation input, variables, and metadata' })
  @ApiResponse({ status: 200, description: 'Agent executed successfully' })
  @ApiResponse({ status: 400, description: 'Agent not active or invalid input' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded (30 requests per minute)' })
  async invokeAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(ValidationPipe) invokeDto: InvokeAgentDto,
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
      const agent = await this.agentsService.getAgent(id, organizationId);

      if (agent.status !== AgentStatus.ACTIVE) {
        throw new HttpException(
          { success: false, message: 'Agent must be active to invoke', error: 'AGENT_NOT_ACTIVE' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const execution = await this.executionEngine.execute(
        agent,
        organizationId,
        userId,
        {
          input: invokeDto.input,
          variables: invokeDto.variables,
          metadata: invokeDto.metadata,
        },
      );

      return {
        success: execution.status === 'completed',
        data: execution,
        message: execution.status === 'completed'
          ? 'Agent executed successfully'
          : `Agent execution ${execution.status}: ${execution.error || ''}`,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'AGENT_INVOKE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':id/stream')
  @Roles('member', 'admin', 'owner')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Stream agent execution via SSE' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiBody({ description: 'Agent invocation input, variables, and metadata' })
  @ApiResponse({ status: 200, description: 'SSE stream of execution events' })
  @ApiResponse({ status: 400, description: 'Agent not active or invalid input' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded (30 requests per minute)' })
  async streamAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(ValidationPipe) invokeDto: InvokeAgentDto,
    @Request() req: any,
    @Res() res: Response,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          message: 'No organization found',
          error: 'NO_ORGANIZATION',
        });
        return;
      }

      const userId = req.user.sub || req.user.id;
      const agent = await this.agentsService.getAgent(id, organizationId);

      if (agent.status !== AgentStatus.ACTIVE) {
        res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          message: 'Agent must be active to invoke',
          error: 'AGENT_NOT_ACTIVE',
        });
        return;
      }

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Client disconnect handling. Two responsibilities:
      //   1. suppress further res.write() so EPIPE doesn't bubble
      //      into the engine's error path
      //   2. fire an AbortController whose signal is threaded all
      //      the way down through the engine, LLM provider calls,
      //      and tool HTTP calls, so a browser tab close actually
      //      cancels the real work instead of running the pipeline
      //      to completion and discarding the output
      let clientClosed = false;
      const abortController = new AbortController();
      const markClosed = () => {
        clientClosed = true;
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      };
      req.on('close', markClosed);
      req.on('aborted', markClosed);

      const onEvent = (event: StreamEvent) => {
        if (clientClosed) return;
        const data = JSON.stringify(event);
        try {
          res.write(`event: ${event.type}\ndata: ${data}\n\n`);
        } catch {
          clientClosed = true;
        }
      };

      const execution = await this.executionEngine.execute(
        agent,
        organizationId,
        userId,
        {
          input: invokeDto.input,
          variables: invokeDto.variables,
          metadata: invokeDto.metadata,
          signal: abortController.signal,
        },
        onEvent,
      );

      // Send final result (only if the client is still listening)
      if (!clientClosed) {
        res.write(`event: done\ndata: ${JSON.stringify({ executionId: execution.id, status: execution.status })}\n\n`);
        res.end();
      }
    } catch (error) {
      this.logger.error(`[STREAM] Agent stream failed: ${error.message}`, error.stack);
      // If headers haven't been sent yet, send error as JSON
      if (!res.headersSent) {
        res.status(error.status || HttpStatus.BAD_REQUEST).json({
          success: false,
          message: error.message,
          error: 'AGENT_STREAM_FAILED',
        });
      } else {
        // Headers already sent (SSE started), send error as SSE event
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
          res.end();
        } catch {
          // Client already gone — nothing to do.
        }
      }
    }
  }
}
