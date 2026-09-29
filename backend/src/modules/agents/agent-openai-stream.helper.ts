import { Injectable, Logger, Optional } from '@nestjs/common';
import { Request, Response } from 'express';

import { Agent } from '../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { AgentExecutionEngine } from './agent-execution.engine';
import { AgentRuntimeService } from './agent-runtime.service';
import { runsOnAutonomousRuntime } from './agent-invocation';
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

/** How long a compat request waits on an autonomous run before cancelling it. */
export const AUTONOMOUS_ANSWER_TIMEOUT_MS = 10 * 60_000;
/** How often the run row is re-read while an autonomous run works. */
const AUTONOMOUS_POLL_MS = 500;
/**
 * An SSE comment this often while nothing else is written. The answer only
 * arrives when the run ends, and a proxy that sees no bytes for its idle
 * timeout (nginx: 60s) closes the stream first. Clients skip comment lines.
 */
const KEEPALIVE_MS = 15_000;

/** The run states in which an autonomous run waits on a person. */
const WAITING_ON_A_PERSON: string[] = [AgentRunStatus.WAITING_INPUT, AgentRunStatus.WAITING_APPROVAL];
const RUN_FINISHED: string[] = [
  AgentRunStatus.COMPLETED,
  AgentRunStatus.FAILED,
  AgentRunStatus.CANCELLED,
  AgentRunStatus.TIMEOUT,
];

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** What one compat request's run came to, whichever engine ran it. */
/**
 * What one compat request's run came to, whichever engine ran it: an answer
 * (`ok`, with id/content/usage) or a failure (status/type/code/message). One
 * flat shape because this project compiles without strictNullChecks, which
 * leaves a discriminated union on `ok` un-narrowable.
 */
interface CompatOutcome {
  ok: boolean;
  split: string;
  id?: string;
  content?: string;
  usage?: Usage;
  status?: number;
  type?: string;
  code?: string;
  message?: string;
}

/** A run's output as the assistant message text. */
function outputText(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  // The autonomous runtime's final answer is `{ text }` on some paths.
  if (typeof (output as any).text === 'string') return (output as any).text;
  return JSON.stringify(output);
}

@Injectable()
export class AgentOpenAIStreamHelper {
  private readonly logger = new Logger(AgentOpenAIStreamHelper.name);

  constructor(
    private readonly executionEngine: AgentExecutionEngine,
    // Needed only for an autonomous agent. @Optional() so the unit harnesses
    // that build this helper with the pipeline engine alone keep working; an
    // autonomous agent asked for without it gets a plain failure.
    @Optional() private readonly runtime?: AgentRuntimeService,
  ) {}

  /**
   * The `usage` object for a run.
   *
   * All three numbers are what the run actually recorded: the node executor
   * keeps the provider's input/output split and the engine sums it. A run
   * with no llm_call in it reports 0/0 with a real total, which the
   * USAGE_SPLIT_HEADER distinguishes from a measured split.
   */
  private usageFor(execution: any): Usage {
    return {
      prompt_tokens: execution?.inputTokens || 0,
      completion_tokens: execution?.outputTokens || 0,
      total_tokens: execution?.totalTokens || 0,
    };
  }

  /**
   * Run the agent on whichever engine owns it and reduce the result to an
   * answer or a failure.
   *
   * An autonomous agent has no pipeline graph. Handed to the pipeline
   * engine it failed with "Agent pipeline is not configured", while
   * /v1/models listed it as callable -- so every autonomous agent, the kind
   * most agents are, was a model the endpoint advertised and then refused.
   */
  private async run(agent: Agent, input: Record<string, any>, apiKey: ApiKey, signal?: AbortSignal): Promise<CompatOutcome> {
    if (runsOnAutonomousRuntime(agent)) return this.runAutonomous(agent, input, apiKey, signal);

    const execution = await this.executionEngine.execute(
      agent,
      apiKey.organizationId,
      apiKey.userId || null,
      { input, signal, principal: compatPrincipal(apiKey) },
    );
    const split = usageSplitState(execution);

    // A run that did not complete is a failure, and `finish_reason: "error"`
    // was never a way to say so: "error" is not one of the OpenAI values
    // (stop, length, tool_calls, content_filter, function_call), so a consumer
    // switching on it falls through to its default and reads a truncated or
    // empty answer as a finished one. Report the failure as a failure.
    if (!execution || execution.status !== 'completed') {
      return {
        ok: false,
        status: 502,
        type: 'api_error',
        code: 'agent_execution_failed',
        message: (execution as any)?.error || 'The agent did not complete this request',
        split,
      };
    }
    return { ok: true, id: execution.id, content: outputText(execution.output), usage: this.usageFor(execution), split };
  }

