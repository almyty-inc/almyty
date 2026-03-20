import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Res,
  Logger,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Response } from 'express';
import * as crypto from 'crypto';

import { ApiKey } from '../../entities/api-key.entity';
import { Agent } from '../../entities/agent.entity';
import { AgentsService } from './agents.service';
import { AgentExecutionEngine, StreamEvent } from './agent-execution.engine';

@Controller('v1')
@ApiTags('OpenAI Compatible')
export class AgentOpenAICompatController {
  private readonly logger = new Logger(AgentOpenAICompatController.name);

  constructor(
    private readonly agentsService: AgentsService,
    private readonly executionEngine: AgentExecutionEngine,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepository: Repository<ApiKey>,
  ) {}

  @Post('chat/completions')
  @ApiOperation({ summary: 'Create chat completion (OpenAI-compatible)' })
  @ApiBearerAuth()
  async chatCompletions(
    @Body() body: any,
    @Headers('authorization') auth: string,
    @Res() res: Response,
  ) {
    try {
      // 1. Authenticate via Bearer token (API key)
      const apiKey = await this.authenticateApiKey(auth);

      // 2. Extract agent from model field: "agent:uuid" or "agent:name"
      if (!body.model) {
        return this.sendOpenAIError(res, 400, 'model is required', 'invalid_request_error', 'model_required');
      }

      const agent = await this.resolveAgent(body.model, apiKey.organizationId);

      // 3. Map OpenAI messages to agent input
      const input = this.mapOpenAIToAgentInput(body);

      // 4. Update API key last used
      apiKey.lastUsedAt = new Date();
      await this.apiKeyRepository.save(apiKey);

      // 5. Execute (streaming or sync)
      if (body.stream) {
        return this.handleStreaming(agent, input, apiKey, res);
      } else {
        return this.handleSync(agent, input, apiKey, res);
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        return this.sendOpenAIError(res, 401, error.message, 'authentication_error', 'invalid_api_key');
      }
      if (error instanceof NotFoundException) {
        return this.sendOpenAIError(res, 404, error.message, 'invalid_request_error', 'model_not_found');
      }
      if (error instanceof BadRequestException) {
        return this.sendOpenAIError(res, 400, error.message, 'invalid_request_error', 'bad_request');
      }
      this.logger.error(`[CHAT_COMPLETIONS] Unexpected error: ${error.message}`, error.stack);
      return this.sendOpenAIError(res, 500, 'Internal server error', 'api_error', 'internal_error');
    }
  }

