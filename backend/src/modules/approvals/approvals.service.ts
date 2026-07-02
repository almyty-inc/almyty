import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException, Optional, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { EventEmitter } from 'events';

import { ApprovalRequest, ApprovalStatus } from '../../entities/approval-request.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import {
  APPROVAL_POLICY_HOOK,
  ApprovalPolicyApproval,
  ApprovalPolicyHook,
  ApprovalPolicyProgress,
  ApprovalPolicyRef,
} from '../../common/ee-hooks/ee-hooks';

export interface CreateApprovalInput {
  organizationId: string;
  teamId: string | null;
  runId: string;
  agentId: string;
  toolCallId?: string | null;
  reason: string;
  payload?: Record<string, any> | null;
  ttlSeconds?: number;
}

export interface ApprovalDecision {
  decidedBy: string;
  decisionReason?: string;
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60; // 7d

/**
 * HITL approval gate.
 *
 *   1. Agent calls built-in `request_approval(reason, payload?)` tool.
 *   2. Runtime calls ApprovalsService.create — this writes a row,
 *      flips the run to WAITING_APPROVAL, and emits 'approval.requested'.
 *   3. UI polls / subscribes to pending approvals; an authorized user
 *      calls approve(id, decision) or reject(id, decision).
 *   4. ApprovalsService emits 'approval.decided' with the row. The
 *      runtime listens and either resumes the run with the decision
 *      result (approve) or marks it CANCELLED (reject).
 *
 * Auto-expiry: a sweep flips pending rows past expiresAt to 'expired'
 * and treats them as rejections. Currently lives as a method here;
 * a BullMQ scheduled job is the obvious follow-up.
 */
@Injectable()
export class ApprovalsService extends EventEmitter {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    @InjectRepository(ApprovalRequest)
    private readonly approvals: Repository<ApprovalRequest>,
    @InjectRepository(AgentRun)
    private readonly runs: Repository<AgentRun>,
    private readonly accessPolicy: AccessPolicyService,
    // EE hook (approval_policy): multi-step / quorum policies. Absent in
    // the community build — @Optional() resolves to undefined and the
    // single-gate flow below is untouched.
    @Optional()
    @Inject(APPROVAL_POLICY_HOOK)
    private readonly approvalPolicyHook?: ApprovalPolicyHook,
  ) {
    super();
  }

