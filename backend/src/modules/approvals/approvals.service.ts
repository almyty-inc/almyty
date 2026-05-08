import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { EventEmitter } from 'events';

import { ApprovalRequest, ApprovalStatus } from '../../entities/approval-request.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';

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
  ) {
    super();
  }

  /**
   * Create an approval gate. Idempotent on (runId, toolCallId): a
   * second call with the same pair returns the existing row rather
   * than creating a duplicate.
   */
  async create(input: CreateApprovalInput): Promise<ApprovalRequest> {
    if (input.toolCallId) {
      const existing = await this.approvals.findOne({
        where: { runId: input.runId, toolCallId: input.toolCallId },
      });
      if (existing) return existing;
    }

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
      payload: input.payload ?? null,
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

    row.status = next;
    row.decidedBy = decision.decidedBy;
    row.decidedAt = new Date();
    row.decisionReason = decision.decisionReason ?? null;
    const saved = await this.approvals.save(row);

    this.emit('approval.decided', saved);
    return saved;
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
