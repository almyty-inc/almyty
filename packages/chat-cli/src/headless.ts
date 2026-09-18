/**
 * chat without a terminal.
 *
 * A CLI that only draws to a tty cannot be piped, scripted or put in
 * CI, which is half of what a CLI is for. This path answers one
 * question — from --message, or from stdin — writes the answer to
 * stdout, writes attribution to stderr so stdout stays clean for a
 * pipe, and exits 0 or 1 on whether the run actually completed.
 *
 * `--json` prints one object per answer instead, with the text, the
 * cost and the ids needed to resume.
 */

import type { AgentInfo, RunLimits } from '@almyty/client';

import { explainError, type ErrorContext } from './errors.js';
import { exitCodeForError, exitCodeForStatus } from './exit-codes.js';
import { formatUsage } from './stream.js';
import { runTurn, type TurnResult, type TurnTarget } from './turn.js';

export interface HeadlessIO {
  out(text: string): void;
  err(text: string): void;
}

export interface HeadlessOptions {
  message: string;
  agent: AgentInfo;
  target: TurnTarget;
  json: boolean;
  /** False buffers the answer and prints it once. */
  stream: boolean;
  conversationId?: string;
  limits?: RunLimits;
  signal?: AbortSignal;
  io: HeadlessIO;
  errorContext?: ErrorContext;
}

/** Everything --json promises, in one object. */
export function jsonResult(result: TurnResult, agent: AgentInfo): Record<string, unknown> {
  return {
    status: result.status,
    output: result.text,
    agent: { id: agent.id, name: agent.name, slug: agent.slug, mode: agent.mode },
    model: result.usage.model ?? null,
    routing: result.usage.model
      ? { model: result.usage.model, rationale: result.usage.rationale ?? null, attempt: result.usage.attempt ?? null }
      : null,
    usage: { cost: result.usage.cost, tokens: result.usage.tokens, steps: result.usage.steps },
    runId: result.runId ?? null,
    conversationId: result.conversationId ?? null,
    ...(result.error ? { error: result.error } : {}),
  };
}

/** Read all of stdin, for `echo "..." | almyty chat <agent> --stdin`. */
export async function readStdin(stream: AsyncIterable<string | Buffer>): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of stream) parts.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
  return parts.join('').trim();
}

/**
 * Answer once and return the process exit code.
 *
 * Streaming to a pipe writes the tokens as they arrive, which is what
 * makes `almyty chat bot -m "..." | less` feel alive; --json buffers,
 * because half a JSON object is not JSON.
 */
export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const { io, json, agent } = options;
  let written = 0;

  try {
    const result = await runTurn(options.target, options.message, {
      mode: agent.mode,
      conversationId: options.conversationId,
      limits: options.limits,
      signal: options.signal,
      hooks:
        json || !options.stream
          ? undefined
          : {
              partial: (text) => {
                // Only the new tail: the reducer hands back the whole
                // buffer each time.
                if (text.length > written) {
                  io.out(text.slice(written));
                  written = text.length;
                }
              },
            },
    });

    if (json) {
      io.out(JSON.stringify(jsonResult(result, agent), null, 2) + '\n');
      return exitCodeForStatus(result.status);
    }

    if (options.stream) {
      // Anything the stream did not already print (a non-streaming
      // provider, or a final output that replaced the buffer).
      if (result.text.length > written) io.out(result.text.slice(written));
      if (result.text) io.out('\n');
    } else if (result.text) {
      io.out(result.text + '\n');
    }

    const attribution = formatUsage(result.usage);
    if (attribution) io.err(attribution + '\n');
    if (result.status === 'failed') io.err(`Run failed: ${result.error ?? 'no reason given'}\n`);
    if (result.status === 'cancelled') io.err('Cancelled.\n');
    if (result.status === 'waiting_input' && result.conversationId) {
      io.err(`The agent asked a question. Continue with: almyty chat ${agent.slug ?? agent.name} --resume ${result.conversationId}\n`);
    }
    return exitCodeForStatus(result.status);
  } catch (err) {
    const message = explainError(err, options.errorContext);
    if (json) {
      io.out(JSON.stringify({ status: 'error', error: message }, null, 2) + '\n');
    } else {
      io.err(message + '\n');
    }
    return exitCodeForError(err);
  }
}