  /**
   * Create an approval gate. Idempotent on (runId, toolCallId): a
   * second call with the same pair returns the existing row rather
   * than creating a duplicate.
   *
   * EE (approval_policy): when the optional policy hook resolves a
   * governing policy for this request, its reference is recorded under
   * the reserved `payload._policy` key so the decide path can enforce
   * the policy's steps/quorum. No policy (or no hook) → OSS single gate.
   */
  async create(input: CreateApprovalInput): Promise<ApprovalRequest> {
    if (input.toolCallId) {
      const existing = await this.approvals.findOne({
        where: { runId: input.runId, toolCallId: input.toolCallId },
      });
      if (existing) return existing;
    }

    const policy = await this.resolveGoverningPolicy(input);

    const ttl = Math.min(input.ttlSeconds ?? DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    const row = this.approvals.create({
      organizationId: input.organizationId,
      teamId: input.teamId,
      visibility: input.teamId ? 'team' : 'org',
      runId: input.runId,
      agentId: input.agentId,
      toolCallId: input.toolCallId ?? null,
      reason: input.reason,
      payload: policy
        ? {
            ...(input.payload ?? {}),
            _policy: { policyId: policy.id, policyName: policy.name, approvals: [] },
          }
        : input.payload ?? null,
      status: 'pending' as ApprovalStatus,
      expiresAt,
    } as Partial<ApprovalRequest>);
    const saved = await this.approvals.save(row);

    // Pause the run.
    await this.runs.update({ id: input.runId }, { status: AgentRunStatus.WAITING_APPROVAL });

    this.emit('approval.requested', saved);
    return saved;
  }

  async approve(id: string, decision: ApprovalDecision, caller: { id: string }): Promise<ApprovalRequest> {
    return this.decide(id, 'approved', decision, caller);
  }

  async reject(id: string, decision: ApprovalDecision, caller: { id: string }): Promise<ApprovalRequest> {
    return this.decide(id, 'rejected', decision, caller);
  }

  private async decide(
    id: string,
    next: ApprovalStatus,
    decision: ApprovalDecision,
    caller: { id: string },
  ): Promise<ApprovalRequest> {
    const row = await this.approvals.findOne({ where: { id } });
    if (!row) throw new NotFoundException('approval request not found');
    if (row.status !== 'pending') {
      throw new BadRequestException(`approval already ${row.status}`);
    }

    const can = await this.accessPolicy.canAccess(caller, row, 'manage');
    if (!can.allowed) throw new ForbiddenException(can.reason);

    // EE (approval_policy): a policy-governed request only flips to
    // approved once its steps/quorum are satisfied. A rejection is always
    // immediate (a single rejection kills the request, as in OSS).
    if (next === 'approved') {
      const stillPending = await this.applyPolicyProgress(row, caller);
      if (stillPending) return stillPending;
    }

    row.status = next;
    row.decidedBy = decision.decidedBy;
    row.decidedAt = new Date();
    row.decisionReason = decision.decisionReason ?? null;
    const saved = await this.approvals.save(row);

    this.emit('approval.decided', saved);
    return saved;
  }

  /**
   * EE (approval_policy): resolve the policy governing a new request via
   * the optional hook. Best-effort — any hook failure degrades to the OSS
   * single-gate flow rather than blocking the run.
   */
  private async resolveGoverningPolicy(
    input: CreateApprovalInput,
  ): Promise<ApprovalPolicyRef | null> {
    if (!this.approvalPolicyHook) return null;
    try {
      return await this.approvalPolicyHook.resolveForContext(input.organizationId, {
        reason: input.reason,
        agentId: input.agentId,
        runId: input.runId,
        toolCallId: input.toolCallId ?? null,
        teamId: input.teamId,
        payload: input.payload ?? {},
      });
    } catch (err: any) {
      this.logger.warn(`approval policy resolution failed: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * EE (approval_policy): record the caller's approval against the
   * governing policy and score progress. Returns the saved (still
   * pending) row when the policy's steps/quorum are not yet satisfied —
   * the caller then skips the status flip. Returns null when the OSS
   * single-gate flip should proceed: no hook, no recorded policy, policy
   * gone / unlicensed (hook scores null), or the policy is satisfied.
   */
  private async applyPolicyProgress(
    row: ApprovalRequest,
    caller: { id: string },
  ): Promise<ApprovalRequest | null> {
    const state = (row.payload as Record<string, any> | null)?._policy;
    if (!this.approvalPolicyHook || !state?.policyId) return null;

    const prior: ApprovalPolicyApproval[] = Array.isArray(state.approvals)
      ? state.approvals
      : [];
    if (prior.some((a) => a.approverId === caller.id)) {
      throw new BadRequestException('caller has already approved this request');
    }
    const roles = await this.resolveApproverRoles(caller.id, row);
    const collected = [...prior, { approverId: caller.id, roles }];

    let progress: ApprovalPolicyProgress | null = null;
    try {
      progress = await this.approvalPolicyHook.scoreProgress(
        row.organizationId,
        state.policyId,
        collected,
      );
    } catch (err: any) {
      this.logger.warn(`approval policy scoring failed: ${err?.message ?? err}`);
    }
    // No progress (unlicensed / policy deleted / hook failure) → fall back
    // to the OSS single gate: this approval decides the request.
    if (!progress) return null;

    row.payload = {
      ...(row.payload ?? {}),
      _policy: { ...state, approvals: collected, progress },
    };
    if (progress.satisfied) return null;

    const saved = await this.approvals.save(row);
    this.emit('approval.progress', saved);
    return saved;
  }

  /**
   * Role names used to match a policy step's `approverRole`: the caller's
   * org role ('owner' | 'admin' | 'member' | 'viewer') plus, when the
   * request is team-scoped, 'team_lead' / 'team_member'.
   */
  private async resolveApproverRoles(
    userId: string,
    row: ApprovalRequest,
  ): Promise<string[]> {
    const roles: string[] = [];
    try {
      const orgRole = await this.accessPolicy.getOrgRole(userId, row.organizationId);
      if (orgRole) roles.push(orgRole);
      if (row.teamId) {
        const memberships = await this.accessPolicy.getTeamMemberships(
          userId,
          row.organizationId,
        );
        const teamRole = memberships.get(row.teamId);
        if (teamRole) roles.push(`team_${teamRole}`);
      }
    } catch (err: any) {
      this.logger.warn(`approver role resolution failed: ${err?.message ?? err}`);
    }
    return roles;
  }

  async findOne(id: string, caller: { id: string }, organizationId: string): Promise<ApprovalRequest> {
    const row = await this.approvals.findOne({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('approval request not found');
    const can = await this.accessPolicy.canAccess(caller, row, 'read');
    if (!can.allowed) throw new ForbiddenException(can.reason);
    return row;
  }

  async listPending(args: { organizationId: string; caller: { id: string } }): Promise<ApprovalRequest[]> {
    const qb = this.approvals
      .createQueryBuilder('a')
      .where('a.status = :status', { status: 'pending' });
    await this.accessPolicy.applyListFilter(qb, args.caller, args.organizationId, 'a');
    return qb.orderBy('a."createdAt"', 'DESC').take(200).getMany();
  }

  async listForRun(runId: string): Promise<ApprovalRequest[]> {
    return this.approvals.find({
      where: { runId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Sweep pending rows past expiresAt. Returns the count flipped.
   * Each flipped row emits 'approval.decided' with status='expired'
   * so the runtime can terminate the corresponding run.
   */
  async sweepExpired(now = new Date()): Promise<number> {
    const expired = await this.approvals.find({
      where: { status: 'pending', expiresAt: LessThan(now) },
    });
    for (const row of expired) {
      row.status = 'expired';
      row.decidedAt = now;
      row.decisionReason = 'approval expired';
      await this.approvals.save(row);
      this.emit('approval.decided', row);
    }
    return expired.length;
  }
}
