import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Res,
  Req,
  Logger,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Response, Request } from 'express';
import * as crypto from 'crypto';

import { ApiKey } from '../../entities/api-key.entity';
import { Agent } from '../../entities/agent.entity';
import { AgentsService } from './agents.service';
import { AgentExecutionEngine, StreamEvent } from './agent-execution.engine';

/** Maximum request body size in bytes (1 MB). */
const MAX_BODY_SIZE_BYTES = 1 * 1024 * 1024;

/** Maximum number of messages in a single request. */
const MAX_MESSAGES = 100;

/** Maximum content length per message (100 KB). */
const MAX_MESSAGE_CONTENT_LENGTH = 100 * 1024;

/** Placeholder rate limits (per-key enforcement is done externally; these are informational headers). */
const RATE_LIMIT_RPM = 60;

/** Cap on the in-memory request-count map. Prevents unbounded growth from key churn. */
const MAX_TRACKED_KEYS = 10_000;

/**
 * Throttle window for `lastUsedAt` writes, in milliseconds. Without this we issue
 * one UPDATE per chat-completion request, which is wasteful and races with any
 * concurrent mutation of the api-key row (revocation, scope change).
 */
const LAST_USED_THROTTLE_MS = 60_000;

@Controller('v1')
@ApiTags('OpenAI Compatible')
export class AgentOpenAICompatController {
  private readonly logger = new Logger(AgentOpenAICompatController.name);

