import { Injectable, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

import { Agent } from '../../entities/agent.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { AgentExecutionEngine, StreamEvent } from './agent-execution.engine';

export type LogRequestFn = (
  req: Request,
  apiKeyLast4: string,
  agentId: string,
  startTime: number,
  statusCode: number,
  extra?: string,
) => void;

@Injectable()
export class AgentOpenAIStreamHelper {
  private readonly logger = new Logger(AgentOpenAIStreamHelper.name);

  constructor(private readonly executionEngine: AgentExecutionEngine) {}

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
      { input },
    );

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

  async handleStreaming(
    agent: Agent,
    input: Record<string, any>,
    apiKey: ApiKey,
    res: Response,
    logCtx: { req: Request; apiKeyLast4: string; requestStartTime: number },
    logRequest: LogRequestFn,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

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
      await this.executionEngine.execute(
        agent,
        apiKey.organizationId,
        apiKey.userId || null,
        { input, signal: abortController.signal },
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

      if (clientAlive) {
        this.writeSSE(res, {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: `agent:${agent.id}`,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });

        res.write('data: [DONE]\n\n');
        res.end();
        logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, 200, 'stream');
      } else {
        logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, 200, 'stream-client-closed');
      }
    } catch (error: any) {
      this.logger.error(`[STREAMING] Error during agent execution: ${error.message}`, error.stack);

      if (clientAlive) {
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
      logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, 500, 'stream-error');
    } finally {
      logCtx.req.off('close', markClosed);
      logCtx.req.off('aborted', markClosed);
    }
  }

  private writeSSE(res: Response, data: any): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
