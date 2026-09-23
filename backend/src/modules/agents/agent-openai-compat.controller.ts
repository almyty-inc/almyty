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
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import { Response, Request } from 'express';
import * as crypto from 'crypto';

import { ApiKey } from '../../entities/api-key.entity';
import { Agent } from '../../entities/agent.entity';
import { AgentsService } from './agents.service';
import { AgentExecutionEngine, StreamEvent } from './agent-execution.engine';
import { AgentOpenAIStreamHelper } from './agent-openai-stream.helper';
import {
  CompatRateLimiter,
  COMPAT_RATE_LIMIT_RPM,
  type CompatRateLimitInfo,
} from './compat-rate-limit.helper';
import {
  renderConversation,
  unsupportedOpenAIField,
  withSamplingOverrides,
} from './compat-conversation.helper';

/** Maximum request body size in bytes (1 MB). */
const MAX_BODY_SIZE_BYTES = 1 * 1024 * 1024;

/** Maximum number of messages in a single request. */
const MAX_MESSAGES = 100;

/** Maximum content length per message (100 KB). */
const MAX_MESSAGE_CONTENT_LENGTH = 100 * 1024;

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

  /** Per-key fixed-window limiter, shared with the Anthropic-compatible route. */
  private readonly rateLimiter: CompatRateLimiter;

  constructor(
    private readonly agentsService: AgentsService,
    private readonly executionEngine: AgentExecutionEngine,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepository: Repository<ApiKey>,
    private readonly stream: AgentOpenAIStreamHelper,
    // Optional so unit tests (and any Redis-less boot) construct cleanly and
    // fall back to the per-pod in-memory counter. In production Redis is
    // wired by RedisModule, giving a window shared across replicas.
    @Optional() @InjectRedis() private readonly redis?: Redis.Redis,
  ) {
    this.rateLimiter = new CompatRateLimiter('openai_rl', this.logger, this.redis);
  }

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
      const rateLimitInfo = await this.trackRequestCount(apiKey.id);
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

      // 3b. Refuse, by name, the fields this endpoint cannot honour. The
      //     Anthropic sibling already settled the principle for client-declared
      //     tools: a field accepted and then dropped leaves a caller with a
      //     silently different answer and nothing to debug, which is worse than
      //     a refusal that says which field and why.
      const unsupported = unsupportedOpenAIField(body);
      if (unsupported) {
        this.logRequest(req, apiKeyLast4, agentId, requestStartTime, 400, `unsupported=${unsupported.param}`);
        return this.sendOpenAIError(
          res,
          400,
          unsupported.message,
          'invalid_request_error',
          'unsupported_parameter',
          unsupported.param,
        );
      }

      const resolved = await this.resolveAgent(body.model, apiKey.organizationId, apiKey.userId);
      agentId = resolved.id;

      // 4. Map OpenAI messages to agent input
      const input = this.mapOpenAIToAgentInput(body);

      // 4b. The caller's sampling, on a throwaway copy of the agent. Nothing
      //     is persisted; see withSamplingOverrides.
      const agent = withSamplingOverrides(resolved, {
        temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
        maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
      });

      // 5. Touch lastUsedAt (throttled, partial UPDATE — see notes on
      //    LAST_USED_THROTTLE_MS for the race we're avoiding)
      await this.touchApiKeyLastUsed(apiKey);

      // 6. Execute (streaming or sync)
      if (body.stream) {
        return this.stream.handleStreaming(
          agent, input, apiKey, res,
          { req, apiKeyLast4, requestStartTime },
          (...args) => this.logRequest(...args),
          { includeUsage: body.stream_options?.include_usage === true },
        );
      } else {
        const result = await this.stream.handleSync(agent, input, apiKey, res);
        // handleSync answers 502 when the run did not complete, so read the
        // status back rather than logging every sync request as a 200.
        this.logRequest(req, apiKeyLast4, agentId, requestStartTime, res.statusCode || 200);
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

      const agents = await this.agentsService.findAllActive(apiKey.organizationId, apiKey.userId);

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
  //
  // The implementation moved to CompatRateLimiter so /v1/messages shares it
  // instead of running with only the global 100/60s throttler default. These
  // stay as thin delegations.

  private trackRequestCount(apiKeyId: string): Promise<CompatRateLimitInfo> {
    return this.rateLimiter.track(apiKeyId);
  }

  private setRateLimitHeaders(res: Response, info: CompatRateLimitInfo): void {
    this.rateLimiter.setHeaders(res, info);
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
      relations: { organization: true },
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

  // A private agent answers only to its owner's own API key: the key's
  // user is the caller for the visibility check.
  private async resolveAgent(model: string, organizationId: string, callerId: string | null): Promise<Agent> {
    // model format: "agent:uuid" or "agent:agent-name" or plain "uuid"/"name"
    const agentRef = model.replace(/^agent:/, '');

    // Try by ID first, then by name. Only swallow NotFoundException — a real
    // DB error must propagate, otherwise outages look like "agent not found"
    // to the caller and we lose the actual signal.
    let agent: Agent | null = null;
    try {
      agent = await this.agentsService.getAgent(agentRef, organizationId, callerId ? { id: callerId } : null);
    } catch (err) {
      if (!(err instanceof NotFoundException)) throw err;
    }

    if (!agent) {
      agent = await this.agentsService.findByName(agentRef, organizationId, callerId);
    }

    if (!agent) {
      throw new NotFoundException(`Agent not found: ${model}`);
    }

    if (agent.status !== 'active') {
      throw new BadRequestException(`Agent is not active: ${agent.name} (status: ${agent.status})`);
    }

    return agent;
  }

  /**
   * The request, in the shape the agent engine takes.
   *
   * `/v1/chat/completions` is stateless: the `messages` array IS the
   * conversation, resent whole on every turn. Handing the engine only the
   * last user line -- which is what this did -- made every multi-turn client
   * (the SDK's own chat loop, LangChain's ChatOpenAI, any web chat UI) talk to
   * an agent that could not see what had already been said, with no error and
   * no header to notice it from. The conversation is rendered into `message`
   * because that is the field every stock agent prompt binds; see
   * compat-conversation.helper for why a sibling field would not have worked.
   */
  private mapOpenAIToAgentInput(body: any): Record<string, any> {
    const messages = body.messages || [];
    const conversation = renderConversation(messages);

    return {
      message: conversation.message,
      latestMessage: conversation.latestMessage,
      ...(conversation.systemPrompt ? { systemPrompt: conversation.systemPrompt } : {}),
      messages,
      model: body.model,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
    };
  }

  private sendOpenAIError(
    res: Response,
    statusCode: number,
    message: string,
    type: string,
    code: string,
    param?: string,
  ) {
    return res.status(statusCode).json({
      error: {
        message,
        type,
        code,
        param: param ?? null,
      },
    });
  }
}
