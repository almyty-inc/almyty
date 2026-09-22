import type { RoutingPolicy, VerifyEscalationPolicy } from './model-router';
import { verifyEscalationEnabled } from './router-config';

/**
 * Router tier 2: verify escalation.
 *
 * Tier 1 walks the plan when a candidate fails to answer. Tier 2 walks it
 * when a candidate answered but a verifier rejected the answer. Pure:
 * given the policy, the verdict and where the request is in its plan, it
 * says whether to re-run with the next candidate. It never calls anything.
 *
 * The caller (whatever runs the verify panel) owns the loop. It re-issues
 * the routed request with `skipCandidates` set to the position of the
 * rejected candidate, so the plan starts after it; `nextRoutingPolicy`
 * builds that policy. The whole feature sits behind
 * MODEL_ROUTER_VERIFY_ESCALATION (default off): with the flag off every
 * failed verdict is a 'stop'.
 */

/** The part of a verifier result escalation cares about. */
export interface VerifyOutcome {
  passed: boolean;
  failures?: Array<{ rule: string; evidence?: string; checker?: string }>;
}

export interface EscalationState {
  /** 1-based position in the plan of the candidate that produced the answer. */
  attempt: number;
  /** Candidates the plan had in total, before any skip. Unknown when the caller only holds the answer. */
  candidateCount?: number;
  /** Escalations already spent on this request. */
  escalations: number;
  /** The caller was cancelled; never escalate then. */
  aborted?: boolean;
}

export type EscalationDecision =
  | { action: 'accept'; reason: string }
  | { action: 'stop'; reason: string }
  | { action: 'escalate'; reason: string; nextAttempt: number; skipCandidates: number };

function effectiveMax(policy: VerifyEscalationPolicy, state: EscalationState): number {
  const room = state.candidateCount === undefined ? Number.POSITIVE_INFINITY : Math.max(0, state.candidateCount - 1);
  if (policy.maxEscalations === undefined || policy.maxEscalations === null) return room;
  if (!Number.isFinite(policy.maxEscalations)) return room;
  return Math.min(room, Math.max(0, Math.floor(policy.maxEscalations)));
}

/**
 * Decide what a verify verdict means for the route.
 *
 * - passed: accept.
 * - flag off, no escalation policy, or onVerifyFail 'stop': stop with the answer as is.
 * - cancelled: stop.
 * - out of escalations (maxEscalations, or the plan has no further candidate): stop.
 * - otherwise: escalate to the next candidate.
 */
export function decideEscalation(
  policy: RoutingPolicy | undefined,
  outcome: VerifyOutcome,
  state: EscalationState,
  enabled: boolean = verifyEscalationEnabled(),
): EscalationDecision {
  if (outcome.passed) return { action: 'accept', reason: 'verifier passed' };
  if (!enabled) return { action: 'stop', reason: 'verify escalation disabled (MODEL_ROUTER_VERIFY_ESCALATION)' };
  const escalation = policy?.escalation;
  if (!escalation) return { action: 'stop', reason: 'no escalation policy on the route' };
  if (escalation.onVerifyFail !== 'next-candidate') return { action: 'stop', reason: `escalation policy is '${escalation.onVerifyFail}'` };
  if (state.aborted) return { action: 'stop', reason: 'request cancelled' };
  if (!Number.isInteger(state.attempt) || state.attempt < 1) return { action: 'stop', reason: 'attempt position unknown' };

  const max = effectiveMax(escalation, state);
  if (state.escalations >= max) {
    return {
      action: 'stop',
      reason: max === 0 ? 'no escalation budget' : `escalation budget exhausted (${state.escalations}/${max})`,
    };
  }
  if (state.candidateCount !== undefined && state.attempt >= state.candidateCount) {
    return { action: 'stop', reason: 'no further candidate in the plan' };
  }

  const nextAttempt = state.attempt + 1;
  const failed = (outcome.failures ?? []).length;
  const of = state.candidateCount === undefined ? '' : ` of ${state.candidateCount}`;
  return {
    action: 'escalate',
    reason: `verifier rejected candidate ${state.attempt}${of} (${failed} failure${failed === 1 ? '' : 's'}); trying candidate ${nextAttempt}`,
    nextAttempt,
    skipCandidates: state.attempt,
  };
}

/**
 * The policy to send with the re-run: identical, with the answered
 * candidates skipped. Selection is deterministic for a fixed catalog, so
 * skipping by position lands on the next card of the same plan.
 */
export function nextRoutingPolicy(policy: RoutingPolicy, decision: Extract<EscalationDecision, { action: 'escalate' }>): RoutingPolicy {
  return { ...policy, skipCandidates: decision.skipCandidates };
}

export interface EscalationStep {
  attempt: number;
  decision: EscalationDecision['action'];
  reason: string;
  failures: number;
}

export interface EscalatedResult<T> {
  output: T;
  verify: VerifyOutcome;
  /** 1-based plan position of the candidate whose answer is returned. */
  attempt: number;
  escalations: number;
  trail: EscalationStep[];
}

/** Absolute 1-based plan position of an answer: the routed attempt plus whatever the policy skipped. */
export function planPosition(attempt: number | undefined, policy: RoutingPolicy | undefined): number {
  return (attempt ?? 1) + Math.max(0, Math.floor(policy?.skipCandidates ?? 0));
}

function isPlanExhausted(error: any): boolean {
  return error?.code === 'NO_ROUTE' || error?.name === 'NoRouteError';
}

/**
 * The loop, for callers that hold both the call and the verify panel:
 * run with the policy, verify, decide, and re-run with the next candidate
 * while the decision says so. `run` receives the policy to send (with
 * `skipCandidates` set on re-runs) and reports the 1-based plan position
 * the answer came from (`planPosition(response.routing?.attempt, policy)`).
 * `candidateCount` is optional: without it the plan's end shows up as a
 * NO_ROUTE error on the re-run, which ends the loop with the last answer.
 * The last answer is returned whatever the final verdict; the trail says
 * what happened to each.
 */
export async function runWithVerifyEscalation<T>(opts: {
  policy: RoutingPolicy;
  candidateCount?: number;
  run: (policy: RoutingPolicy) => Promise<{ output: T; attempt: number }>;
  verify: (output: T, attempt: number) => Promise<VerifyOutcome>;
  enabled?: boolean;
  signal?: AbortSignal;
}): Promise<EscalatedResult<T>> {
  const enabled = opts.enabled ?? verifyEscalationEnabled();
  const trail: EscalationStep[] = [];
  let policy = opts.policy;
  let escalations = 0;
  let last: { output: T; verify: VerifyOutcome; attempt: number } | null = null;
  for (;;) {
    let output: T;
    let attempt: number;
    try {
      ({ output, attempt } = await opts.run(policy));
    } catch (error) {
      if (last && isPlanExhausted(error)) {
        trail.push({ attempt: last.attempt, decision: 'stop', reason: 'no further candidate in the plan', failures: (last.verify.failures ?? []).length });
        return { ...last, escalations: escalations - 1, trail };
      }
      throw error;
    }
    const verify = await opts.verify(output, attempt);
    const decision = decideEscalation(
      opts.policy,
      verify,
      { attempt, candidateCount: opts.candidateCount, escalations, aborted: opts.signal?.aborted },
      enabled,
    );
    trail.push({ attempt, decision: decision.action, reason: decision.reason, failures: (verify.failures ?? []).length });
    if (decision.action !== 'escalate') return { output, verify, attempt, escalations, trail };
    last = { output, verify, attempt };
    escalations++;
    policy = nextRoutingPolicy(opts.policy, decision);
  }
}
