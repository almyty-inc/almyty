import { LlmProvider } from '../../../entities/llm-provider.entity';
import {
  callLlmProviderHttp,
  llmCallOptionsFor,
} from '../../llm-providers/providers/safe-request';
import { OptionLogprobs } from './option-scoring';
import { ResolvedScoringRoute } from './scoring-route';

/**
 * The outbound half of the logits path: ask a serving engine how likely a
 * continuation it did not choose would have been.
 *
 * Every option is scored against the SAME prefix, which is the prompt with
 * the assistant turn prefilled up to the answer slot. Only the tokens the
 * option itself contributes are returned, because the prefix contributes
 * the same amount to every option and including it would add a constant to
 * each sum, which survives the softmax as nothing at all but makes the
 * numbers unreadable in a trace.
 *
 * This goes through `callLlmProviderHttp` like every other outbound call,
 * so the L1 egress gate and the DNS-pinning agents apply. A scoring
 * endpoint is more likely than most to be a box on the customer's own
 * network, which makes the gate more load-bearing here, not less.
 *
 * See docs/design/layers.md, L1 and L3.
 */

export class ScoringCallError extends Error {
  constructor(message: string, readonly providerType: string) {
    super(message);
    this.name = 'ScoringCallError';
  }
}

export interface ScoringRequest {
  /** The prompt with the assistant turn prefilled up to the answer slot. */
  prefix: string;
  /** The option strings to score, in the order they were declared. */
  options: Array<{ optionId: string; text: string }>;
  temperature?: number;
  seed?: number;
}

export interface ScoringCallResult {
  scored: OptionLogprobs[];
  /** Prompt tokens billed, summed over the calls this took. */
  inputTokens: number;
}

/**
 * Read one option's own token logprobs out of an echo-style completions
 * response.
 *
 * The response carries a logprob for every token of the prompt, and the
 * prompt here was prefix plus option, so the option's tokens are the tail.
 * They are located by token count rather than by string matching: the
 * engine's tokenizer decides where the boundary falls, and re-deriving it
 * from the text would mean re-implementing that tokenizer and being wrong
 * whenever the option's first character merges with the prefix's last.
 */
function tailLogprobs(
  tokenLogprobs: Array<number | null>,
  prefixTokenCount: number,
  optionId: string,
  providerType: string,
): number[] {
  const tail = tokenLogprobs.slice(prefixTokenCount);
  if (tail.length === 0) {
    throw new ScoringCallError(
      `Provider ${providerType} returned no continuation tokens for option "${optionId}"`,
      providerType,
    );
  }
  return tail.map(lp => {
    if (lp === null || !Number.isFinite(lp)) {
      // The first prompt token legitimately has a null logprob (nothing
      // precedes it), but that token is always in the prefix. A null in
      // the tail means the engine did not score what was asked for.
      throw new ScoringCallError(
        `Provider ${providerType} returned an unscored token for option "${optionId}"`,
        providerType,
      );
    }
    return lp;
  });
}

/**
 * `openai_completions_echo`: one call per option against the legacy
 * completions route with `echo` on.
 *
 * One call per option rather than one call with an array of prompts,
 * because the batched form returns choices whose association with the
 * inputs is by index, and an engine that reorders or drops one silently
 * mislabels every option after it. Per-option calls cost more round trips
 * and cannot be silently misaligned.
 */
async function scoreByEcho(
  provider: LlmProvider,
  route: ResolvedScoringRoute,
  request: ScoringRequest,
  headers: Record<string, string>,
): Promise<ScoringCallResult> {
  const providerType = String(provider.type);
  const scored: OptionLogprobs[] = [];
  let inputTokens = 0;

  for (const option of request.options) {
    const response = await callLlmProviderHttp(
      {
        method: 'POST',
        url: route.url,
        headers,
        data: {
          model: route.vendorModelId,
          prompt: `${request.prefix}${option.text}`,
          // Nothing is to be generated. The whole measurement is of the
          // prompt, so asking for output would only add latency and cost.
          max_tokens: 0,
          echo: true,
          logprobs: 0,
          temperature: request.temperature ?? 0,
          ...(request.seed !== undefined ? { seed: request.seed } : {}),
        },
      },
      llmCallOptionsFor(provider),
    );

    const choice = response.data?.choices?.[0];
    const tokenLogprobs: Array<number | null> | undefined = choice?.logprobs?.token_logprobs;
    if (!Array.isArray(tokenLogprobs)) {
      throw new ScoringCallError(
        `Provider ${providerType} answered the scoring call without token logprobs. ` +
          `Its completions route accepted the request but did not echo logprobs, so it ` +
          `cannot serve the logits path.`,
        providerType,
      );
    }

    const prefixTokenCount = countPrefixTokens(response.data, request, option.text);
    scored.push({
      optionId: option.optionId,
      tokenLogprobs: tailLogprobs(tokenLogprobs, prefixTokenCount, option.optionId, providerType),
    });
    inputTokens += response.data?.usage?.prompt_tokens ?? 0;
  }

  return { scored, inputTokens };
}

