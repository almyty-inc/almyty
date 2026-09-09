/**
 * Router feature flags, read from the environment in one place so the
 * pure routing modules never touch process.env themselves.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * MODEL_ROUTER_VERIFY_ESCALATION: let a verifier failure advance the route
 * plan to the next candidate (tier 2). Default off: a rejected answer is
 * handled by the verify flow alone (revise loop, condition branch).
 */
export function verifyEscalationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MODEL_ROUTER_VERIFY_ESCALATION?.trim().toLowerCase();
  return raw !== undefined && TRUTHY.has(raw);
}
