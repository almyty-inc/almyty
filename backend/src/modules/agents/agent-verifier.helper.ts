import { Injectable } from '@nestjs/common';

import { LlmProvidersService } from '../llm-providers/llm-providers.service';
import type { ChatResponse } from '../llm-providers/llm-providers.service';
import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';
import type { RoutingPolicy } from '../model-catalog/routing/model-router';

/** Verdict-merge policy for a verify node's checker panel. */
export type VerifyPolicy = 'all_pass' | 'majority' | 'any_fail_blocks';

export interface VerifyFailure {
  rule: string;
  evidence: string;
  checker: string;
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
  error?: string;
  cost?: number;
  tokens?: number;
  /** The model that gave the verdict, and the router's attribution when it was routed. */
  model?: string;
  providerId?: string;
  routing?: ChatResponse['routing'];
}

export interface VerifyPanelResult {
  verdict: 'pass' | 'fail';
  passed: boolean;
  policy: VerifyPolicy;
  failures: VerifyFailure[];
  passedRules: string[];
  checkers: Array<{
    checker: string;
    verdict: 'pass' | 'fail' | 'error';
    error?: string;
    model?: string;
    providerId?: string;
    routing?: ChatResponse['routing'];
  }>;
  cost: number;
  tokens: number;
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

/** Per tool result and in all: what a checker is shown of the run's evidence. */
const EVIDENCE_PER_RESULT = 8_000;
const EVIDENCE_TOTAL = 40_000;

/**
 * What an autonomous run was asked and what its tools returned: the ground a
 * checker judges the final answer against. Without it a checker had only the
 * answer, so "is this version what npm returned?" was judged from the
 * checker's own (stale) knowledge, and a correct answer was failed and sent
 * back for revision (lodash 4.18.1 "is not the latest, 4.17.21 is").
 * Bounded so a run that read large payloads cannot blow the checker's context.
 */
export function runEvidence(run: { input?: unknown; steps?: Array<{ type?: string; input?: any; output?: unknown; error?: unknown }> }): string {
  const parts: string[] = [];
  const request = run.input && typeof run.input === 'object' && 'message' in (run.input as any) ? (run.input as any).message : run.input;
  if (request !== undefined && request !== null && request !== '') {
    parts.push(`REQUEST:\n${typeof request === 'string' ? request : JSON.stringify(request)}`);
  }
  let used = 0;
  for (const step of run.steps ?? []) {
    if (step?.type !== 'tool_call') continue;
    const tool = step.input?.tool ?? step.input?.toolName ?? 'tool';
    const args = step.input?.parameters ? ` ${JSON.stringify(step.input.parameters)}` : '';
    const raw = step.error ? `ERROR ${String((step.error as any)?.message ?? step.error)}` : typeof step.output === 'string' ? step.output : JSON.stringify(step.output ?? null);
    const body = raw.length > EVIDENCE_PER_RESULT ? `${raw.slice(0, EVIDENCE_PER_RESULT)}… (cut)` : raw;
    if (used + body.length > EVIDENCE_TOTAL) {
      parts.push(`${tool}${args}: (left out: the evidence limit was reached)`);
      continue;
    }
    used += body.length;
    parts.push(`${tool}${args}:\n${body}`);
  }
  return parts.join('\n\n');
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
      policy,
      failures: merged.failures,
      passedRules: merged.passedRules,
      checkers: checkerResults.map((r) => ({
        checker: r.checker,
        verdict: r.verdict,
        ...(r.error ? { error: r.error } : {}),
        ...(r.model ? { model: r.model } : {}),
        ...(r.providerId ? { providerId: r.providerId } : {}),
        ...(r.routing ? { routing: r.routing } : {}),
      })),
      cost: checkerResults.reduce((s, r) => s + (r.cost || 0), 0),
      tokens: checkerResults.reduce((s, r) => s + (r.tokens || 0), 0),
    };
  }

  /**
   * Render a checker panel's failures into a critique message the agent can
   * act on. Used by the autonomous revise loop as synthetic user feedback.
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
              `${i + 1}. ${f.rule}${f.evidence ? ` — evidence: ${f.evidence}` : ''}` +
              (f.checker ? ` (${f.checker})` : ''),
          )
          .join('\n')
      : 'The verifier could not confirm the answer is correct.';
    return (
      `A verification panel reviewed your answer and found problems ` +
      `(revision ${attempt} of ${maxAttempts}):\n\n${lines}\n\n` +
      `Fix every issue above and produce a corrected final answer. ` +
      `Do not repeat the same mistakes.`
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
        error: 'missing providerId',
      };
    }

    const systemPrompt =
      `You are a verifier. Your ONLY job is to find what is WRONG with the OUTPUT ` +
      `relative to the SPEC. Do not praise, summarize, or restate. Hunt for ` +
      `violations, missing requirements, unsupported claims, and contradictions.` +
      (evidence
        ? `\n\nThe EVIDENCE is what the agent was asked and what its tools returned in this run. ` +
          `Judge every factual claim against it: a claim is wrong only if the EVIDENCE contradicts it or does not support it. ` +
          `Never use your own knowledge of versions, dates, prices or other facts to overrule the EVIDENCE; it is newer than you.`
        : '') +
      (checker.instructions ? `\n\nFocus: ${checker.instructions}` : '') +
      `\n\nReply with ONLY a JSON object, no prose, no code fences:\n` +
      `{"verdict":"pass"|"fail","failures":[{"rule":"<short rule violated>","evidence":"<quote or location>"}],"passed_rules":["<rule satisfied>"]}\n` +
      `Use "fail" if you find ANY violation. Use "pass" only if the output fully satisfies the spec.`;

    const userPrompt =
      `SPEC (rules to enforce):\n${spec || '(no explicit spec — judge for correctness, completeness, and internal consistency)'}\n\n` +
      (evidence ? `EVIDENCE (ground truth for this run):\n${evidence}\n\n` : '') +
      `OUTPUT (to check):\n${targetText}`;

    try {
      const response = await this.llmProvidersService.chat(
        checker.providerId ?? null,
        {
          messages: [
            { role: 'system' as any, content: systemPrompt },
            { role: 'user' as any, content: userPrompt },
          ],
          // A routed checker lets the catalog pick its model per call.
          model: checker.routing ? undefined : checker.model,
          ...(checker.routing ? { routing: checker.routing } : {}),
          temperature: checker.temperature ?? 0,
          maxTokens: checker.maxTokens,
          signal,
          // Without the date a checker took its training cutoff for today
          // and failed real papers dated last week as "from the future".
          currentTime: true,
        },
        organizationId,
        userId,
      );

      const raw = response?.message?.content || '';
      const parsed = this.parseCheckerJson(raw);
      const cost = response?.cost || 0;
      const tokens = response?.usage?.totalTokens || 0;
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
        return {
          checker: name,
          verdict: 'error',
          failures: [],
          passedRules: [],
          error: 'unparseable checker response',
          cost,
          tokens,
          ...answered,
        };
      }

      const verdict: 'pass' | 'fail' = parsed.verdict === 'pass' ? 'pass' : 'fail';
      const failures: VerifyFailure[] = Array.isArray(parsed.failures)
        ? parsed.failures.map((f: any) => ({
            rule: String(f?.rule ?? 'unspecified'),
            evidence: String(f?.evidence ?? ''),
            checker: name,
          }))
        : [];
      // A 'fail' with no listed failure still blocks — synthesize one so the
      // failure list is never silently empty on a fail.
      if (verdict === 'fail' && failures.length === 0) {
        failures.push({
          rule: 'unspecified failure',
          evidence: raw.slice(0, 280),
          checker: name,
        });
      }
      const passedRules = Array.isArray(parsed.passed_rules)
        ? parsed.passed_rules.map((r: any) => String(r))
        : [];

      return { checker: name, verdict, failures, passedRules, cost, tokens, ...answered };
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

  /** Tolerant JSON extraction from a checker reply (handles code fences / prose). */
  private parseCheckerJson(
    raw: string,
  ): { verdict?: string; failures?: any[]; passed_rules?: any[] } | null {
    if (!raw) return null;
    const text = stripClosingFence(raw.trim().replace(/^```(?:json)?\s*/i, ''));
    try {
      return JSON.parse(text);
    } catch {
      /* fall through to brace extraction */
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  /**
   * Merge checker verdicts per policy.
   *  - all_pass:        pass only if every checker explicitly passed (fail OR error blocks)
   *  - majority:        pass if decisive passes outnumber decisive fails (errors ignored; tie blocks)
   *  - any_fail_blocks: pass unless a checker explicitly failed (errors do not veto) — default
   * If no checker returned a usable verdict, the result is 'fail': correctness
   * could not be asserted, so the gate must not silently pass.
   */
  mergeVerdicts(
    results: CheckerResult[],
    policy: VerifyPolicy,
  ): { verdict: 'pass' | 'fail'; failures: VerifyFailure[]; passedRules: string[] } {
    const failures = results.flatMap((r) => r.failures);
    const passedRules = Array.from(new Set(results.flatMap((r) => r.passedRules)));
    const passes = results.filter((r) => r.verdict === 'pass').length;
    const fails = results.filter((r) => r.verdict === 'fail').length;

    if (passes + fails === 0) {
      return {
        verdict: 'fail',
        failures: failures.length
          ? failures
          : [
              {
                rule: 'verification_unavailable',
                evidence: 'no checker returned a usable verdict',
                checker: 'verify',
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
