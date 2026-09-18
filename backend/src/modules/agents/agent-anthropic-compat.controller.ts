import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Logger,
  NotFoundException,
  Optional,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request, Response } from 'express';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import * as crypto from 'crypto';

import { Agent } from '../../entities/agent.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { AgentsService } from './agents.service';
import { AgentExecutionEngine } from './agent-execution.engine';
import {
  AnthropicRequestInvalid,
  fromAnthropicRequest,
  toAnthropicError,
  toAnthropicResponse,
  type AnthropicMessagesRequest,
} from './protocols/anthropic-messages';
import { CompatRateLimiter } from './compat-rate-limit.helper';
import { renderConversation, withSamplingOverrides } from './compat-conversation.helper';
import { USAGE_SPLIT_HEADER, usageSplitState } from './agent-openai-stream.helper';

/**
 * `POST /v1/messages`: point an Anthropic client at an almyty agent.
 *
 * The translator for this existed, was thoroughly tested, and had no
 * caller and no route — so docs/models.md claimed Claude Code support
 * that a person could not actually use. This is the route.
 *
 * The thing worth getting right is the tool loop. Anthropic sends tool
 * results as a USER message containing tool_result blocks, and reports a
 * turn that calls tools with `stop_reason: "tool_use"`. Flatten either
 * and the client's loop stops without an error anywhere — the translator
 * handles both, which is why this controller stays a thin shell over it
 * rather than doing its own mapping.
 */
@Controller('v1')
@ApiTags('Anthropic Compatible')
export class AgentAnthropicCompatController {
  private readonly logger = new Logger(AgentAnthropicCompatController.name);

  /**
   * Per-key fixed-window limiter, the same one /v1/chat/completions uses.
   * Without it this route had no per-key counter at all: only the global
   * 100/60s ThrottlerGuard default stood between a valid key and unbounded
   * agent runs on the org's account, far past what the OpenAI sibling permits.
   */
  private readonly rateLimiter: CompatRateLimiter;

  constructor(
    private readonly agentsService: AgentsService,
    private readonly executionEngine: AgentExecutionEngine,
    @InjectRepository(ApiKey) private readonly apiKeys: Repository<ApiKey>,
    // Optional so unit tests (and any Redis-less boot) construct cleanly and
    // fall back to the per-pod in-memory counter.
    @Optional() @InjectRedis() private readonly redis?: Redis.Redis,
  ) {
    this.rateLimiter = new CompatRateLimiter('anthropic_rl', this.logger, this.redis);
  }

