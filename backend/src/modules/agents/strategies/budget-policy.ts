/**
 * When to stop spending on a task.
 *
 * Cross-cutting rather than a layer: whichever layer is executing
 * consults it between stages. See docs/design/layers.md.
 *
 * The rule that shapes this file: **every decision records the projection
 * that caused it.** A run that stopped, degraded or continued has to be
 * explainable afterwards, and "it went over budget" is not an explanation
 * if nobody can see what the estimate was at the time.
 */

export interface BudgetPolicy {
  ceilingPerRun?: number;
  ceilingPerTask?: number;
  stopWhen?: {
    /** Stop as soon as the verifier passes, rather than using the rest of the budget. */
    verifierPasses?: boolean;
    /** Stop once confidence is at least this. */
    confidenceAbove?: number;
    /** Stop when another stage is projected to add less than this much value. */
    marginalGainBelow?: number;
  };
  onExceed?: 'stop' | 'degrade' | 'ask';
}

export interface StageProjection {
  /** Spent so far on this run, in cents. */
  spentCents: number;
  /** What the next stage is projected to cost, in cents. */
  nextStageCents: number;
  /** Whether the verifier has passed, when one has run. */
  verifierPassed?: boolean;
  confidence?: number;
  /** Projected improvement from running the next stage. */
  marginalGain?: number;
}

export type BudgetVerdict =
  | { action: 'continue'; projection: StageProjection }
  | { action: 'stop'; reason: string; projection: StageProjection }
  | { action: 'degrade'; reason: string; projection: StageProjection }
  | { action: 'ask'; reason: string; projection: StageProjection };

/**
 * Decide whether the next stage runs.
 *
 * Stop rules are checked before the ceiling, deliberately: a run that has
 * already got what it needs should stop because it is finished, not
 * because it ran out of money, and the recorded reason should say so.
 */
export function evaluateBudget(policy: BudgetPolicy | undefined, projection: StageProjection): BudgetVerdict {
  if (!policy) return { action: 'continue', projection };

  const stop = policy.stopWhen ?? {};
  if (stop.verifierPasses && projection.verifierPassed) {
    return { action: 'stop', reason: 'the verifier passed, so further stages would add nothing', projection };
  }
  if (stop.confidenceAbove !== undefined && (projection.confidence ?? 0) >= stop.confidenceAbove) {
    return {
      action: 'stop',
      reason: `confidence ${projection.confidence} reached the ${stop.confidenceAbove} threshold`,
      projection,
    };
  }
  if (stop.marginalGainBelow !== undefined && projection.marginalGain !== undefined && projection.marginalGain < stop.marginalGainBelow) {
    return {
      action: 'stop',
      reason: `the next stage is projected to add ${projection.marginalGain}, below the ${stop.marginalGainBelow} worth continuing for`,
      projection,
    };
  }

  const ceiling = policy.ceilingPerRun;
  if (ceiling !== undefined) {
    const projected = projection.spentCents + projection.nextStageCents;
    if (projected > ceiling) {
      const reason =
        `the next stage would take this run to ${projected} cents, over the ${ceiling} ceiling ` +
        `(spent ${projection.spentCents}, next stage ${projection.nextStageCents})`;
      const onExceed = policy.onExceed ?? 'stop';
      return { action: onExceed, reason, projection };
    }
  }

  return { action: 'continue', projection };
}