  @Get('models')
  @ApiOperation({ summary: 'List available models/agents (OpenAI-compatible)' })
  @ApiBearerAuth()
  async listModels(
    @Headers('authorization') auth: string,
    @Res() res: Response,
  ) {
    try {
      const apiKey = await this.authenticateApiKey(auth);

      // Update API key last used
      apiKey.lastUsedAt = new Date();
      await this.apiKeyRepository.save(apiKey);

      const agents = await this.agentsService.findAllActive(apiKey.organizationId);

      const response = {
        object: 'list',
        data: agents.map(a => ({
          id: `agent:${a.id}`,
          object: 'model',
          created: Math.floor(new Date(a.createdAt).getTime() / 1000),
          owned_by: 'apifai',
          permission: [],
          root: `agent:${a.id}`,
          parent: null,
        })),
      };

      return res.json(response);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        return this.sendOpenAIError(res, 401, error.message, 'authentication_error', 'invalid_api_key');
      }
      this.logger.error(`[LIST_MODELS] Unexpected error: ${error.message}`, error.stack);
      return this.sendOpenAIError(res, 500, 'Internal server error', 'api_error', 'internal_error');
    }
  }

  // ─── Authentication ──────────────────────────────────────────────────

  private async authenticateApiKey(authHeader: string): Promise<ApiKey> {
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      throw new UnauthorizedException('Missing API key token');
    }

    // API keys are stored as SHA-256 hashes — hash the incoming token before lookup
    const keyHash = crypto.createHash('sha256').update(token).digest('hex');

    const apiKey = await this.apiKeyRepository.findOne({
      where: { keyHash, isActive: true },
      relations: ['organization'],
    });

    if (!apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    if (apiKey.isExpired()) {
      throw new UnauthorizedException('API key has expired');
    }

    return apiKey;
  }

  // ─── Agent Resolution ────────────────────────────────────────────────

  private async resolveAgent(model: string, organizationId: string): Promise<Agent> {
    // model format: "agent:uuid" or "agent:agent-name" or plain "uuid"/"name"
    const agentRef = model.replace(/^agent:/, '');

    // Try by ID first, then by name
    let agent: Agent | null = null;
    try {
      agent = await this.agentsService.getAgent(agentRef, organizationId);
    } catch {
      // getAgent throws NotFoundException — try by name
    }

    if (!agent) {
      agent = await this.agentsService.findByName(agentRef, organizationId);
    }

    if (!agent) {
      throw new NotFoundException(`Agent not found: ${model}`);
    }

    if (agent.status !== 'active') {
      throw new BadRequestException(`Agent is not active: ${agent.name} (status: ${agent.status})`);
    }

    return agent;
  }

  // ─── Input Mapping ───────────────────────────────────────────────────

  private mapOpenAIToAgentInput(body: any): Record<string, any> {
    const messages = body.messages || [];
    const lastUserMessage = [...messages].reverse().find((m: any) => m.role === 'user');

    return {
      message: lastUserMessage?.content || '',
      messages,
      model: body.model,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
    };
  }

  // ─── Sync Response ───────────────────────────────────────────────────

  private async handleSync(
    agent: Agent,
    input: Record<string, any>,
    apiKey: ApiKey,
    res: Response,
  ) {
    const execution = await this.executionEngine.execute(
      agent,
      apiKey.organizationId,
      apiKey.userId || null,
      { input },
    );

    const outputContent = execution.output != null
      ? (typeof execution.output === 'string' ? execution.output : JSON.stringify(execution.output))
      : '';

    const response = {
      id: `chatcmpl-${execution.id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `agent:${agent.id}`,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: outputContent,
          },
          finish_reason: execution.status === 'completed' ? 'stop' : 'error',
        },
      ],
      usage: {
        prompt_tokens: execution.totalTokens > 0 ? Math.floor(execution.totalTokens * 0.6) : 0,
        completion_tokens: execution.totalTokens > 0 ? Math.floor(execution.totalTokens * 0.4) : 0,
        total_tokens: execution.totalTokens || 0,
      },
    };

    return res.json(response);
  }

  // ─── Streaming Response ──────────────────────────────────────────────

  private async handleStreaming(
    agent: Agent,
    input: Record<string, any>,
    apiKey: ApiKey,
    res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const completionId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    // Send initial chunk with role
    this.writeSSE(res, {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: `agent:${agent.id}`,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });

    try {
      await this.executionEngine.execute(
        agent,
        apiKey.organizationId,
        apiKey.userId || null,
        { input },
        (event: StreamEvent) => {
          if (event.type === 'node.output' || event.type === 'node.completed') {
            const content = typeof event.data?.output === 'string'
              ? event.data.output
              : typeof event.data?.chunk === 'string'
                ? event.data.chunk
                : '';

            if (content) {
              this.writeSSE(res, {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: `agent:${agent.id}`,
                choices: [{ index: 0, delta: { content }, finish_reason: null }],
              });
            }
          }
        },
      );

      // Send final chunk
      this.writeSSE(res, {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: `agent:${agent.id}`,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });

      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      this.logger.error(`[STREAMING] Error during agent execution: ${error.message}`, error.stack);

      // Send error chunk and terminate
      this.writeSSE(res, {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: `agent:${agent.id}`,
        choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
      });

      res.write('data: [DONE]\n\n');
      res.end();
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private writeSSE(res: Response, data: any): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  private sendOpenAIError(
    res: Response,
    statusCode: number,
    message: string,
    type: string,
    code: string,
  ) {
    return res.status(statusCode).json({
      error: {
        message,
        type,
        code,
      },
    });
  }
}
