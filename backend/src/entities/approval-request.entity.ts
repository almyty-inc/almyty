import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/**
 * Human-in-the-loop approval gate. Created by an agent run when it
 * invokes the built-in `request_approval(reason, payload?)` tool. The
 * run pauses (status=WAITING_APPROVAL) until an authorized user
 * approves or rejects. On approve, the run resumes with the approver's
 * decision injected as the tool's result. On reject, the run terminates
 * with status=CANCELLED and the rejection reason is recorded as the
 * cancellation reason.
 *
 * RBAC: only org owner/admin OR a member with the resource's team
 * `LEAD` role can act on a request. Members of the resource's team
 * (non-LEAD) can VIEW requests but not approve/reject. Cross-team
 * visibility follows AccessPolicyService.applyListFilter.
 *
 * Auto-expiry: requests older than ttlSeconds (default 24h) flip to
 * 'expired' via a sweep, and the source run terminates as if rejected
 * with reason='approval expired'.
 */
@Entity('approval_requests')
@Index(['organizationId', 'status', 'createdAt'])
@Index(['runId'])
export class ApprovalRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  /** Inherited from the requesting agent's resource scoping. */
  @Column({ type: 'uuid', nullable: true })
  teamId: string | null;

  @Column({ type: 'varchar', length: 8, default: 'org' })
  visibility: 'org' | 'team';

  /** The agent run that paused on this approval gate. */
  @Column()
  runId: string;

  /** The agent that triggered the approval. */
  @Column()
  agentId: string;

  /**
   * Tool-call correlation id from the agent runtime. When the run
   * resumes, the approval decision is delivered as the result of this
   * tool call.
   */
  @Column({ nullable: true })
  toolCallId: string | null;

  /** Human-readable reason the agent gave for needing approval. */
  @Column({ type: 'text' })
  reason: string;

  /**
   * Optional structured payload describing what the agent intends to
   * do (the tool call args, an action plan, a diff, etc.). Used by the
   * UI to give the approver enough info to decide.
   */
  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, any> | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: ApprovalStatus;

  @Column({ type: 'uuid', nullable: true })
  decidedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  decisionReason: string | null;

  /**
   * Effective TTL — populated at creation. Sweeper compares to NOW()
   * and flips status='expired' when exceeded.
   */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