  @Post('messages')
  @ApiOperation({ summary: 'Create a message (Anthropic-compatible)' })
  @ApiBearerAuth()
  @ApiBody({ description: 'Anthropic Messages request. `model` names the agent, as "agent:<id>" or its name.' })
  @ApiResponse({ status: 200, description: 'Anthropic-shaped message response' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async messages(
    @Body() body: AnthropicMessagesRequest,
    @Headers('authorization') auth: string,
    @Headers('x-api-key') xApiKey: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      // Anthropic clients send x-api-key; accepting Bearer as well means a
      // caller that already has an almyty key does not need a second shape.
      const apiKey = await this.authenticate(auth, xApiKey);

      // Per-key rate limit, at parity with /v1/chat/completions. Headers go
      // out on every response, and 429 is the Anthropic error shape so a
      // client can branch on it.
      const rateLimit = await this.rateLimiter.track(apiKey.id);
      this.rateLimiter.setHeaders(res, rateLimit);
      if (rateLimit.remaining <= 0) {
        return res
          .status(429)
          .json(
            toAnthropicError(
              429,
              'Rate limit exceeded. Please retry after a moment.',
              'rate_limit_error',
            ),
          );
      }

      const internal = fromAnthropicRequest(body);

      // Streaming is not implemented on this route yet. A client that
      // asked for SSE and got one JSON object gets a parse failure it
      // cannot explain, so say so plainly instead: an error naming the
      // limitation is debuggable, a wrong shape is not.
      // Client-declared tools cannot work here, and saying so is the only
      // honest answer. An almyty agent runs its OWN tools: a tool_call
      // node executes and the run returns the finished answer, so there
      // is no turn at which we could hand a tool back for the client to
      // run. Accepting these and returning a normal answer would leave a
      // client whose tools simply never fire, with nothing to debug --
      // which is worse than a refusal that names the reason.
      if (internal.tools?.length) {
        return res
          .status(400)
          .json(
            toAnthropicError(
              400,
              'This endpoint does not take client-declared tools. An almyty agent runs its own tools and returns the finished answer, ' +
                'so there is no turn at which one could be handed back to you. Give the agent the tools instead.',
              'invalid_request_error',
            ),
          );
      }

      if (internal.stream) {
        return res
          .status(400)
          .json(
            toAnthropicError(
              400,
              'Streaming is not supported on this endpoint yet. Send the request with "stream": false.',
              'invalid_request_error',
            ),
          );
      }

      const resolved = await this.resolveAgent(internal.model, apiKey.organizationId);

      // The caller's sampling, on a throwaway copy of the agent. `temperature`
      // and `max_tokens` were carried out of the request correctly and then
      // never read by anything, so a client asking for temperature 0 got the
      // agent's own sampling and non-deterministic output with nothing saying
      // the field had been ignored. Nothing here is persisted.
      const agent = withSamplingOverrides(resolved, {
        temperature: typeof internal.temperature === 'number' ? internal.temperature : undefined,
        maxTokens: typeof internal.maxTokens === 'number' ? internal.maxTokens : undefined,
      });

      const execution = await this.executionEngine.execute(agent, apiKey.organizationId, apiKey.userId || null, {
        input: this.toAgentInput(internal),
        metadata: { triggerType: 'api', protocol: 'anthropic_messages' },
      });

      // Set after the run, not before it: whether the split was measured is
      // only knowable once the run has recorded its nodes.
      res.setHeader(USAGE_SPLIT_HEADER, usageSplitState(execution));

      if (execution.status !== 'completed') {
        return res
          .status(502)
          .json(toAnthropicError(502, execution.error || 'The agent did not complete this request', 'api_error'));
      }

      return res.status(200).json(toAnthropicResponse(this.toInternalResponse(execution, body.model)));
    } catch (error: any) {
      // Anthropic clients branch on the error shape, so a 400 that looks
      // like our own envelope reads as a transport failure to them.
      if (error instanceof AnthropicRequestInvalid) {
        return res.status(400).json(toAnthropicError(400, error.message, 'invalid_request_error'));
      }
      if (error instanceof UnauthorizedException) {
        return res.status(401).json(toAnthropicError(401, error.message, 'authentication_error'));
      }
      if (error instanceof NotFoundException) {
        return res.status(404).json(toAnthropicError(404, error.message, 'not_found_error'));
      }
      if (error instanceof BadRequestException) {
        return res.status(400).json(toAnthropicError(400, error.message, 'invalid_request_error'));
      }
      this.logger.error(`[MESSAGES] Unexpected error: ${error?.message}`, error?.stack);
      return res.status(500).json(toAnthropicError(500, 'Internal server error', 'api_error'));
    }
  }

  /**
   * The conversation, the way the agent engine takes input.
   *
   * `/v1/messages` is stateless: the `messages` array IS the conversation and
   * an Anthropic client resends it whole every turn. The engine takes a flat
   * input object and an `llm_call` node renders one user message from a prompt
   * template that binds `{{input.message}}`, so anything not in `message` does
   * not reach a model. Passing only the last user line left prior turns -- and
   * the `system` prompt, the most load-bearing field an Anthropic client sends
   * -- carried correctly out of the request and then dropped on the floor.
   * renderConversation folds both into `message`; the structured fields stay
   * alongside for a prompt that binds them deliberately.
   */
  private toAgentInput(internal: ReturnType<typeof fromAnthropicRequest>): Record<string, any> {
    const conversation = renderConversation(internal.messages as any, internal.systemPrompt);
    return {
      message: conversation.message,
      latestMessage: conversation.latestMessage,
      messages: internal.messages,
      ...(conversation.systemPrompt ? { systemPrompt: conversation.systemPrompt } : {}),
      ...(internal.tools?.length ? { tools: internal.tools } : {}),
      ...(internal.toolChoice ? { toolChoice: internal.toolChoice } : {}),
      ...(internal.maxTokens ? { maxTokens: internal.maxTokens } : {}),
      ...(internal.temperature !== undefined ? { temperature: internal.temperature } : {}),
    };
  }

  /**
   * What the run produced, in the shape the translator expects.
   *
   * A turn that called tools must come back as tool_use blocks with
   * stop_reason "tool_use". Hardcoding 'stop' and passing only text was
   * the other half of the same bug: the client saw a finished turn, ran
   * nothing, and the loop stopped without an error anywhere.
   */
  private toInternalResponse(execution: any, model: string) {
    const output = execution.output;
    const toolCalls = this.toolCallsFrom(output);

    const content =
      typeof output === 'string'
        ? output
        : typeof output?.content === 'string'
          ? output.content
          : typeof output?.message === 'string'
            ? output.message
            : output == null || toolCalls.length > 0
              ? ''
              : JSON.stringify(output);

    return {
      id: `msg_${execution.id}`,
      model,
      content,
      ...(toolCalls.length ? { toolCalls } : {}),
      // The translator turns this into stop_reason, and a turn carrying
      // tool uses must report tool_use or the client never runs them.
      finishReason: 'stop',
      // The run records the provider's input/output split, so these are
      // measured rather than apportioned. A pipeline with no llm_call in it
      // reports 0/0 against a real total; the x-almyty-usage-split header
      // distinguishes that case from a measured split.
      usage: {
        inputTokens: execution.inputTokens ?? 0,
        outputTokens: execution.outputTokens ?? 0,
      },
    };
  }

  /** Tool calls an agent run produced, wherever the engine recorded them. */
  private toolCallsFrom(output: any): Array<{ id: string; name: string; arguments: string }> {
    const raw = Array.isArray(output?.toolCalls) ? output.toolCalls : Array.isArray(output?.tool_calls) ? output.tool_calls : [];
    return raw
      .filter((call: any) => call && (call.name || call.function?.name))
      .map((call: any, i: number) => ({
        id: String(call.id ?? `toolu_${i}`),
        name: String(call.name ?? call.function?.name),
        arguments:
          typeof call.arguments === 'string'
            ? call.arguments
            : typeof call.function?.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.arguments ?? call.input ?? {}),
      }));
  }

