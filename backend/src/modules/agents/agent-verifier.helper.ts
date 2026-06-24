import { Injectable } from '@nestjs/common';

import { LlmProvidersService } from '../llm-providers/llm-providers.service';

/** Verdict-merge policy for a verify node's checker panel. */
export type VerifyPolicy = 'all_pass' | 'majority' | 'any_fail_blocks';

export interface VerifyFailure {
  rule: string;
  evidence: string;
  checker: string;
}

/** A single refute-only checker. Vendor is chosen per-checker via providerId. */
export interface CheckerConfig {
  name?: string;
  providerId: string;
  model?: string;
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
}

export interface VerifyPanelResult {
  verdict: 'pass' | 'fail';
  passed: boolean;
  policy: VerifyPolicy;
  failures: VerifyFailure[];
  passedRules: string[];
  checkers: Array<{ checker: string; verdict: 'pass' | 'fail' | 'error'; error?: string }>;
  cost: number;
  tokens: number;
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
    },
    organizationId: string,
    userId?: string,
    signal?: AbortSignal,
  ): Promise<VerifyPanelResult> {
    const policy: VerifyPolicy = opts.policy || 'any_fail_blocks';
    const targetText =
      typeof opts.target === 'string'
        ? opts.target
        : JSON.stringify(opts.target, null, 2);
    const spec = opts.spec || '';
    const checkers = Array.isArray(opts.checkers) ? opts.checkers : [];

    const checkerResults = await Promise.all(
      checkers.map((checker, i) =>
        this.runChecker(checker, i, targetText, spec, organizationId, userId, signal),
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
    userId: string | undefined,
    signal?: AbortSignal,
  ): Promise<CheckerResult> {
    const name = checker?.name || `checker_${index + 1}`;
    if (!checker?.providerId) {
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
      (checker.instructions ? `\n\nFocus: ${checker.instructions}` : '') +
      `\n\nReply with ONLY a JSON object, no prose, no code fences:\n` +
      `{"verdict":"pass"|"fail","failures":[{"rule":"<short rule violated>","evidence":"<quote or location>"}],"passed_rules":["<rule satisfied>"]}\n` +
      `Use "fail" if you find ANY violation. Use "pass" only if the output fully satisfies the spec.`;

    const userPrompt =
      `SPEC (rules to enforce):\n${spec || '(no explicit spec — judge for correctness, completeness, and internal consistency)'}\n\n` +
      `OUTPUT (to check):\n${targetText}`;

    try {
      const response = await this.llmProvidersService.chat(
        checker.providerId,
        {
          messages: [
            { role: 'system' as any, content: systemPrompt },
            { role: 'user' as any, content: userPrompt },
          ],
          model: checker.model,
          temperature: checker.temperature ?? 0,
          maxTokens: checker.maxTokens,
          signal,
        },
        organizationId,
        userId,
      );

      const raw = response?.message?.content || '';
      const parsed = this.parseCheckerJson(raw);
      const cost = response?.cost || 0;
      const tokens = response?.usage?.totalTokens || 0;

      if (!parsed) {
        return {
          checker: name,
          verdict: 'error',
          failures: [],
          passedRules: [],
          error: 'unparseable checker response',
          cost,
          tokens,
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

      return { checker: name, verdict, failures, passedRules, cost, tokens };
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
    const text = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '');
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
