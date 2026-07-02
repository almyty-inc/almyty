import { Injectable } from '@nestjs/common';
import {
  ApprovalMatchCondition,
  ApprovalPolicy,
  ApprovalStep,
} from '../../../src/entities/approval-policy.entity';

/** Attributes of the action being gated (from the request_approval call). */
export type ApprovalContext = Record<string, unknown>;

/** A single approval already collected for a request. */
export interface CollectedApproval {
  approverId: string;
  /** The approver's role(s): org role and/or custom-role names. */
  roles: string[];
}

export interface StepProgress {
  index: number;
  name: string;
  approverRole: string;
  required: number;
  satisfiedBy: number;
  satisfied: boolean;
}

export interface PolicyProgress {
  policyId: string;
  policyName: string;
  totalRequired: number;
  totalCollected: number;
  steps: StepProgress[];
  /** Index of the first not-yet-satisfied step, or -1 when complete. */
  currentStep: number;
  satisfied: boolean;
}

/**
 * EE (approval_policy): stateless engine that (a) picks the policy that
 * governs a given request, and (b) scores the approvals collected so far
 * against that policy's sequential steps / quorum. No DB access — the
 * service loads policies and hands them in.
 *
 * Sequential semantics: step N+1 does not begin accepting approvals until
 * step N is satisfied. An approval is credited to the earliest unsatisfied
 * step whose `approverRole` the approver matches. `approverRole === '*'`
 * matches any approver (a plain quorum). An approver may only be counted
 * once per step.
 */
@Injectable()
export class ApprovalPolicyEvaluator {
  /**
   * Return the highest-priority enabled policy whose `match` conditions
   * hold for the context, or null when nothing matches (→ falls back to
   * the OSS single-gate approval).
   */
  resolvePolicy(policies: ApprovalPolicy[], ctx: ApprovalContext): ApprovalPolicy | null {
    const matching = policies
      .filter((p) => p.enabled)
      .filter((p) => this.matches(p.match ?? [], ctx));
    if (matching.length === 0) return null;
    return matching.reduce((best, p) => (p.priority > best.priority ? p : best));
  }

  /** Total approvals a policy requires across all its steps. */
  totalRequired(policy: ApprovalPolicy): number {
    return (policy.steps ?? []).reduce((sum, s) => sum + Math.max(0, s.minApprovals), 0);
  }

  /**
   * Score `approvals` against `policy`. Approvals are consumed greedily,
   * step by step, so a manager approval can't satisfy a finance step it
   * doesn't match.
   */
  progress(policy: ApprovalPolicy, approvals: CollectedApproval[]): PolicyProgress {
    const steps = policy.steps ?? [];
    const remaining = [...approvals];
    const stepProgress: StepProgress[] = [];
    let currentStep = -1;
    let allSatisfied = true;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const required = Math.max(0, step.minApprovals);
      const usedIdx: number[] = [];
      let satisfiedBy = 0;
      // Only start crediting a step once every prior step is satisfied.
      const priorSatisfied = stepProgress.every((sp) => sp.satisfied);
      if (priorSatisfied) {
        for (let r = 0; r < remaining.length && satisfiedBy < required; r++) {
          if (this.approverMatches(step, remaining[r])) {
            satisfiedBy++;
            usedIdx.push(r);
          }
        }
        // Consume the credited approvals so a later step can't reuse them.
        for (const idx of usedIdx.sort((a, b) => b - a)) remaining.splice(idx, 1);
      }
      const satisfied = satisfiedBy >= required;
      if (!satisfied && allSatisfied) {
        currentStep = i;
        allSatisfied = false;
      }
      stepProgress.push({
        index: i,
        name: step.name,
        approverRole: step.approverRole,
        required,
        satisfiedBy,
        satisfied,
      });
    }

    return {
      policyId: policy.id,
      policyName: policy.name,
      totalRequired: this.totalRequired(policy),
      totalCollected: approvals.length,
      steps: stepProgress,
      currentStep: allSatisfied ? -1 : currentStep,
      satisfied: allSatisfied,
    };
  }

  private approverMatches(step: ApprovalStep, approval: CollectedApproval): boolean {
    if (step.approverRole === '*') return true;
    return approval.roles.includes(step.approverRole);
  }

  private matches(conditions: ApprovalMatchCondition[], ctx: ApprovalContext): boolean {
    return conditions.every((c) => this.conditionHolds(c, ctx));
  }

  private conditionHolds(cond: ApprovalMatchCondition, ctx: ApprovalContext): boolean {
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
      default:
        return false;
    }
  }

  private resolve(path: string, ctx: ApprovalContext): unknown {
    const parts = path.split('.');
    let cur: unknown = ctx;
    for (const part of parts) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }
}
