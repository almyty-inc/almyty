import { Injectable, Logger, Optional } from '@nestjs/common';

import { Agent } from '../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { AgentExecutionEngine } from './agent-execution.engine';
import { AgentRuntimeService } from './agent-runtime.service';
import { runsOnAutonomousRuntime } from './agent-invocation';
import { compatPrincipal } from './compat-auth.helper';
import { answerStreamFilter } from './answer-stream.filter';
import { withholdsCandidateAnswers } from './final-answer';
import { BudgetExceededException } from '../budgets/budget-exceeded.exception';

/**
 * One agent run for a /v1 compat request, whichever protocol asked for it.
 *
 * The OpenAI- and Anthropic-compatible routes used to run agents each their
 * own way, and drifted: /v1/chat/completions learned to run autonomous
 * agents on their runtime while /v1/messages kept handing them to the
 * pipeline engine, where every one failed with "Agent pipeline is not
 * configured" -- for an agent /v1/models had just listed. Both routes now
 * call this, and only render its outcome in their own wire shapes.
 *
 * With `onDelta` the answer is streamed as it is written:
 *   - a workflow agent whose answer is one llm_call's text (answer-node.ts)
 *     streams that call's tokens; any other shape sends its answer whole
 *     when the run ends.
 *   - an autonomous agent composes its answer with a separate no-tools call
 *     (final-answer.ts) and streams that call's tokens, filtered exactly as
 *     the hosted chat filters them (answer-stream.filter.ts).
 * Either way the finished output is the answer: anything the stream did not
 * carry is sent at the end, and a stream that sent something the finished
 * answer does not start with fails rather than ending on a wrong answer.
 */

/** How long a compat request waits on an autonomous run before cancelling it. */
export const AUTONOMOUS_ANSWER_TIMEOUT_MS = 10 * 60_000;
/** How often the run row is re-read while an autonomous run works. */
const AUTONOMOUS_POLL_MS = 500;

/**
 * Says whether the prompt/completion split in a response's usage is a real
 * measurement. A run records the split its providers reported, so the usual
 * answer is `measured`; it is `unavailable` for a run whose steps reported
 * none (an autonomous run, a pipeline with no llm_call). A streamed response
 * flushes its headers before the run starts and says `in-stream`: the split
 * arrives with the stream's closing usage.
 */
export const USAGE_SPLIT_HEADER = 'x-almyty-usage-split';
export const USAGE_SPLIT_UNAVAILABLE = 'unavailable';
export const USAGE_SPLIT_MEASURED = 'measured';
export const USAGE_SPLIT_IN_STREAM = 'in-stream';

/** Whether this run carries a real prompt/completion split. */
export function usageSplitState(execution: any): string {
  const input = execution?.inputTokens || 0;
  const output = execution?.outputTokens || 0;
  return input > 0 || output > 0 ? USAGE_SPLIT_MEASURED : USAGE_SPLIT_UNAVAILABLE;
}

/** The run states in which an autonomous run waits on a person. */
const WAITING_ON_A_PERSON: string[] = [AgentRunStatus.WAITING_INPUT, AgentRunStatus.WAITING_APPROVAL];
const RUN_FINISHED: string[] = [
  AgentRunStatus.COMPLETED,
  AgentRunStatus.FAILED,
  AgentRunStatus.CANCELLED,
  AgentRunStatus.TIMEOUT,
];

export interface CompatUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Why a run gave no answer. Each protocol maps these to its own status and
 * error type; the reason, and the message, are the same on both.
 */
export type CompatFailure =
  | 'execution_failed'
  | 'answer_superseded'
  | 'needs_input'
  | 'client_closed'
  | 'timeout'
  | 'budget';

/**
 * An answer (`ok`, with id/output/content/usage) or a failure. One flat shape
 * because this project compiles without strictNullChecks, which leaves a
 * discriminated union on `ok` un-narrowable.
 */
export interface CompatOutcome {
  ok: boolean;
  split: string;
  id?: string;
  /** The run's raw output, for a protocol that renders structure out of it. */
  output?: unknown;
  /** The answer text. With `onDelta`, all of it has been delivered there. */
  content?: string;
  usage?: CompatUsage;
  failure?: CompatFailure;
  message?: string;
}

export interface CompatInvocation {
  /** Which surface asked, recorded on the run. */
  protocol: 'openai_compat' | 'anthropic_messages';
  signal?: AbortSignal;
  /** Stream the answer here, piece by piece, as it is written. */
  onDelta?: (text: string) => void;
}

