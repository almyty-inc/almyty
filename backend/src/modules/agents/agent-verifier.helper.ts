import { Injectable } from '@nestjs/common';

import { LlmProvidersService } from '../llm-providers/llm-providers.service';
import type { ChatResponse } from '../llm-providers/llm-providers.service';
import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';
import type { RoutingPolicy } from '../model-catalog/routing/model-router';
import { SHORTENED_MARK } from './checker-evidence';
import { falseVersionOrder } from './version-order';
import { confirmsClaim, listedAsConfirmed, presentInEvidence } from './checker-guards';

/** Verdict-merge policy for a verify node's checker panel. */
export type VerifyPolicy = 'all_pass' | 'majority' | 'any_fail_blocks';

export interface VerifyFailure {
  rule: string;
  evidence: string;
  checker: string;
  /** The claim in the answer the failure is about, when the checker named it. */
  claim?: string;
  /** A machine code for a failure the platform raised itself (verification_unavailable). `rule` is the words a person reads. */
  code?: string;
}

/**
 * A single refute-only checker. Vendor is chosen per-checker via providerId,
 * or by the catalog from a routing policy.
 */
export interface CheckerConfig {
  name?: string;
  providerId?: string;
  model?: string;
  routing?: RoutingPolicy;
  instructions?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface CheckerResult {
  checker: string;
  verdict: 'pass' | 'fail' | 'error';
  failures: VerifyFailure[];
  passedRules: string[];
  /** Why the checker gave no verdict, in words a person can act on. */
  error?: string;
  /** What else happened reading the verdict: a cut-off reply read in part, items not counted. */
  note?: string;
  cost?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** The model that gave the verdict, and the router's attribution when it was routed. */
  model?: string;
  providerId?: string;
  routing?: ChatResponse['routing'];
}

export interface VerifyPanelResult {
  verdict: 'pass' | 'fail';
  passed: boolean;
  /** No checker gave a verdict: the answer was not checked, nothing was found wrong with it. */
  unavailable?: boolean;
  policy: VerifyPolicy;
  failures: VerifyFailure[];
  passedRules: string[];
  checkers: Array<{
    checker: string;
    verdict: 'pass' | 'fail' | 'error';
    error?: string;
    note?: string;
    model?: string;
    providerId?: string;
    routing?: ChatResponse['routing'];
  }>;
  cost: number;
  tokens: number;
  /** What the checkers read (the evidence is most of it) and wrote, summed. */
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * `text.replace(/\s*```$/i, '')`: a closing code fence and the space
 * before it. The regex retried from every character of a run of spaces
 * that did not end in a fence, which on a checker reply (an LLM chose
 * it) of 100 KB of spaces took seven seconds.
 */
export function stripClosingFence(text: string): string {
  if (!text.endsWith('```')) return text;
  let end = text.length - 3;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  return text.slice(0, end);
}

/**
 * Output budget of a checker call when its config sets none. Not the
 * provider's default: Anthropic's is 1,024 tokens, which cut a dozen-item
 * verdict off mid-JSON (run b9803830).
 */
export const CHECKER_MAX_TOKENS = 4_096;

/** What a person reads when no checker could give a verdict. Code: verification_unavailable. */
export const UNAVAILABLE_RULE = 'the checker could not give a verdict';

/** Item statuses that mean "this claim is wrong". Any other status is not a failure. */
const FAILED_STATUSES = new Set(['fail', 'failed', 'failure', 'wrong', 'incorrect', 'violation', 'contradicted', 'unsupported', 'error']);

/**
 * The checker's reply, as a JSON schema for providers that take one
 * (structured output, structured-output.ts): real failures in "failures",
 * what the evidence confirms in "confirmed". Checkers asked for one list
 * put confirmations in it ("which is correct", "no failure here"), and
 * each failed a correct answer.
 */
export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'failures', 'confirmed'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'rule', 'evidence'],
        properties: {
          claim: { type: 'string' },
          rule: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    confirmed: { type: 'array', items: { type: 'string' } },
  },
} as const;

const VERDICT_FORMAT = { name: 'checker_verdict', schema: VERDICT_SCHEMA as unknown as Record<string, any> };

