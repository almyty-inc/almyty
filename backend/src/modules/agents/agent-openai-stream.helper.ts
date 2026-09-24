import { Injectable, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

import { Agent } from '../../entities/agent.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { AgentExecutionEngine, StreamEvent } from './agent-execution.engine';
import { compatPrincipal } from './compat-auth.helper';

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
 * Says whether the prompt/completion split in `usage` is a real measurement.
 *
 * It was once papered over by splitting the total 60/40, which is
 * shape-conformant and invented -- anyone attributing cost from it was wrong
 * and had no way to tell. The run now records the split the provider
 * reported, so the usual answer is `measured`. It is still `unavailable`
 * for a run whose nodes reported no split at all (an execution recorded
 * before the split was kept, or a pipeline with no llm_call in it), and the
 * header says which of the two a caller is looking at.
 */
export const USAGE_SPLIT_HEADER = 'x-almyty-usage-split';
export const USAGE_SPLIT_UNAVAILABLE = 'unavailable';
export const USAGE_SPLIT_MEASURED = 'measured';
/**
 * A streamed response must flush its headers before the run starts, so at
 * header time the split is not known yet. It arrives in the final usage
 * chunk instead (with stream_options.include_usage), and this value points
 * the caller there rather than claiming a split that is merely not counted.
 */
export const USAGE_SPLIT_IN_STREAM = 'in-stream';

/** Whether this run carries a real prompt/completion split. */
export function usageSplitState(execution: any): string {
  const input = execution?.inputTokens || 0;
  const output = execution?.outputTokens || 0;
  return input > 0 || output > 0 ? USAGE_SPLIT_MEASURED : USAGE_SPLIT_UNAVAILABLE;
}

@Injectable()
export class AgentOpenAIStreamHelper {
  private readonly logger = new Logger(AgentOpenAIStreamHelper.name);

  constructor(private readonly executionEngine: AgentExecutionEngine) {}

  /**
   * The `usage` object for a run.
   *
   * All three numbers are what the run actually recorded: the node executor
   * keeps the provider's input/output split and the engine sums it. A run
   * with no llm_call in it reports 0/0 with a real total, which the
   * USAGE_SPLIT_HEADER distinguishes from a measured split.
   */
  private usageFor(execution: any) {
    return {
      prompt_tokens: execution?.inputTokens || 0,
      completion_tokens: execution?.outputTokens || 0,
      total_tokens: execution?.totalTokens || 0,
    };
  }

  async handleSync(
    agent: Agent,
    input: Record<string, any>,
    apiKey: ApiKey,
    res: Response,
  ) {
    const execution = await this.executionEngine.execute(
      agent,
      apiKey.organizationId,
      apiKey.userId || null,
      { input, principal: compatPrincipal(apiKey) },
    );

    res.setHeader(USAGE_SPLIT_HEADER, usageSplitState(execution));

    // A run that did not complete is a failure, and `finish_reason: "error"`
    // was never a way to say so: "error" is not one of the OpenAI values
    // (stop, length, tool_calls, content_filter, function_call), so a consumer
    // switching on it falls through to its default and reads a truncated or
    // empty answer as a finished one. Report the failure as a failure, in the
    // error shape, the way the Anthropic sibling does.
    if (execution.status !== 'completed') {
      return res.status(502).json({
        error: {
          message: (execution as any).error || 'The agent did not complete this request',
          type: 'api_error',
          code: 'agent_execution_failed',
          param: null,
        },
      });
    }

    const outputContent =
      execution.output != null
        ? typeof execution.output === 'string'
          ? execution.output
          : JSON.stringify(execution.output)
        : '';

    const response = {
      id: `chatcmpl-${execution.id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `agent:${agent.id}`,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: outputContent },
          finish_reason: 'stop',
        },
      ],
      usage: this.usageFor(execution),
    };

    return res.json(response);
  }

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
      const execution = await this.executionEngine.execute(
        agent,
        apiKey.organizationId,
        apiKey.userId || null,
        { input, signal: abortController.signal, principal: compatPrincipal(apiKey) },
        (event: StreamEvent) => {
          if (!clientAlive) return;

          if (event.type === 'node.output' || event.type === 'node.completed') {
            const content =
              typeof event.data?.output === 'string'
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

      if (!clientAlive) {
        logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, 200, 'stream-client-closed');
        return;
      }

      // A run that came back without completing is a failure that reached the
      // client as a normally-terminated stream. Terminate it as an error.
      if (execution && execution.status !== 'completed') {
        this.endWithError(
          res,
          completionId,
          created,
          agent,
          (execution as any).error || 'The agent did not complete this request',
          'agent_execution_failed',
        );
        logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, 502, 'stream-error');
        return;
      }

      this.writeSSE(res, {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: `agent:${agent.id}`,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });

      // `stream_options: { include_usage: true }` asks for one further chunk
      // carrying usage, with an empty choices array, before [DONE]. Without it
      // a caller that asked gets no usage at all and no sign it was dropped.
      if (streamOptions.includeUsage) {
        this.writeSSE(res, {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: `agent:${agent.id}`,
          choices: [],
          usage: this.usageFor(execution),
        });
      }

      res.write('data: [DONE]\n\n');
      res.end();
      logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, 200, 'stream');
    } catch (error: any) {
      this.logger.error(`[STREAMING] Error during agent execution: ${error.message}`, error.stack);

      if (clientAlive) {
        this.endWithError(res, completionId, created, agent, error?.message || 'Internal server error', 'internal_error');
      }
      logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, 500, 'stream-error');
    } finally {
      logCtx.req.off('close', markClosed);
      logCtx.req.off('aborted', markClosed);
    }
  }

  /**
   * End a stream that failed after the headers went out.
   *
   * The headers are long flushed by the time an engine failure surfaces, so the
   * status code cannot say anything any more -- the SSE body has to. The real
   * OpenAI API emits a frame carrying an `error` object, and both SDKs surface
   * that as a raised error. What this used to send instead was a chunk with
   * `finish_reason: "error"` followed by [DONE], which reads to an SDK as a
   * stream that ended normally holding a truncated answer: a silent failure.
   */
  private endWithError(
    res: Response,
    completionId: string,
    created: number,
    agent: Agent,
    message: string,
    code: string,
  ): void {
    this.writeSSE(res, {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: `agent:${agent.id}`,
      error: {
        message,
        type: 'api_error',
        code,
        param: null,
      },
    });

    res.write('data: [DONE]\n\n');
    res.end();
  }

  private writeSSE(res: Response, data: any): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