/** Tool calls a run's output carries, wherever the engine recorded them. */
export function toolCallsIn(output: any): any[] {
  if (Array.isArray(output?.toolCalls)) return output.toolCalls;
  if (Array.isArray(output?.tool_calls)) return output.tool_calls;
  return [];
}

/** A run's output as the assistant's text. */
export function answerText(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  const fields = output as Record<string, unknown>;
  // The autonomous runtime's final answer is `{ text }` on some paths; a
  // pipeline output node may map a `{ content }` or `{ message }` object.
  for (const key of ['text', 'content', 'message']) {
    if (typeof fields[key] === 'string') return fields[key] as string;
  }
  if (toolCallsIn(output).length > 0) return '';
  return JSON.stringify(output);
}

/**
 * What has been streamed of the answer, so the finished output can be
 * checked against it: a streamed token cannot be taken back.
 */
class StreamedAnswer {
  private sent = '';
  private diverged = false;
  private closed = false;

  constructor(private readonly write: (text: string) => void) {}

  token(content: string): void {
    if (this.closed || this.diverged || !content) return;
    this.sent += content;
    this.write(content);
  }

  /** What was sent is not the answer after all; send nothing more live. */
  reset(): void {
    if (this.sent) this.diverged = true;
  }

  /** Send what the stream did not carry. False when what it sent is not the answer's start. */
  finish(answer: string): boolean {
    this.closed = true;
    if (!answer.startsWith(this.sent)) return false;
    const rest = answer.slice(this.sent.length);
    if (rest) this.write(rest);
    return true;
  }

  close(): void {
    this.closed = true;
  }
}

const SUPERSEDED_MESSAGE =
  'The agent revised its answer after part of it had been streamed, so the streamed text is not its answer. Retry the request.';

@Injectable()
export class CompatAgentInvoker {
  private readonly logger = new Logger(CompatAgentInvoker.name);

  constructor(
    private readonly executionEngine: AgentExecutionEngine,
    // Needed only for an autonomous agent. @Optional() so harnesses that
    // build the compat routes with the pipeline engine alone keep working;
    // an autonomous agent asked for without it gets a plain failure.
    @Optional() private readonly runtime?: AgentRuntimeService,
  ) {}

  /**
   * Run the agent on whichever engine owns it and reduce the result to an
   * answer or a failure. A spend budget that refuses the run is a failure
   * here, not a throw: a streamed response has already sent its headers,
   * and the refusal still has to reach the caller as what it is.
   */
  async invoke(agent: Agent, input: Record<string, any>, apiKey: ApiKey, options: CompatInvocation): Promise<CompatOutcome> {
    try {
      return runsOnAutonomousRuntime(agent)
        ? await this.runAutonomous(agent, input, apiKey, options)
        : await this.runPipeline(agent, input, apiKey, options);
    } catch (err) {
      if (err instanceof BudgetExceededException) {
        return { ok: false, failure: 'budget', message: err.message, split: USAGE_SPLIT_UNAVAILABLE };
      }
      throw err;
    }
  }

  private async runPipeline(agent: Agent, input: Record<string, any>, apiKey: ApiKey, options: CompatInvocation): Promise<CompatOutcome> {
    const streamed = options.onDelta ? new StreamedAnswer(options.onDelta) : null;
    const execution = await this.executionEngine.execute(
      agent,
      apiKey.organizationId,
      apiKey.userId || null,
      {
        input,
        signal: options.signal,
        principal: compatPrincipal(apiKey),
        metadata: { triggerType: 'api', protocol: options.protocol },
        streamAnswer: !!streamed,
      },
      streamed
        ? (event) => {
            if (event.type === 'answer.chunk') streamed.token((event as any).data?.content);
          }
        : undefined,
    );
    const split = usageSplitState(execution);

    // A run that did not complete is a failure, reported as one: a normal
    // answer carrying whatever the run had got to reads, to a client, as a
    // finished reply.
    if (!execution || execution.status !== 'completed') {
      streamed?.close();
      return {
        ok: false,
        failure: 'execution_failed',
        message: (execution as any)?.error || 'The agent did not complete this request',
        split,
      };
    }

    const content = answerText(execution.output);
    if (streamed && !streamed.finish(content)) {
      return { ok: false, failure: 'answer_superseded', message: SUPERSEDED_MESSAGE, split };
    }
    return {
      ok: true,
      id: execution.id,
      output: execution.output,
      content,
      // What the run recorded: the node executor keeps each provider's
      // input/output split and the engine sums it.
      usage: {
        inputTokens: execution.inputTokens || 0,
        outputTokens: execution.outputTokens || 0,
        totalTokens: execution.totalTokens || 0,
      },
      split,
    };
  }

