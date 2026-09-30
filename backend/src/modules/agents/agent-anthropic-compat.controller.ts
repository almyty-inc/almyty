import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
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

import { ApiKey } from '../../entities/api-key.entity';
import { Agent } from '../../entities/agent.entity';
import { AgentsService } from './agents.service';
import {
  AnthropicRequestInvalid,
  fromAnthropicRequest,
  toAnthropicError,
  toAnthropicResponse,
  type AnthropicMessagesRequest,
} from './protocols/anthropic-messages';
import { CompatRateLimiter } from './compat-rate-limit.helper';
import { renderConversation, unsupportedAnthropicField, withSamplingOverrides } from './compat-conversation.helper';
import { authenticateCompatKey, resolveCompatAgent, touchCompatKeyLastUsed } from './compat-auth.helper';
import { ExecutionAccessService } from '../../common/authorization/execution-access.service';
import {
  CompatAgentInvoker,
  CompatFailure,
  CompatOutcome,
  toolCallsIn,
  USAGE_SPLIT_HEADER,
  USAGE_SPLIT_IN_STREAM,
} from './compat-agent-invoker.service';

/** An idle stream gets a `ping` event this often, as Anthropic's own does, so proxies keep it open. */
const PING_MS = 15_000;

/** A failed run, as the Anthropic API would report it. */
const ANTHROPIC_FAILURE: Record<CompatFailure, { status: number; type: string }> = {
  execution_failed: { status: 502, type: 'api_error' },
  answer_superseded: { status: 502, type: 'api_error' },
  needs_input: { status: 409, type: 'invalid_request_error' },
  client_closed: { status: 499, type: 'api_error' },
  timeout: { status: 504, type: 'api_error' },
  // Anthropic refuses a request over an exhausted credit balance or usage
  // limit with a 400 invalid_request_error, which its SDKs do not retry --
  // the right outcome for a budget that will not reset within a retry.
  budget: { status: 400, type: 'invalid_request_error' },
};

/**
 * `POST /v1/messages`: point an Anthropic client at an almyty agent.
 *
 * A thin shell: the request is translated at the edge
 * (protocols/anthropic-messages.ts), the agent runs through the invocation
 * path /v1/chat/completions uses (CompatAgentInvoker), and the outcome is
 * written back in Anthropic's shapes -- a Message, or the message_start /
 * content_block_delta / message_stop event stream. The key rules, the rate
 * limit, autonomous agents, budgets and token streaming are therefore the
 * same on both routes by construction rather than by keeping two copies in
 * step, which is how this route came to send every autonomous agent to the
 * pipeline engine to fail.
 */
@Controller('v1')
@ApiTags('Anthropic Compatible')
export class AgentAnthropicCompatController {
  private readonly logger = new Logger(AgentAnthropicCompatController.name);

  /** Per-key fixed-window limiter, the same one /v1/chat/completions uses. */
  private readonly rateLimiter: CompatRateLimiter;

  constructor(
    private readonly agentsService: AgentsService,
    private readonly invoker: CompatAgentInvoker,
    @InjectRepository(ApiKey) private readonly apiKeys: Repository<ApiKey>,
    // Optional so unit tests (and any Redis-less boot) construct cleanly and
    // fall back to the per-pod in-memory counter.
    @Optional() @InjectRedis() private readonly redis?: Redis.Redis,
    // The team/private execution gate. @Optional() only to keep the
    // positional spec harnesses' order; a request refuses to run without it.
    @Optional() private readonly executionAccess?: ExecutionAccessService,
  ) {
    this.rateLimiter = new CompatRateLimiter('anthropic_rl', this.logger, this.redis);
  }

  @Post('messages')
  // Nest answers a POST with 201 by default; Anthropic answers 200.
  @HttpCode(200)
  @ApiOperation({ summary: 'Create a message (Anthropic-compatible)' })
  @ApiBearerAuth()
  @ApiBody({ description: 'Anthropic Messages request. `model` names the agent, as "agent:<id>" or its name.' })
  @ApiResponse({ status: 200, description: 'Anthropic-shaped message response, or its event stream with "stream": true' })
  @ApiResponse({ status: 400, description: 'Invalid request, a refused field, or a spend budget that is used up' })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
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

      // Per-key rate limit, at parity with /v1/chat/completions: headers on
      // every response, Retry-After on a refusal, the Anthropic error shape.
      const rateLimit = await this.rateLimiter.track(apiKey.id);
      this.rateLimiter.setHeaders(res, rateLimit);
      if (rateLimit.limited) {
        return res.status(429).json(toAnthropicError(429, 'Rate limit exceeded. Please retry after a moment.', 'rate_limit_error'));
      }

      const internal = fromAnthropicRequest(body);

      // Refused by name, before anything runs: see unsupportedAnthropicField.
      const unsupported = unsupportedAnthropicField(body);
      if (unsupported) {
        return res.status(400).json(toAnthropicError(400, `${unsupported.param}: ${unsupported.message}`, 'invalid_request_error'));
      }

      if (!this.executionAccess) throw new Error('Agent execution access check is not configured');
      const resolved = await resolveCompatAgent(this.agentsService, internal.model, apiKey, this.executionAccess);

      // The caller's sampling, on a throwaway copy of the agent. Nothing is
      // persisted; see withSamplingOverrides.
      const agent = withSamplingOverrides(resolved, {
        temperature: typeof internal.temperature === 'number' ? internal.temperature : undefined,
        maxTokens: typeof internal.maxTokens === 'number' ? internal.maxTokens : undefined,
      });

      await touchCompatKeyLastUsed(this.apiKeys, apiKey);