/** Whether a provider error says it would not take the reply schema: then ask again without it. */
function refusedFormat(err: any): boolean {
  const status = err?.response?.status ?? err?.status;
  const text = String(err?.response?.data?.error?.message ?? err?.message ?? '');
  return status === 400 || /response_format|json_schema|responseSchema|structured output/i.test(text);
}

type ParsedVerdict = { verdict?: string; failures?: any[]; passed_rules?: any[]; confirmed?: any[] };

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asVerdict(value: unknown): ParsedVerdict | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ParsedVerdict) : null;
}

/** Whether a provider's finish reason says the reply hit its output limit. */
function isCutOff(finishReason: unknown): boolean {
  return typeof finishReason === 'string' && ['length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS'].includes(finishReason);
}

function oneLine(text: string, max: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A verdict object cut off mid-way (the reply hit its output limit), read
 * up to the last value that closed inside it, with the open brackets
 * closed. `{"verdict":"fail","failures":[{"rule":"a"},{"rule":"b","evid`
 * reads as a fail with failure "a". Only a reply that states its verdict
 * is read this way; a pass is accepted only when its "failures" list
 * closed, so a cut-off list of failures is never read as a clean pass.
 * One pass over the text; no regex.
 */
export function salvageTruncatedJson(text: string): ParsedVerdict | null {
  if (!text.startsWith('{')) return null;
  const stack: string[] = [];
  const cuts: Array<{ at: number; closers: string }> = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return null;
      if (stack.length === 0) break;
      cuts.push({ at: i + 1, closers: [...stack].reverse().join('') });
    }
  }
  for (let k = cuts.length - 1; k >= 0 && k >= cuts.length - 8; k--) {
    const parsed = asVerdict(tryJson(text.slice(0, cuts[k].at) + cuts[k].closers));
    if (!parsed || (parsed.verdict !== 'pass' && parsed.verdict !== 'fail')) continue;
    if (parsed.verdict === 'pass' && !failuresClosed(text, cuts[k].at)) continue;
    return parsed;
  }
  return null;
}

