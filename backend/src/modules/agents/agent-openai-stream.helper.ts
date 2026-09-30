import { Injectable, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

import { Agent } from '../../entities/agent.entity';
import { ApiKey } from '../../entities/api-key.entity';
import {
  CompatAgentInvoker,
  CompatFailure,
  CompatOutcome,
  USAGE_SPLIT_HEADER,
  USAGE_SPLIT_IN_STREAM,
} from './compat-agent-invoker.service';

// The usage-split header moved to the shared invoker; re-exported so the
// callers that import it from here keep working.
export {
  AUTONOMOUS_ANSWER_TIMEOUT_MS,
  USAGE_SPLIT_HEADER,
  USAGE_SPLIT_IN_STREAM,
  USAGE_SPLIT_MEASURED,
  USAGE_SPLIT_UNAVAILABLE,
  usageSplitState,
} from './compat-agent-invoker.service';

export type LogRequestFn = (
  req: Request,
  apiKeyLast4: string,
  agentId: string,
  startTime: number,
  statusCode: number,
  extra?: string,
) => void;

/** Options a caller can turn on per request. */
export interface StreamOptions {
  /** `stream_options: { include_usage: true }` — a final usage-bearing chunk before `[DONE]`. */
  includeUsage?: boolean;
}

/**
 * An SSE comment this often while nothing else is written. A proxy that sees
 * no bytes for its idle timeout (nginx: 60s) closes the stream, and a run can
 * work that long before its answer starts. Clients skip comment lines.
 */
const KEEPALIVE_MS = 15_000;

/** A failed run, as the OpenAI API would report it. */
const OPENAI_FAILURE: Record<CompatFailure, { status: number; type: string; code: string }> = {
  execution_failed: { status: 502, type: 'api_error', code: 'agent_execution_failed' },
  answer_superseded: { status: 502, type: 'api_error', code: 'answer_superseded' },
  needs_input: { status: 409, type: 'invalid_request_error', code: 'agent_needs_input' },
  client_closed: { status: 499, type: 'api_error', code: 'client_closed_request' },
  timeout: { status: 504, type: 'api_error', code: 'agent_timeout' },
  // OpenAI answers an exhausted quota with 429 insufficient_quota, which is
  // what clients already branch on.
  budget: { status: 429, type: 'insufficient_quota', code: 'insufficient_quota' },
};

function openAIUsage(outcome: CompatOutcome) {
  return {
    prompt_tokens: outcome.usage?.inputTokens ?? 0,
    completion_tokens: outcome.usage?.outputTokens ?? 0,
    total_tokens: outcome.usage?.totalTokens ?? 0,
  };
}

/** `/v1/chat/completions` responses: a run's outcome in the OpenAI wire shapes. */
@Injectable()
export class AgentOpenAIStreamHelper {
  private readonly logger = new Logger(AgentOpenAIStreamHelper.name);

  constructor(private readonly invoker: CompatAgentInvoker) {}

  async handleSync(
    agent: Agent,
    input: Record<string, any>,
    apiKey: ApiKey,
    res: Response,
  ) {
    const outcome = await this.invoker.invoke(agent, input, apiKey, { protocol: 'openai_compat' });
    res.setHeader(USAGE_SPLIT_HEADER, outcome.split);

    if (!outcome.ok) {
      const failure = OPENAI_FAILURE[outcome.failure];
      return res.status(failure.status).json({
        error: { message: outcome.message, type: failure.type, code: failure.code, param: null },
      });
    }

    return res.json({
      id: `chatcmpl-${outcome.id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `agent:${agent.id}`,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: outcome.content },
          finish_reason: 'stop',
        },
      ],
      usage: openAIUsage(outcome),
    });
  }

  /**
   * The same answer as handleSync, as `chat.completion.chunk` events.
   *
   * The content is the run's answer and nothing else: never an intermediate
   * step, never the answer twice. It streams token by token when the agent's
   * answer is one model call's text (a workflow whose output node returns an
   * llm_call's output, or an autonomous agent's answer step) and otherwise
   * arrives in one piece when the run ends; see CompatAgentInvoker.
   */
  async handleStreaming(
    agent: Agent,
    input: Record<string, any>,
    apiKey: ApiKey,
    res: Response,
    logCtx: { req: Request; apiKeyLast4: string; requestStartTime: number },
    logRequest: LogRequestFn,
    streamOptions: StreamOptions = {},
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader(USAGE_SPLIT_HEADER, USAGE_SPLIT_IN_STREAM);

    const completionId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (choices: any[], extra: Record<string, any> = {}) => ({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: `agent:${agent.id}`,
      choices,
      ...extra,
    });

    // Track client disconnect: drop SSE writes once the socket goes
    // away, AND fire an AbortController whose signal threads through
    // the engine, LLM provider, and tool executor so axios calls abort
    // at the socket level.
    let clientAlive = true;
    const abortController = new AbortController();
    const markClosed = () => {
      clientAlive = false;
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    };
    logCtx.req.on('close', markClosed);
    logCtx.req.on('aborted', markClosed);

    this.writeSSE(res, chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]));
    const keepAlive = setInterval(() => {
      if (clientAlive) res.write(': keep-alive\n\n');
    }, KEEPALIVE_MS);
    keepAlive.unref?.();

    try {
      const outcome = await this.invoker.invoke(agent, input, apiKey, {
        protocol: 'openai_compat',
        signal: abortController.signal,
        onDelta: (content) => {
          if (clientAlive) this.writeSSE(res, chunk([{ index: 0, delta: { content }, finish_reason: null }]));
        },
      });

      if (!clientAlive) {
        logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, 200, 'stream-client-closed');
        return;
      }

      // A run that came back without completing is a failure that would
      // otherwise reach the client as a normally-terminated stream.
      if (!outcome.ok) {
        const failure = OPENAI_FAILURE[outcome.failure];
        this.endWithError(res, chunk, outcome.message, failure.type, failure.code);
        logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, failure.status, 'stream-error');
        return;
      }

      this.writeSSE(res, chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]));

      // `stream_options: { include_usage: true }` asks for one further chunk
      // carrying usage, with an empty choices array, before [DONE].
      if (streamOptions.includeUsage) {
        this.writeSSE(res, chunk([], { usage: openAIUsage(outcome) }));
      }

      res.write('data: [DONE]\n\n');
      res.end();
      logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, 200, 'stream');
    } catch (error: any) {
      this.logger.error(`[STREAMING] Error during agent execution: ${error.message}`, error.stack);

      if (clientAlive) {
        this.endWithError(res, chunk, error?.message || 'Internal server error', 'api_error', 'internal_error');
      }
      logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, 500, 'stream-error');
    } finally {
      clearInterval(keepAlive);
      logCtx.req.off('close', markClosed);
      logCtx.req.off('aborted', markClosed);
    }
  }

  /**
   * End a stream that failed after the headers went out.
   *
   * The status code cannot say anything any more, so the SSE body has to.
   * The real OpenAI API emits a frame carrying an `error` object, and both
   * SDKs raise that as an error; a chunk with `finish_reason: "error"` reads
   * to an SDK as a stream that ended normally holding a truncated answer.
   */
  private endWithError(
    res: Response,
    chunk: (choices: any[], extra?: Record<string, any>) => Record<string, any>,
    message: string,
    type: string,
    code: string,
  ): void {
    const { choices: _choices, ...frame } = chunk([]);
    this.writeSSE(res, { ...frame, error: { message, type, code, param: null } });

    res.write('data: [DONE]\n\n');
    res.end();
  }

  private writeSSE(res: Response, data: any): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