      const input = this.toAgentInput(internal);
      if (internal.stream) return this.stream(agent, input, apiKey, body.model, req, res);

      const outcome = await this.invoker.invoke(agent, input, apiKey, { protocol: 'anthropic_messages' });
      res.setHeader(USAGE_SPLIT_HEADER, outcome.split);
      if (!outcome.ok) {
        const failure = ANTHROPIC_FAILURE[outcome.failure];
        return res.status(failure.status).json(toAnthropicError(failure.status, outcome.message, failure.type));
      }
      return res.status(200).json(toAnthropicResponse(this.toInternalResponse(outcome, body.model)));
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
   * The answer as Anthropic's event stream.
   *
   * message_start and the text block open before the run starts; the text
   * arrives as content_block_delta events, token by token when the agent's
   * answer is one model call's text and in one piece at the end otherwise
   * (CompatAgentInvoker); message_delta carries the stop reason and usage,
   * and message_stop closes it. A run that fails after the headers went out
   * ends with an `error` event, which the SDK raises.
   */
  private async stream(agent: Agent, input: Record<string, any>, apiKey: ApiKey, model: string, req: Request, res: Response) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader(USAGE_SPLIT_HEADER, USAGE_SPLIT_IN_STREAM);

    let clientAlive = true;
    const abort = new AbortController();
    const markClosed = () => {
      clientAlive = false;
      if (!abort.signal.aborted) abort.abort();
    };
    req.on('close', markClosed);
    req.on('aborted', markClosed);
    const send = (event: string, data: Record<string, any>) => {
      if (clientAlive) res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    };

    send('message_start', {
      message: {
        id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        // Not known until the run has recorded its steps; the real numbers
        // come in message_delta, which the SDKs take over these.
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    const ping = setInterval(() => send('ping', {}), PING_MS);
    ping.unref?.();

    try {
      const outcome = await this.invoker.invoke(agent, input, apiKey, {
        protocol: 'anthropic_messages',
        signal: abort.signal,
        onDelta: (text) => send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
      });
      if (!clientAlive) return;
      if (!outcome.ok) {
        send('error', { error: { type: ANTHROPIC_FAILURE[outcome.failure].type, message: outcome.message } });
        return;
      }

      send('content_block_stop', { index: 0 });
      const response = toAnthropicResponse(this.toInternalResponse(outcome, model));
      // Tool uses the run's output carries, after the text, as the
      // non-streaming response has them.
      response.content
        .filter((block) => block.type === 'tool_use')
        .forEach((block: any, i) => {
          const index = i + 1;
          send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
          send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
          send('content_block_stop', { index });
        });
      send('message_delta', {
        delta: { stop_reason: response.stop_reason, stop_sequence: null },
        usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
      });
      send('message_stop', {});
    } catch (error: any) {
      this.logger.error(`[MESSAGES_STREAM] Unexpected error: ${error?.message}`, error?.stack);
      send('error', { error: { type: 'api_error', message: error?.message || 'Internal server error' } });
    } finally {
      clearInterval(ping);
      req.off('close', markClosed);
      req.off('aborted', markClosed);
      if (clientAlive) res.end();
    }
  }

  /**
   * The conversation, the way the agent engine takes input.
   *
   * `/v1/messages` is stateless: the `messages` array IS the conversation and
   * an Anthropic client resends it whole every turn. An `llm_call` node binds
   * `{{input.message}}`, so anything not in `message` reaches no model;
   * renderConversation folds the turns and the `system` prompt into it. The
   * structured fields stay alongside for a prompt that binds them deliberately.
   */
  private toAgentInput(internal: ReturnType<typeof fromAnthropicRequest>): Record<string, any> {
    const conversation = renderConversation(internal.messages as any, internal.systemPrompt);
    return {
      message: conversation.message,
      latestMessage: conversation.latestMessage,
      messages: internal.messages,
      ...(conversation.systemPrompt ? { systemPrompt: conversation.systemPrompt } : {}),
      ...(internal.maxTokens ? { maxTokens: internal.maxTokens } : {}),
      ...(internal.temperature !== undefined ? { temperature: internal.temperature } : {}),
    };
  }

  /**
   * What the run produced, in the shape the translator expects. A turn that
   * called tools must come back as tool_use blocks with stop_reason
   * "tool_use", or the client sees a finished turn and runs nothing.
   */
  private toInternalResponse(outcome: CompatOutcome, model: string) {
    const toolCalls = this.toolCallsFrom(outcome.output);
    return {
      id: `msg_${outcome.id}`,
      model,
      content: outcome.content ?? '',
      ...(toolCalls.length ? { toolCalls } : {}),
      finishReason: 'stop',
      // Measured for a workflow run (the provider's split, summed over its
      // llm_call steps); 0/0 against a real total otherwise, which the
      // x-almyty-usage-split header distinguishes.
      usage: { inputTokens: outcome.usage?.inputTokens ?? 0, outputTokens: outcome.usage?.outputTokens ?? 0 },
    };
  }

  /** Tool calls an agent run produced, wherever the engine recorded them. */
  private toolCallsFrom(output: any): Array<{ id: string; name: string; arguments: string }> {
    return toolCallsIn(output)
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

  /** See compat-auth.helper: the same key policy as the OpenAI route. */
  private async authenticate(authHeader?: string, xApiKey?: string): Promise<ApiKey> {
    const token = xApiKey?.trim() || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '');
    if (!token) throw new UnauthorizedException('Missing API key. Send it as x-api-key or Authorization: Bearer.');
    return authenticateCompatKey(this.apiKeys, token);
  }
}
