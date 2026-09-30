import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * A matcher condition evaluated against the approval request context
 * (`{ agentId, toolName, amount, ... }`). Same shape as ABAC conditions
 * but resolved against the request attributes directly (no `subject.`
 * prefix). Empty matcher = the policy applies to every request.
 */
export interface ApprovalMatchCondition {
  attr: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin';
  value: unknown;
}

/**
 * One step of a multi-step approval. Each step is satisfied when
 * `minApprovals` distinct approvers who each satisfy `approverRole`
 * (an org role or custom-role name, or `*` for anyone authorized) have
 * approved. Steps are sequential — step N+1 cannot start until step N
 * is satisfied.
 */
export interface ApprovalStep {
  name: string;
  approverRole: string;
  minApprovals: number;
}

/**
 * A rule that asks for approval by itself, at the tool call, rather than
 * waiting for the agent to call request_approval: "ask before
 * issue_refund when amount is over 500". A call whose argument is at or
 * under the amount runs without asking. The amount is a plain number;
 * whatever currency the tool uses, it is the tool's.
 */
export interface ApprovalToolAmountTrigger {
  kind: 'tool_amount';
  /** The tool the rule watches. */
  toolId: string;
  /** Its name when the rule was saved, for the rule's summary. */
  toolName?: string;
  /** The numeric argument, as a dot path into the call's input (`amount`, `refund.total`). */
  argument: string;
  /** Over (gt), or at or over (gte). */
  op: 'gt' | 'gte';
  amount: number;
}
/**
 * EE (approval_policy): a declarative, multi-step / conditional / quorum
 * approval policy. The single-gate approval (one authorized approver
 * flips the request) stays OSS in the `approvals` module. This policy
 * engine sits in front of it: when a request matches a policy, the
 * request must collect the policy's full step/quorum requirement before
 * it is considered approved.
 *
 * Example — "refunds over $1,000 need two approvals: one finance, one
 * manager":
 *   match:  [{ attr: 'amount', op: 'gt', value: 1000 },
 *            { attr: 'toolName', op: 'eq', value: 'issue_refund' }]
 *   steps:  [{ name: 'finance', approverRole: 'finance', minApprovals: 1 },
 *            { name: 'manager', approverRole: 'admin',   minApprovals: 1 }]
 */
@Entity('approval_policies')
@Index(['organizationId', 'enabled', 'priority'])
export class ApprovalPolicy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 128 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /**
   * Optional team scoping (mirrors approval_requests visibility model).
   * Set = this policy governs only requests raised for that team; null =
   * org-wide. Enforced in ApprovalPolicyEvaluator.resolvePolicy against
   * the `teamId` ApprovalsService puts in the approval context.
   */
  @Column({ type: 'uuid', nullable: true })
  teamId: string | null;

  /** ANDed conditions; empty = matches every request. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  match: ApprovalMatchCondition[];

  /**
   * Ordered approval steps. A simple quorum ("any 2 approvers") is
   * expressed as a single step with `minApprovals: 2` and
   * `approverRole: '*'`.
   */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  steps: ApprovalStep[];

  /**
   * When set, the policy asks for approval by itself at the tool call
   * (ApprovalToolAmountTrigger), and governs only the requests it raises.
   * Null: the policy governs requests an agent raises with request_approval
   * that its `match` conditions select.
   */
  @Column({ type: 'jsonb', nullable: true })
  trigger: ApprovalToolAmountTrigger | null;
  /**
   * Higher priority wins when several policies match the same request —
   * the highest-priority matching policy is the one enforced.
   */
  @Column({ type: 'int', default: 0 })
  priority: number;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