/**
 * How many of the echoed tokens belong to the prefix.
 *
 * The engine reports the offset of every token it echoed, so the boundary
 * is the count of offsets that start before the option's first character.
 * That is the tokenizer's own answer to the question, which is the only
 * answer that cannot disagree with it.
 */
function countPrefixTokens(
  data: any,
  request: ScoringRequest,
  optionText: string,
): number {
  const offsets: number[] | undefined = data?.choices?.[0]?.logprobs?.text_offset;
  const boundary = `${request.prefix}${optionText}`.length - optionText.length;
  if (Array.isArray(offsets)) {
    return offsets.filter(offset => offset < boundary).length;
  }
  // No offsets means the engine echoed logprobs without saying where the
  // tokens sit. Refusing beats guessing a boundary: a boundary off by one
  // silently charges the option for a prefix token, or drops its first.
  throw new ScoringCallError(
    'Scoring response carried logprobs without text offsets, so the option boundary is unknown',
    'unknown',
  );
}

/**
 * `tgi_decoder_input_details`: one call per option against a generate
 * route that returns prefill logprobs.
 *
 * The same measurement reached from the other direction: the engine
 * reports what it would have assigned to each token of the input, and the
 * input is prefix plus option.
 */
async function scoreByPrefill(
  provider: LlmProvider,
  route: ResolvedScoringRoute,
  request: ScoringRequest,
  headers: Record<string, string>,
): Promise<ScoringCallResult> {
  const providerType = String(provider.type);
  const scored: OptionLogprobs[] = [];
  let inputTokens = 0;

  for (const option of request.options) {
    const response = await callLlmProviderHttp(
      {
        method: 'POST',
        url: route.url,
        headers,
        data: {
          inputs: `${request.prefix}${option.text}`,
          parameters: {
            max_new_tokens: 1,
            decoder_input_details: true,
            details: true,
            temperature: request.temperature ?? 0,
            ...(request.seed !== undefined ? { seed: request.seed } : {}),
          },
        },
      },
      llmCallOptionsFor(provider),
    );

    const body = Array.isArray(response.data) ? response.data[0] : response.data;
    const prefill: Array<{ logprob: number | null }> | undefined = body?.details?.prefill;
    if (!Array.isArray(prefill)) {
      throw new ScoringCallError(
        `Provider ${providerType} answered the scoring call without prefill details, ` +
          `so it cannot serve the logits path.`,
        providerType,
      );
    }

    // The prefill covers prefix and option together. The option's share is
    // the tail, and its length is the difference between scoring the whole
    // string and scoring the prefix alone, which the caller already knows
    // because it asked for the prefix to be tokenized once.
    const prefixTokenCount = prefill.length - countOptionTokens(body, option.text);
    scored.push({
      optionId: option.optionId,
      tokenLogprobs: tailLogprobs(
        prefill.map(t => t.logprob),
        prefixTokenCount,
        option.optionId,
        providerType,
      ),
    });
    inputTokens += prefill.length;
  }

  return { scored, inputTokens };
}

function countOptionTokens(body: any, optionText: string): number {
  const prefill: Array<{ id: number; text?: string }> | undefined = body?.details?.prefill;
  if (!Array.isArray(prefill)) return 0;
  // Walk back from the end accumulating token text until the option is
  // covered. The engine's own token texts are used, so the count agrees
  // with its tokenizer rather than with an assumption about it.
  let covered = '';
  let count = 0;
  for (let i = prefill.length - 1; i >= 0 && covered.length < optionText.length; i--) {
    covered = `${prefill[i].text ?? ''}${covered}`;
    count++;
  }
  return count;
}

/**
 * Score every option of one question against one prefix.
 *
 * The protocol is chosen from the resolved route, which came from registry
 * data. There is no provider switch here and there is not meant to be one:
 * a serving engine that speaks one of these two shapes becomes usable by
 * declaring it on a card, with no change to this file.
 */
export async function scoreContinuations(
  provider: LlmProvider,
  route: ResolvedScoringRoute,
  request: ScoringRequest,
): Promise<ScoringCallResult> {
  const headers = {
    'Content-Type': 'application/json',
    ...(provider.getAuthHeaders?.() ?? {}),
  } as Record<string, string>;

  switch (route.protocol) {
    case 'openai_completions_echo':
      return scoreByEcho(provider, route, request, headers);
    case 'tgi_decoder_input_details':
      return scoreByPrefill(provider, route, request, headers);
    default: {
      // Exhaustive: a new ScoringProtocol value that reaches here without
      // an implementation is a compile error, not a runtime surprise.
      const unreachable: never = route.protocol;
      throw new ScoringCallError(
        `Unsupported scoring protocol: ${String(unreachable)}`,
        String(provider.type),
      );
    }
  }
}