  private async authenticate(authHeader?: string, xApiKey?: string): Promise<ApiKey> {
    const token = xApiKey?.trim() || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '');
    if (!token) throw new UnauthorizedException('Missing API key. Send it as x-api-key or Authorization: Bearer.');

    const keyHash = crypto.createHash('sha256').update(token).digest('hex');
    const apiKey = await this.apiKeys.findOne({ where: { keyHash, isActive: true }, relations: { organization: true } });

    if (!apiKey) throw new UnauthorizedException('Invalid API key');
    if (apiKey.isExpired()) throw new UnauthorizedException('API key has expired');
    return apiKey;
  }

  private async resolveAgent(model: string, organizationId: string): Promise<Agent> {
    const ref = model.replace(/^agent:/, '');

    let agent: Agent | null = null;
    try {
      agent = await this.agentsService.getAgent(ref, organizationId);
    } catch (err) {
      if (!(err instanceof NotFoundException)) throw err;
    }
    if (!agent) agent = await this.agentsService.findByName(ref, organizationId);
    if (!agent) throw new NotFoundException(`Agent not found: ${model}`);
    if (agent.status !== 'active') {
      throw new BadRequestException(`Agent is not active: ${agent.name} (status: ${agent.status})`);
    }
    return agent;
  }
}