  /** Simple per-key request counter for rate limit headers. Resets each minute. */
  private readonly requestCounts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly agentsService: AgentsService,
    private readonly executionEngine: AgentExecutionEngine,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepository: Repository<ApiKey>,
  ) {}

  @Post('chat/completions')
  @ApiOperation({ summary: 'Create chat completion (OpenAI-compatible)' })
  @ApiBearerAuth()
  @ApiBody({ description: 'OpenAI-compatible chat completion request with model, messages, and optional stream flag' })
  @ApiResponse({ status: 200, description: 'Chat completion response in OpenAI format' })
  @ApiResponse({ status: 400, description: 'Invalid request (missing model, empty messages, etc.)' })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key' })
  @ApiResponse({ status: 404, description: 'Agent/model not found' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async chatCompletions(
    @Body() body: any,
    @Headers('authorization') auth: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const requestStartTime = Date.now();
    let apiKeyLast4 = '????';
    let agentId = 'unknown';

    try {
      // 0. Validate request body size
      this.validateRequestBodySize(body);

      // 1. Authenticate via Bearer token (API key)
      const apiKey = await this.authenticateApiKey(auth);
      apiKeyLast4 = this.getKeyLast4(auth);

      // Rate limit tracking
      const rateLimitInfo = this.trackRequestCount(apiKey.id);
      this.setRateLimitHeaders(res, rateLimitInfo);

      if (rateLimitInfo.remaining <= 0) {
        this.logRequest(req, apiKeyLast4, agentId, requestStartTime, 429);
        return this.sendOpenAIError(res, 429, 'Rate limit exceeded. Please retry after a moment.', 'rate_limit_error', 'rate_limit_exceeded');
      }

      // 2. Extract agent from model field: "agent:uuid" or "agent:name"
      if (!body.model) {
        this.logRequest(req, apiKeyLast4, agentId, requestStartTime, 400);
        return this.sendOpenAIError(res, 400, 'model is required', 'invalid_request_error', 'model_required');
      }

      // 3. Validate messages
      this.validateMessages(body);

      const agent = await this.resolveAgent(body.model, apiKey.organizationId);
      agentId = agent.id;

      // 4. Map OpenAI messages to agent input
      const input = this.mapOpenAIToAgentInput(body);

      // 5. Touch lastUsedAt (throttled, partial UPDATE — see notes on
      //    LAST_USED_THROTTLE_MS for the race we're avoiding)
      await this.touchApiKeyLastUsed(apiKey);

      // 6. Execute (streaming or sync)
      if (body.stream) {
        return this.handleStreaming(agent, input, apiKey, res, {
          req,
          apiKeyLast4,
          requestStartTime,
        });
      } else {
        const result = await this.handleSync(agent, input, apiKey, res);
        this.logRequest(req, apiKeyLast4, agentId, requestStartTime, 200);
        return result;
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        this.logRequest(req, apiKeyLast4, agentId, requestStartTime, 401);
        return this.sendOpenAIError(res, 401, error.message, 'authentication_error', 'invalid_api_key');
      }
      if (error instanceof NotFoundException) {
        this.logRequest(req, apiKeyLast4, agentId, requestStartTime, 404);
        return this.sendOpenAIError(res, 404, error.message, 'invalid_request_error', 'model_not_found');
      }
      if (error instanceof BadRequestException) {
        this.logRequest(req, apiKeyLast4, agentId, requestStartTime, 400);
        return this.sendOpenAIError(res, 400, error.message, 'invalid_request_error', 'bad_request');
      }
      this.logger.error(`[CHAT_COMPLETIONS] Unexpected error: ${error.message}`, error.stack);
      this.logRequest(req, apiKeyLast4, agentId, requestStartTime, 500);
      return this.sendOpenAIError(res, 500, 'Internal server error', 'api_error', 'internal_error');
    }
  }

  @Get('models')
  @ApiOperation({ summary: 'List available models/agents (OpenAI-compatible)' })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'List of available agents as OpenAI-compatible models' })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key' })
  async listModels(
    @Headers('authorization') auth: string,
    @Res() res: Response,
  ) {
    try {
      const apiKey = await this.authenticateApiKey(auth);

      // Touch lastUsedAt (throttled partial update)
      await this.touchApiKeyLastUsed(apiKey);

      const agents = await this.agentsService.findAllActive(apiKey.organizationId);

      const response = {
        object: 'list',
        data: agents.map(a => ({
          id: `agent:${a.id}`,
          object: 'model',
          created: Math.floor(new Date(a.createdAt).getTime() / 1000),
          owned_by: 'almyty',
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

  // ─── Request Validation ─────────────────────────────────────────────

  private validateRequestBodySize(body: any): void {
    const bodySize = JSON.stringify(body || {}).length;
    if (bodySize > MAX_BODY_SIZE_BYTES) {
      throw new BadRequestException(
        `Request body size (${bodySize} bytes) exceeds maximum allowed (${MAX_BODY_SIZE_BYTES} bytes)`,
      );
    }
  }

  private validateMessages(body: any): void {
    const messages = body.messages;
    if (!messages || !Array.isArray(messages)) {
      throw new BadRequestException('messages must be an array');
    }

    if (messages.length === 0) {
      throw new BadRequestException('messages array must not be empty');
    }

    if (messages.length > MAX_MESSAGES) {
      throw new BadRequestException(
        `messages array length (${messages.length}) exceeds maximum allowed (${MAX_MESSAGES})`,
      );
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object') {
        throw new BadRequestException(`messages[${i}] must be an object`);
      }
      if (!msg.role) {
        throw new BadRequestException(`messages[${i}].role is required`);
      }
      // Validate content length (content can be string or array)
      const contentStr = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content || '');
      if (contentStr.length > MAX_MESSAGE_CONTENT_LENGTH) {
        throw new BadRequestException(
          `messages[${i}].content length (${contentStr.length}) exceeds maximum allowed (${MAX_MESSAGE_CONTENT_LENGTH})`,
        );
      }
    }
  }

  // ─── Rate Limiting ──────────────────────────────────────────────────

  private trackRequestCount(apiKeyId: string): { remaining: number; limit: number; resetAt: number } {
    const now = Date.now();
    const existing = this.requestCounts.get(apiKeyId);

    if (!existing || now >= existing.resetAt) {
      this.evictIfFull(now);
      const resetAt = now + 60_000; // 1 minute window
      this.requestCounts.set(apiKeyId, { count: 1, resetAt });
      return { remaining: RATE_LIMIT_RPM - 1, limit: RATE_LIMIT_RPM, resetAt };
    }

    existing.count++;
    const remaining = Math.max(0, RATE_LIMIT_RPM - existing.count);
    return { remaining, limit: RATE_LIMIT_RPM, resetAt: existing.resetAt };
  }

  /**
   * Bound the request-count map. Without this it grows one entry per unique
   * api-key id seen, with no eviction — a slow memory leak that's bad in any
   * deployment that rotates keys, and easy to weaponise on a public endpoint.
   *
   * Strategy: drop expired entries first; if we're still at capacity, drop
   * the oldest insertion (Map iteration order is insertion order in JS).
   */
  private evictIfFull(now: number): void {
    if (this.requestCounts.size < MAX_TRACKED_KEYS) return;

    for (const [k, v] of this.requestCounts) {
      if (now >= v.resetAt) this.requestCounts.delete(k);
    }
    if (this.requestCounts.size < MAX_TRACKED_KEYS) return;

    const oldest = this.requestCounts.keys().next().value;
    if (oldest !== undefined) this.requestCounts.delete(oldest);
  }

  private setRateLimitHeaders(
    res: Response,
    info: { remaining: number; limit: number; resetAt: number },
  ): void {
    res.setHeader('X-RateLimit-Limit', String(info.limit));
    res.setHeader('X-RateLimit-Remaining', String(info.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(info.resetAt / 1000)));
  }

  // ─── Request Logging ────────────────────────────────────────────────

  private logRequest(
    req: Request,
    apiKeyLast4: string,
    agentId: string,
    startTime: number,
    statusCode: number,
    extra?: string,
  ): void {
    const ip = req?.ip || req?.socket?.remoteAddress || 'unknown';
    const duration = Date.now() - startTime;
    this.logger.log(
      `[OPENAI_COMPAT] ip=${ip} key=***${apiKeyLast4} agent=${agentId} status=${statusCode} duration=${duration}ms${extra ? ` ${extra}` : ''}`,
    );
  }

  private getKeyLast4(authHeader: string): string {
    if (!authHeader) return '????';
    const token = authHeader.replace('Bearer ', '');
    return token.length >= 4 ? token.slice(-4) : token;
  }

  // ─── API key bookkeeping ─────────────────────────────────────────────

  /**
   * Touch the api-key's `lastUsedAt`. Throttled to avoid one UPDATE per
   * request, and uses a partial UPDATE rather than `save(entity)` so we
   * don't race with concurrent writes (revocation, scope change, etc.) by
   * round-tripping the whole entity through a stale in-memory copy.
   */
  private async touchApiKeyLastUsed(apiKey: ApiKey): Promise<void> {
    const now = Date.now();
    const last = apiKey.lastUsedAt ? apiKey.lastUsedAt.getTime() : 0;
    if (now - last < LAST_USED_THROTTLE_MS) return;

    const nowDate = new Date(now);
    await this.apiKeyRepository.update({ id: apiKey.id }, { lastUsedAt: nowDate });
    apiKey.lastUsedAt = nowDate;
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

    // Try by ID first, then by name. Only swallow NotFoundException — a real
    // DB error must propagate, otherwise outages look like "agent not found"
    // to the caller and we lose the actual signal.
    let agent: Agent | null = null;
    try {
      agent = await this.agentsService.getAgent(agentRef, organizationId);
    } catch (err) {
      if (!(err instanceof NotFoundException)) throw err;
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
    logCtx: { req: Request; apiKeyLast4: string; requestStartTime: number },
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const completionId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    // Track client disconnect so we stop pushing chunks into a closed
    // socket the moment the caller hangs up. Without this, every
    // subsequent writeSSE() throws on a destroyed socket and the
    // executionEngine keeps running in the background with each
    // onEvent callback swallowing the write error. We can't abort
    // the execution itself from here (the engine doesn't take an
    // AbortSignal yet — tracked as a follow-up), but we can short-
    // circuit the SSE fan-out so the process isn't burning CPU
    // serialising events into /dev/null for a ghost client.
    let clientAlive = true;
    const markClosed = () => {
      clientAlive = false;
    };
    logCtx.req.on('close', markClosed);
    logCtx.req.on('aborted', markClosed);

    // Send initial chunk with role
    if (clientAlive) {
      this.writeSSE(res, {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: `agent:${agent.id}`,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
    }

    try {
      await this.executionEngine.execute(
        agent,
        apiKey.organizationId,
        apiKey.userId || null,
        { input },
        (event: StreamEvent) => {
          // Client has hung up — drop the event on the floor rather
          // than attempting to write to a closed socket.
          if (!clientAlive) return;

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

      if (clientAlive) {
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
        this.logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, 200, 'stream');
      } else {
        // Execution finished normally but the client is gone.
        // Surface this in logs so we can spot patterns of disconnects.
        this.logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, 200, 'stream-client-closed');
      }
    } catch (error) {
      this.logger.error(`[STREAMING] Error during agent execution: ${error.message}`, error.stack);

      if (clientAlive) {
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
      // Failed streams used to vanish from access logs because the controller-
      // level catch is unreachable once headers are sent. Log here instead.
      this.logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, 500, 'stream-error');
    } finally {
      logCtx.req.off('close', markClosed);
      logCtx.req.off('aborted', markClosed);
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
