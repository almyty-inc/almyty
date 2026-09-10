/**
 * Co-failure: how often every eligible model failed the same request.
 *
 * This is the mathematical ceiling on any routing gain, and it is the
 * number that makes work on routing falsifiable. If every model fails the
 * same 30% of a task class, no policy recovers those requests, and the
 * most a perfect router could win is the remaining 70%. Without measuring
 * it, "improve routing" has no target and no stopping point.
 *
 * Surfaced as **routing headroom**: the share of requests where at least
 * one model succeeded and the one actually used did not. That is the part
 * a better policy could have won.
 *
 * Cross-cutting, not a layer. See docs/design/layers.md.
 */

/** One request, and how each model that was tried on it fared. */
export interface AttemptRecord {
  /** Groups comparable requests. Routing headroom is only meaningful within a class. */
  taskClass: string;
  requestId: string;
  modelId: string;
  succeeded: boolean;
}

export interface CoFailureStats {
  taskClass: string;
  /** Requests where more than one model was tried, so a comparison exists. */
  comparableRequests: number;
  /** Requests where every model tried failed. No policy recovers these. */
  coFailures: number;
  /** coFailures / comparableRequests. The ceiling on any routing gain. */
  coFailureRate: number;
  /**
   * Requests where at least one model succeeded and at least one failed.
   * This is what a better policy could have won, and nothing more.
   */
  routingHeadroom: number;
  routingHeadroomRate: number;
  /** Requests where every model tried succeeded. Routing changes nothing here either. */
  allSucceeded: number;
}

/**
 * Compute per task class.
 *
 * Only requests with more than one distinct model tried are counted: a
 * request tried on one model tells you nothing about whether another
 * would have done better, and including it would understate headroom by
 * padding the denominator with unanswerable cases. That exclusion is the
 * whole reason this number can be trusted, so it is not configurable.
 */
export function computeCoFailure(attempts: AttemptRecord[]): CoFailureStats[] {
  const byClass = new Map<string, Map<string, Map<string, boolean>>>();

  for (const a of attempts) {
    if (!byClass.has(a.taskClass)) byClass.set(a.taskClass, new Map());
    const requests = byClass.get(a.taskClass)!;
    if (!requests.has(a.requestId)) requests.set(a.requestId, new Map());
    const models = requests.get(a.requestId)!;
    // A model retried on the same request counts as succeeding if it ever
    // did: the question is whether that model could answer, not whether
    // every attempt did.
    models.set(a.modelId, (models.get(a.modelId) ?? false) || a.succeeded);
  }

  const out: CoFailureStats[] = [];
  for (const [taskClass, requests] of byClass) {
    let comparable = 0;
    let coFailures = 0;
    let headroom = 0;
    let allSucceeded = 0;

    for (const models of requests.values()) {
      if (models.size < 2) continue;
      comparable++;
      const outcomes = [...models.values()];
      const anySucceeded = outcomes.some(Boolean);
      const anyFailed = outcomes.some((v) => !v);
      if (!anySucceeded) coFailures++;
      else if (anyFailed) headroom++;
      else allSucceeded++;
    }

    out.push({
      taskClass,
      comparableRequests: comparable,
      coFailures,
      coFailureRate: comparable === 0 ? 0 : coFailures / comparable,
      routingHeadroom: headroom,
      routingHeadroomRate: comparable === 0 ? 0 : headroom / comparable,
      allSucceeded,
    });
  }

  return out.sort((a, b) => b.routingHeadroomRate - a.routingHeadroomRate || a.taskClass.localeCompare(b.taskClass));
}

/**
 * Whether a measurement says anything.
 *
 * A rate computed from three requests is noise, and presenting it beside
 * a rate from three thousand invites someone to act on the first. Below
 * this it is reported as insufficient rather than as a number.
 */
export const MIN_COMPARABLE_REQUESTS = 30;

export function isReportable(stats: CoFailureStats): boolean {
  return stats.comparableRequests >= MIN_COMPARABLE_REQUESTS;
}

/** One line a person can read, or an honest refusal to give one. */
export function describeHeadroom(stats: CoFailureStats): string {
  if (!isReportable(stats)) {
    return `${stats.taskClass}: not enough comparable requests yet (${stats.comparableRequests} of ${MIN_COMPARABLE_REQUESTS} needed)`;
  }
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return (
    `${stats.taskClass}: ${pct(stats.routingHeadroomRate)} routing headroom, ` +
    `${pct(stats.coFailureRate)} co-failure (no policy recovers those), ` +
    `over ${stats.comparableRequests} comparable requests`
  );
}
