import { Injectable } from '@nestjs/common';
import { AbacCondition, AbacPolicy } from '../../entities/abac-policy.entity';

/**
 * Flattened attribute context an ABAC decision is made against. Callers
 * pass subject (the acting user + roles), resource (the thing being
 * touched), and free-form context (time, ip, env, ...). The evaluator
 * resolves condition dot-paths against this object.
 */
export interface EvaluationContext {
  subject?: Record<string, unknown>;
  resource?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface PolicyDecision {
  allowed: boolean;
  effect: 'allow' | 'deny' | 'default';
  reason: string;
  matchedPolicyId?: string;
}

/**
 * EE (advanced_rbac): stateless evaluator for custom-role permission
 * grants and ABAC policies. No DB access — the RBAC service loads the
 * org's roles/policies and hands them in, keeping this unit-testable and
 * cheap to call on the hot path.
 */
@Injectable()
export class PolicyEvaluatorService {
  /**
   * Does the union of `grantedPermissions` cover `required`? Supports
   * wildcards on either side of the `resource:action` pair:
   *   `*`            → everything
   *   `agents:*`     → any action on agents
   *   `*:read`       → read on any resource
   */
  permits(grantedPermissions: string[], required: string): boolean {
    if (!required) return false;
    const [reqRes, reqAct] = this.split(required);
    for (const grant of grantedPermissions) {
      if (grant === '*') return true;
      const [gRes, gAct] = this.split(grant);
      const resOk = gRes === '*' || gRes === reqRes;
      const actOk = gAct === '*' || gAct === reqAct;
      if (resOk && actOk) return true;
    }
    return false;
  }

  private split(perm: string): [string, string] {
    const idx = perm.indexOf(':');
    if (idx === -1) return [perm, '*'];
    return [perm.slice(0, idx), perm.slice(idx + 1)];
  }

  /**
   * Evaluate the ABAC policy set for a given action + context.
   * Deny-overrides: any applicable `deny` policy wins outright. Otherwise
   * the highest-priority applicable `allow` grants access. With no
   * applicable policy the result is a `default` deny (fail-closed) — the
   * caller decides whether to treat "no policy" as allow (most orgs run
   * ABAC as an additional deny layer on top of role checks).
   */
  evaluate(
    policies: AbacPolicy[],
    action: string,
    ctx: EvaluationContext,
  ): PolicyDecision {
    const applicable = policies
      .filter((p) => p.active)
      .filter((p) => p.action === '*' || p.action === action)
      .filter((p) => this.conditionsHold(p.conditions ?? [], ctx));

    const denies = applicable.filter((p) => p.effect === 'deny');
    if (denies.length > 0) {
      const top = this.highestPriority(denies);
      return {
        allowed: false,
        effect: 'deny',
        reason: `denied by policy "${top.name}"`,
        matchedPolicyId: top.id,
      };
    }

    const allows = applicable.filter((p) => p.effect === 'allow');
    if (allows.length > 0) {
      const top = this.highestPriority(allows);
      return {
        allowed: true,
        effect: 'allow',
        reason: `allowed by policy "${top.name}"`,
        matchedPolicyId: top.id,
      };
    }

    return { allowed: false, effect: 'default', reason: 'no applicable policy' };
  }

  private highestPriority(policies: AbacPolicy[]): AbacPolicy {
    return policies.reduce((best, p) => (p.priority > best.priority ? p : best));
  }

  private conditionsHold(conditions: AbacCondition[], ctx: EvaluationContext): boolean {
    return conditions.every((c) => this.conditionHolds(c, ctx));
  }

  private conditionHolds(cond: AbacCondition, ctx: EvaluationContext): boolean {
    const actual = this.resolve(cond.attr, ctx);
    const expected = cond.value;
    switch (cond.op) {
      case 'eq':
        return actual === expected;
      case 'neq':
        return actual !== expected;
      case 'gt':
        return typeof actual === 'number' && actual > (expected as number);
      case 'gte':
        return typeof actual === 'number' && actual >= (expected as number);
      case 'lt':
        return typeof actual === 'number' && actual < (expected as number);
      case 'lte':
        return typeof actual === 'number' && actual <= (expected as number);
      case 'in':
        return Array.isArray(expected) && expected.includes(actual as never);
      case 'nin':
        return Array.isArray(expected) && !expected.includes(actual as never);
      case 'contains':
        return Array.isArray(actual) && (actual as unknown[]).includes(expected);
      default:
        return false;
    }
  }

  /** Resolve a dot-path (`resource.amount`) against the context. */
  private resolve(path: string, ctx: EvaluationContext): unknown {
    const parts = path.split('.');
    let cur: unknown = ctx as unknown;
    for (const part of parts) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }
}