/** Whether the "failures" list closed before `at` (it is read up to there). */
function failuresClosed(text: string, at: number): boolean {
  const key = text.indexOf('"failures"');
  if (key === -1 || key > at) return false;
  const open = text.indexOf('[', key);
  if (open === -1 || open > at) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < at; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

export { runEvidence, evidenceBudget, SHORTENED_MARK } from './checker-evidence';

/**
 * Each checker's verdict, for the verify step it is recorded on: why one
 * gave none ("the checker's reply was cut off at its output limit ...")
 * and what else happened reading it. The run view shows these.
 */
export function checkerVerdicts(
  panel: Pick<VerifyPanelResult, 'checkers'>,
): Array<{ checker: string; verdict: 'pass' | 'fail' | 'error'; error?: string; note?: string }> {
  return (panel.checkers ?? []).map((c) => ({
    checker: c.checker,
    verdict: c.verdict,
    ...(c.error ? { error: c.error } : {}),
    ...(c.note ? { note: c.note } : {}),
  }));
}

/**
 * Shared verifier: a refute-only checker panel that judges an OUTPUT against a
 * SPEC. Each checker runs in its own bounded context with its own provider/model
 * (multi-vendor = checkers pointed at different-vendor provider entities), in
 * parallel, and the verdicts are merged under a policy.
 *
 * Extracted from the pipeline `verify` node so both the DAG node executor and
 * the autonomous step processor share one implementation of the checker logic,
 * the tolerant JSON parse, and the verdict merge.
 */
@Injectable()
export class AgentVerifierHelper {
  constructor(private readonly llmProvidersService: LlmProvidersService) {}

  /**
   * Run the full checker panel against already-resolved target/spec text and
   * merge the verdicts. Never throws on a checker error — a failed or
   * unparseable checker becomes verdict 'error' and the policy layer decides
   * whether that blocks. Returns the merged verdict plus aggregate cost/tokens.
   */
  async runPanel(
    opts: {
      target: any;
      spec?: string;
      checkers: CheckerConfig[];
      policy?: VerifyPolicy;
      /** What the answer must agree with: the request and the tool results (see runEvidence). */
      evidence?: string;
    },
    organizationId: string,
    /** Who the checker calls act as: the run's principal (see LlmChatHelper.chat). */
    userId?: string | ExecutionPrincipal,
    signal?: AbortSignal,
  ): Promise<VerifyPanelResult> {
    const policy: VerifyPolicy = opts.policy || 'any_fail_blocks';
    const targetText =
      typeof opts.target === 'string'
        ? opts.target
        : JSON.stringify(opts.target, null, 2);
    const spec = opts.spec || '';
    const checkers = Array.isArray(opts.checkers) ? opts.checkers : [];
    const evidence = opts.evidence?.trim() || '';

    const checkerResults = await Promise.all(
      checkers.map((checker, i) =>
        this.runChecker(checker, i, targetText, spec, organizationId, userId, signal, evidence),
      ),
    );

    const merged = this.mergeVerdicts(checkerResults, policy);

    return {
      verdict: merged.verdict,
      passed: merged.verdict === 'pass',
      ...(merged.unavailable ? { unavailable: true } : {}),
      policy,
      failures: merged.failures,
      passedRules: merged.passedRules,
      checkers: checkerResults.map((r) => ({
        checker: r.checker,
        verdict: r.verdict,
        ...(r.error ? { error: r.error } : {}),
        ...(r.note ? { note: r.note } : {}),
        ...(r.model ? { model: r.model } : {}),
        ...(r.providerId ? { providerId: r.providerId } : {}),
        ...(r.routing ? { routing: r.routing } : {}),
      })),
      cost: checkerResults.reduce((s, r) => s + (r.cost || 0), 0),
      tokens: checkerResults.reduce((s, r) => s + (r.tokens || 0), 0),
      inputTokens: checkerResults.reduce((s, r) => s + (r.inputTokens || 0), 0),
      outputTokens: checkerResults.reduce((s, r) => s + (r.outputTokens || 0), 0),
    };
  }

  /**
   * Render a checker panel's failures into a critique message the agent can
   * act on. Used by the autonomous revise loop as synthetic user feedback.
   * The reviser changes only what a failure names: revisions that rewrote
   * the whole answer deleted correct, tool-backed items the checker had
   * merely not seen.
   */
  formatFailuresForRevision(
    failures: VerifyFailure[],
    attempt: number,
    maxAttempts: number,
  ): string {
    const lines = failures.length
      ? failures
          .map(
            (f, i) =>
              `${i + 1}. ${f.claim ? `"${f.claim}": ` : ''}${f.rule}${f.evidence ? ` — evidence: ${f.evidence}` : ''}` +
              (f.checker ? ` (${f.checker})` : ''),
          )
          .join('\n')
      : 'The checker could not confirm the answer is correct, and named nothing wrong with it.';
    return (
      `A checker reviewed your answer and named these problems ` +
      `(revision ${attempt} of ${maxAttempts}):\n\n${lines}\n\n` +
      `Fix each problem above and produce a corrected final answer. ` +
      `Change only what a problem above names. Keep every other fact, item, number and date that your tool results support exactly as it is: ` +
      `do not drop or change an item the checker did not name. ` +
      `If your tool results show that a named problem is not a problem, keep the claim and say which tool result supports it.`
    );
  }

  /**
   * Run a single refute-only checker. Returns a structured verdict; never
   * throws — an LLM error or unparseable reply becomes verdict 'error' so the
   * policy layer decides whether that blocks.
   */
  private async runChecker(
    checker: CheckerConfig,
    index: number,
    targetText: string,
    spec: string,
    organizationId: string,
    userId: string | ExecutionPrincipal | undefined,
    signal?: AbortSignal,
    evidence = '',
  ): Promise<CheckerResult> {
    const name = checker?.name || `checker_${index + 1}`;
    if (!checker?.providerId && !checker?.routing) {
      return {
        checker: name,
        verdict: 'error',
        failures: [],
        passedRules: [],
        error: 'the checker has no model set',
      };
    }

    const maxTokens = checker.maxTokens && checker.maxTokens > 0 ? checker.maxTokens : CHECKER_MAX_TOKENS;
    const systemPrompt =
      `You are a verifier. Your ONLY job is to find what is WRONG with the OUTPUT ` +
      `relative to the SPEC. Do not praise, summarize, or restate. Hunt for ` +
      `violations, missing requirements, unsupported claims, and contradictions.` +
      (evidence
        ? `\n\nThe EVIDENCE is what the agent was asked and what its tools returned in this run. ` +
          `Judge every factual claim against it. You refute; you do not need to confirm. Fail a claim only when:\n` +
          `- the EVIDENCE contradicts it, or\n` +
          `- the EVIDENCE that would hold it is complete and does not hold it.\n` +
          `A tool result marked "${SHORTENED_MARK} ...]" or "[result left out ...]" is incomplete: items, fields and text were left out of what you see. ` +
          `Never fail a claim only because it is absent from shortened evidence; absence counts only where the evidence is complete. ` +
          `Never use your own knowledge of versions, dates, prices or other facts to overrule the EVIDENCE; it is newer than you. ` +
          `Compare version numbers part by part as integers: 4.18.1 is newer than 4.17.21, because 18 > 17.`
        : '') +
      (checker.instructions ? `\n\nFocus: ${checker.instructions}` : '') +
      `\n\nReply with ONLY a JSON object, no prose, no code fences:\n` +
      `{"verdict":"pass"|"fail","failures":[{"claim":"<the wrong claim, quoted from the OUTPUT>","rule":"<what is wrong, briefly>","evidence":"<${evidence ? 'the EVIDENCE that contradicts it' : 'quote or location'}>"}],"confirmed":["<a claim you checked and found right>"]}\n` +
      `"failures" holds only claims that are wrong. A claim you checked and found right or acceptable goes in "confirmed", never in "failures": ` +
      `an entry in "failures" that says the claim is correct is a mistake. ` +
      `Keep each entry short. "verdict" is "fail" when "failures" lists anything, else "pass".`;

    const userPrompt =
      `SPEC (rules to enforce):\n${spec || '(no explicit spec — judge for correctness, completeness, and internal consistency)'}\n\n` +
      (evidence ? `EVIDENCE (ground truth for this run):\n${evidence}\n\n` : '') +
      `OUTPUT (to check):\n${targetText}`;

    try {
      const request = {
        messages: [
          { role: 'system' as any, content: systemPrompt },
          { role: 'user' as any, content: userPrompt },
        ],
        // A routed checker lets the catalog pick its model per call.
        model: checker.routing ? undefined : checker.model,
        ...(checker.routing ? { routing: checker.routing } : {}),
        temperature: checker.temperature ?? 0,
        // Never the provider's default: Anthropic's is 1,024 tokens, and a
        // verdict listing a dozen items was cut off mid-JSON, read as no
        // verdict, and the answer was sent back for paid revisions.
        maxTokens,
        signal,
      };
      // The verdict in its schema where the provider takes one
      // (structured-output.ts). A model that refuses the schema is asked
      // again without it; the prompt says the same format. Without the
      // date a checker took its training cutoff for today and failed real
      // papers dated last week as "from the future".
      let response: ChatResponse;
      try {
        response = await this.llmProvidersService.chat(checker.providerId ?? null, { ...request, responseFormat: VERDICT_FORMAT, currentTime: true }, organizationId, userId);
      } catch (err) {
        if (signal?.aborted || !refusedFormat(err)) throw err;
        response = await this.llmProvidersService.chat(checker.providerId ?? null, { ...request, currentTime: true }, organizationId, userId);
      }

      const raw = response?.message?.content || '';
      const parsed = this.parseCheckerJson(raw);
      const cost = response?.cost || 0;
      const tokens = response?.usage?.totalTokens || 0;
      // What the checker read (the evidence is most of it) and wrote: the run view shows both on the verify step.
      const usage = { inputTokens: response?.usage?.inputTokens || 0, outputTokens: response?.usage?.outputTokens || 0 };
      // Which model gave this verdict: what the provider said it ran, the
      // router's pick for a routed checker, else the checker's own model.
      // A check is a step like any other, and says who answered it.
      const answeredModel = response?.model || response?.routing?.vendorModelId || checker.model;
      const answeredProvider = response?.routing?.providerId ?? checker.providerId;
      const answered = {
        ...(answeredModel ? { model: answeredModel } : {}),
        ...(answeredProvider ? { providerId: answeredProvider } : {}),
        ...(response?.routing ? { routing: response.routing } : {}),
      };

      if (!parsed) {
        // Said on the step, in words a person can act on: the run view
        // shows it next to the check that could not give a verdict.
        const cutOff = isCutOff(response?.message?.finishReason);
        return {
          checker: name,
          verdict: 'error',
          failures: [],
          passedRules: [],
          error:
            (cutOff
              ? `the checker's reply was cut off at its output limit (${maxTokens} tokens) before it gave a verdict`
              : raw.trim()
                ? `the checker's reply could not be read as a verdict`
                : 'the checker gave an empty reply') + (raw.trim() ? `: "${oneLine(raw, 200)}"` : ''),
          cost,
          tokens,
          ...usage,
          ...answered,
        };
      }

      const read = this.readFailures(parsed, name, evidence);
      // A 'fail' that names no failure still blocks: synthesize one so the
      // failure list is never silently empty on a fail. A fail whose every
      // listed item turned out not to be a failure (marked correct, or
      // resting on a false version order) is a pass: nothing was refuted.
      const failures = read.failures;
      let verdict: 'pass' | 'fail' = failures.length ? 'fail' : parsed.verdict === 'pass' ? 'pass' : 'fail';
      if (verdict === 'fail' && failures.length === 0) {
        if (read.listed > 0) {
          verdict = 'pass';
        } else {
          failures.push({
            rule: 'the checker failed the answer without saying why',
            evidence: oneLine(raw, 280),
            checker: name,
          });
        }
      }
      const passedRules = [
        ...(Array.isArray(parsed.passed_rules) ? parsed.passed_rules.map((r: any) => String(r)) : []),
        ...(Array.isArray(parsed.confirmed) ? parsed.confirmed.map((r: any) => String(r)) : []),
      ];
      const notes = [
        ...(parsed.truncated ? [`the checker's reply was cut off at its output limit (${maxTokens} tokens); it was read up to its last complete item`] : []),
        ...read.discarded.map((d) => `not counted: "${oneLine(d.rule, 120)}" (${d.reason})`),
      ];

      return {
        checker: name,
        verdict,
        failures,
        passedRules,
        cost,
        tokens,
        ...usage,
        ...(notes.length ? { note: notes.join('; ') } : {}),
        ...answered,
      };
    } catch (err: any) {
      const detail =
        err?.response?.data?.error?.message || err?.message || 'checker call failed';
      return {
        checker: name,
        verdict: 'error',
        failures: [],
        passedRules: [],
        error: typeof detail === 'string' ? detail : JSON.stringify(detail),
      };
    }
  }

  /**
   * The items of a checker reply that count as failures. The reply puts
   * real failures in "failures" and what the evidence confirms in
   * "confirmed" (VERDICT_SCHEMA); checkers still listed confirmations as
   * failures, and each such item failed a correct answer. So an item does
   * not count when:
   *  - the checker marks it as not failed ("status": "pass", "ok", ...), or
   *    gives it no status on a "pass" verdict;
   *  - its claim is also in "confirmed";
   *  - its own reason or evidence says the claim is correct ("which is
   *    correct", "is acceptable", "no failure here": confirmsClaim);
   *  - its reason states a false version order ("4.18.1 < 4.17.21");
   *  - it says the item is absent, invented or not found, and the item's
   *    DOI, id, number, version or title is in the evidence
   *    (presentInEvidence).
   * Each item left out is said, with why, on the verify step.
   */
  readFailures(
    parsed: ParsedVerdict,
    checker: string,
    evidence = '',
  ): { failures: VerifyFailure[]; listed: number; discarded: Array<{ rule: string; reason: string }> } {
    const items = Array.isArray(parsed.failures) ? parsed.failures : [];
    const confirmed = Array.isArray(parsed.confirmed) ? parsed.confirmed.map((c: any) => String(c ?? '')).filter(Boolean) : [];
    const failures: VerifyFailure[] = [];
    const discarded: Array<{ rule: string; reason: string }> = [];
    for (const f of items) {
      const rule = String((f && typeof f === 'object' ? f.rule : f) ?? 'unspecified');
      const evidenceText = String((f && typeof f === 'object' ? f.evidence : '') ?? '');
      const claim = f && typeof f === 'object' && f.claim !== undefined && f.claim !== null ? String(f.claim) : undefined;
      const status = f && typeof f === 'object' && typeof f.status === 'string' ? f.status.trim().toLowerCase() : '';
      if (status ? !FAILED_STATUSES.has(status) : parsed.verdict === 'pass') {
        discarded.push({ rule, reason: 'the checker did not mark it as failed' });
        continue;
      }
      if (listedAsConfirmed(claim, confirmed)) {
        discarded.push({ rule, reason: 'the checker also listed this claim as confirmed' });
        continue;
      }
      // The failure's own words: its reason, then its evidence.
      const words = [rule.trim(), evidenceText.trim()].filter(Boolean).join('\n');
      const confirms = confirmsClaim(words);
      if (confirms) {
        discarded.push({ rule, reason: `its own words say the claim is right: "${oneLine(confirms, 40)}"` });
        continue;
      }
      const wrongOrder = falseVersionOrder(words);
      if (wrongOrder) {
        discarded.push({ rule, reason: wrongOrder });
        continue;
      }
      const present = presentInEvidence({ claim, rule, evidence: evidenceText }, evidence);
      if (present) {
        discarded.push({ rule, reason: `it says the item is absent, but ${present} is in the tool results` });
        continue;
      }
      failures.push({ rule, evidence: evidenceText, checker, ...(claim ? { claim } : {}) });
    }
    return { failures, listed: items.length, discarded };
  }

  /**
   * Tolerant JSON extraction from a checker reply (handles code fences /
   * prose). A reply cut off mid-JSON (the output limit) is read up to its
   * last complete item, and says so (`truncated`).
   */
  parseCheckerJson(raw: string): (ParsedVerdict & { truncated?: boolean }) | null {
    if (!raw) return null;
    const text = stripClosingFence(raw.trim().replace(/^```(?:json)?\s*/i, ''));
    const whole = asVerdict(tryJson(text));
    if (whole) return whole;
    const start = text.indexOf('{');
    if (start === -1) return null;
    const end = text.lastIndexOf('}');
    if (end > start) {
      const inner = asVerdict(tryJson(text.slice(start, end + 1)));
      if (inner) return inner;
    }
    const salvaged = salvageTruncatedJson(text.slice(start));
    return salvaged ? { ...salvaged, truncated: true } : null;
  }

  /**
   * Merge checker verdicts per policy.
   *  - all_pass:        pass only if every checker explicitly passed (fail OR error blocks)
   *  - majority:        pass if decisive passes outnumber decisive fails (errors ignored; tie blocks)
   *  - any_fail_blocks: pass unless a checker explicitly failed (errors do not veto) — default
   * If no checker returned a usable verdict, the result is 'fail' and
   * `unavailable`: correctness could not be asserted, so the gate must not
   * silently pass, but nothing was found wrong either, and the failure says
   * that in plain words.
   */
  mergeVerdicts(
    results: CheckerResult[],
    policy: VerifyPolicy,
  ): { verdict: 'pass' | 'fail'; failures: VerifyFailure[]; passedRules: string[]; unavailable?: boolean } {
    const failures = results.flatMap((r) => r.failures);
    const passedRules = Array.from(new Set(results.flatMap((r) => r.passedRules)));
    const passes = results.filter((r) => r.verdict === 'pass').length;
    const fails = results.filter((r) => r.verdict === 'fail').length;

    if (passes + fails === 0) {
      const why = results
        .map((r) => (r.error ? `${r.checker}: ${r.error}` : ''))
        .filter(Boolean)
        .join('; ');
      return {
        verdict: 'fail',
        unavailable: true,
        failures: failures.length
          ? failures
          : [
              {
                rule: UNAVAILABLE_RULE,
                evidence: why || 'no checker was configured',
                checker: 'verify',
                code: 'verification_unavailable',
              },
            ],
        passedRules,
      };
    }

    let verdict: 'pass' | 'fail';
    switch (policy) {
      case 'all_pass':
        verdict = results.every((r) => r.verdict === 'pass') ? 'pass' : 'fail';
        break;
      case 'majority':
        verdict = passes > fails ? 'pass' : 'fail';
        break;
      case 'any_fail_blocks':
      default:
        verdict = fails > 0 ? 'fail' : 'pass';
        break;
    }
    return { verdict, failures, passedRules };
  }
}