  /**
   * An autonomous agent, run to its answer.
   *
   * The run is queued like any other and this waits on its row, which works
   * whichever replica's worker picks it up. A run that stops to wait on a
   * person (ask_user, an approval gate) is cancelled rather than left
   * waiting: a stateless completion has no turn on which anyone could answer
   * it, and the next request starts a fresh run with the whole conversation.
   */
  private async runAutonomous(
    agent: Agent,
    input: Record<string, any>,
    apiKey: ApiKey,
    signal?: AbortSignal,
  ): Promise<CompatOutcome> {
    const unavailable = USAGE_SPLIT_UNAVAILABLE;
    if (!this.runtime) {
      return {
        ok: false, status: 502, type: 'api_error', code: 'agent_execution_failed',
        message: 'The autonomous runtime is not available on this server', split: unavailable,
      };
    }

    const organizationId = apiKey.organizationId;
    const task = typeof input.message === 'string' ? input.message : JSON.stringify(input);
    let run: AgentRun = await this.runtime.startRun(agent.id, organizationId, apiKey.userId || null, task, {
      principal: compatPrincipal(apiKey),
      metadata: { source: 'openai_compat' },
    });
    const deadline = Date.now() + AUTONOMOUS_ANSWER_TIMEOUT_MS;

    const cancel = async () => {
      try {
        await this.runtime!.cancelRun(run.id, organizationId, agent.id, apiKey.userId || undefined);
      } catch (err: any) {
        // Finished in between: nothing left to stop.
        this.logger.debug?.(`Could not cancel run ${run.id}: ${err?.message}`);
      }
    };

    while (!RUN_FINISHED.includes(run.status)) {
      if (WAITING_ON_A_PERSON.includes(run.status)) {
        await cancel();
        return {
          ok: false, status: 409, type: 'invalid_request_error', code: 'agent_needs_input',
          message:
            `The agent stopped to wait for ${run.status === AgentRunStatus.WAITING_APPROVAL ? 'an approval' : 'input'}, ` +
            'which a chat completion cannot give it, so the run was cancelled. Put what it asked for in the next message, ' +
            'or use the agent runs API to answer a waiting run.',
          split: unavailable,
        };
      }
      if (signal?.aborted) {
        await cancel();
        return { ok: false, status: 499, type: 'api_error', code: 'client_closed_request', message: 'Client went away', split: unavailable };
      }
      if (Date.now() >= deadline) {
        await cancel();
        return {
          ok: false, status: 504, type: 'api_error', code: 'agent_timeout',
          message: `The agent did not finish within ${AUTONOMOUS_ANSWER_TIMEOUT_MS / 60_000} minutes, so the run was cancelled.`,
          split: unavailable,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, AUTONOMOUS_POLL_MS));
      run = await this.runtime.getRun(run.id, organizationId);
    }

    if (run.status !== AgentRunStatus.COMPLETED) {
      return {
        ok: false, status: 502, type: 'api_error', code: 'agent_execution_failed',
        message: run.error || `The agent run ended ${run.status}`, split: unavailable,
      };
    }
    return {
      ok: true,
      id: run.id,
      content: outputText(run.output),
      // A run records its total only; the split is not kept, and the header says so.
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: run.totalTokens || 0 },
      split: unavailable,
    };
  }

  async handleSync(
    agent: Agent,
    input: Record<string, any>,
    apiKey: ApiKey,
    res: Response,
  ) {
    const outcome = await this.run(agent, input, apiKey);
    res.setHeader(USAGE_SPLIT_HEADER, outcome.split);

    if (!outcome.ok) {
      return res.status(outcome.status).json({
        error: { message: outcome.message, type: outcome.type, code: outcome.code, param: null },
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
      usage: outcome.usage,
    });
  }

  /**
   * The same answer as handleSync, as `chat.completion.chunk` events.
   *
   * The content is the run's final output, sent when the run ends. It used
   * to be every node's output as it finished, which is not the answer: an
   * input -> llm_call -> output pipeline streamed the reply twice (once from
   * the llm_call, once from the output node that maps it), and a pipeline
   * with a drafting step streamed the draft ahead of the answer. An SDK
   * concatenates deltas, so the caller read all of it as one reply that the
   * non-streaming call would never have returned.
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
      const outcome = await this.run(agent, input, apiKey, abortController.signal);

      if (!clientAlive) {
        logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, 200, 'stream-client-closed');
        return;
      }

      // A run that came back without completing is a failure that reached the
      // client as a normally-terminated stream. Terminate it as an error.
      if (!outcome.ok) {
        this.endWithError(res, chunk, outcome.message, outcome.type, outcome.code);
        logRequest(logCtx.req, logCtx.apiKeyLast4, agent.id, logCtx.requestStartTime, outcome.status, 'stream-error');
        return;
      }

      if (outcome.content) {
        this.writeSSE(res, chunk([{ index: 0, delta: { content: outcome.content }, finish_reason: null }]));
      }
      this.writeSSE(res, chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]));

      // `stream_options: { include_usage: true }` asks for one further chunk
      // carrying usage, with an empty choices array, before [DONE]. Without it
      // a caller that asked gets no usage at all and no sign it was dropped.
      if (streamOptions.includeUsage) {
        this.writeSSE(res, chunk([], { usage: outcome.usage }));
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
   * The headers are long flushed by the time an engine failure surfaces, so the
   * status code cannot say anything any more -- the SSE body has to. The real
   * OpenAI API emits a frame carrying an `error` object, and both SDKs surface
   * that as a raised error. What this used to send instead was a chunk with
   * `finish_reason: "error"` followed by [DONE], which reads to an SDK as a
   * stream that ended normally holding a truncated answer: a silent failure.
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
