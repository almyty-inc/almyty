import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Logger,
  NotFoundException,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request, Response } from 'express';
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

  constructor(
    private readonly agentsService: AgentsService,
    private readonly executionEngine: AgentExecutionEngine,
    @InjectRepository(ApiKey) private readonly apiKeys: Repository<ApiKey>,
  ) {}

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

      const internal = fromAnthropicRequest(body);

      // Streaming is not implemented on this route yet. A client that
      // asked for SSE and got one JSON object gets a parse failure it
      // cannot explain, so say so plainly instead: an error naming the
      // limitation is debuggable, a wrong shape is not.
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

      const agent = await this.resolveAgent(internal.model, apiKey.organizationId);

      const execution = await this.executionEngine.execute(agent, apiKey.organizationId, apiKey.userId || null, {
        input: this.toAgentInput(internal),
        metadata: { triggerType: 'api', protocol: 'anthropic_messages' },
      });

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
   * The tools and the tool choice have to travel with it. Dropping them
   * here was the bug: the translator carried them, the engine never saw
   * them, and a client that declared tools got an answer that could never
   * call one -- its loop simply ended.
   */
  private toAgentInput(internal: ReturnType<typeof fromAnthropicRequest>): Record<string, any> {
    const last = [...internal.messages].reverse().find((m) => m.role === 'user');
    return {
      message: last?.content ?? '',
      messages: internal.messages,
      ...(internal.systemPrompt ? { systemPrompt: internal.systemPrompt } : {}),
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
      usage: { outputTokens: execution.totalTokens ?? 0 },
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