  /**
   * An autonomous agent, run to its answer.
   *
   * The run is queued like any other and this waits on its row, which works
   * whichever replica's worker picks it up; a streamed answer comes off the
   * run's event stream, which is cross-pod too. A run that stops to wait on
   * a person (ask_user, an approval gate) is cancelled rather than left
   * waiting: a stateless request has no turn on which anyone could answer
   * it, and the next request starts a fresh run with the whole conversation.
   */
  private async runAutonomous(agent: Agent, input: Record<string, any>, apiKey: ApiKey, options: CompatInvocation): Promise<CompatOutcome> {
    const split = USAGE_SPLIT_UNAVAILABLE;
    if (!this.runtime) {
      return { ok: false, failure: 'execution_failed', message: 'The autonomous runtime is not available on this server', split };
    }
    const runtime = this.runtime;
    const streamed = options.onDelta ? new StreamedAnswer(options.onDelta) : null;

    const organizationId = apiKey.organizationId;
    const task = typeof input.message === 'string' ? input.message : JSON.stringify(input);
    let run: AgentRun = await runtime.startRun(agent.id, organizationId, apiKey.userId || null, task, {
      principal: compatPrincipal(apiKey),
      // A streamed request has its answer written by a no-tools call, so it
      // streams word by word; that costs one more call, which a request
      // that waits for the whole answer anyway does not pay.
      metadata: { source: options.protocol, ...(streamed ? { composeFinalAnswer: true } : {}) },
    });
    const deadline = Date.now() + AUTONOMOUS_ANSWER_TIMEOUT_MS;

    const stopListening = new AbortController();
    if (streamed) {
      const filter = answerStreamFilter(
        { token: (content) => streamed.token(content), reset: () => streamed.reset(), done: () => undefined },
        { withholdCandidates: withholdsCandidateAnswers(agent) },
      );
      runtime.subscribeRunEvents(run.id, filter, stopListening.signal, AUTONOMOUS_ANSWER_TIMEOUT_MS).catch((err: any) => {
        // The answer still arrives whole from the run row at the end.
        this.logger.warn(`Could not follow run ${run.id} events: ${err?.message}`);
      });
    }

    const cancel = async () => {
      try {
        await runtime.cancelRun(run.id, organizationId, agent.id, apiKey.userId || undefined);
      } catch (err: any) {
        // Finished in between: nothing left to stop.
        this.logger.debug?.(`Could not cancel run ${run.id}: ${err?.message}`);
      }
    };

    try {
      while (!RUN_FINISHED.includes(run.status)) {
        if (WAITING_ON_A_PERSON.includes(run.status)) {
          await cancel();
          return {
            ok: false,
            failure: 'needs_input',
            message:
              `The agent stopped to wait for ${run.status === AgentRunStatus.WAITING_APPROVAL ? 'an approval' : 'input'}, ` +
              'which a stateless request cannot give it, so the run was cancelled. Put what it asked for in the next message, ' +
              'or use the agent runs API to answer a waiting run.',
            split,
          };
        }
        if (options.signal?.aborted) {
          await cancel();
          return { ok: false, failure: 'client_closed', message: 'Client went away', split };
        }
        if (Date.now() >= deadline) {
          await cancel();
          return {
            ok: false,
            failure: 'timeout',
            message: `The agent did not finish within ${AUTONOMOUS_ANSWER_TIMEOUT_MS / 60_000} minutes, so the run was cancelled.`,
            split,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, AUTONOMOUS_POLL_MS));
        run = await runtime.getRun(run.id, organizationId);
      }
    } finally {
      stopListening.abort();
    }

    if (run.status !== AgentRunStatus.COMPLETED) {
      streamed?.close();
      return { ok: false, failure: 'execution_failed', message: run.error || `The agent run ended ${run.status}`, split };
    }
    const content = answerText(run.output);
    if (streamed && !streamed.finish(content)) {
      return { ok: false, failure: 'answer_superseded', message: SUPERSEDED_MESSAGE, split };
    }
    return {
      ok: true,
      id: run.id,
      output: run.output,
      content,
      // A run records its total only; the split is not kept, and the header says so.
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: run.totalTokens || 0 },
      split,
    };
  }
}
