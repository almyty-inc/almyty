import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException, ServiceUnavailableException, Optional, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { EventEmitter } from 'events';

import { ApprovalRequest, ApprovalStatus } from '../../entities/approval-request.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { ApprovalPolicyApprovalRecord } from '../../entities/approval-policy-approval.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { isUniqueViolation } from '../../common/utils/unique-violation';
import { OrganizationRole } from '../../entities/user-organization.entity';
import { NotificationsService } from '../notifications/notifications.service';
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
 * and treats them as rejections, on an interval started here.
 *
 * The sweep existed as a method with no caller at all, which made
 * `expiresAt` decorative: nobody approves, nothing flips the row,
 * 'approval.decided' never fires, and the run waits in WAITING_APPROVAL
 * forever -- the stuck-run reaper only looks at RUNNING, so nothing else
 * caught it either. An interval here rather than a BullMQ job because
 * that is the shape the sibling sweeps already use
 * (AgentRunReaperService, the workspace TTL sweep).
 */
/** How often pending approvals are checked against their expiresAt. */
const EXPIRY_SWEEP_INTERVAL_MS = 60_000;

@Injectable()
export class ApprovalsService extends EventEmitter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApprovalsService.name);
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(ApprovalRequest)
    private readonly approvals: Repository<ApprovalRequest>,
    @InjectRepository(AgentRun)
    private readonly runs: Repository<AgentRun>,
    // One row per collected approval, unique on (requestId, approverId) —
    // the authoritative record of who has approved a policy-governed
    // request, in place of an accumulator in the request's payload that
    // two concurrent reviewers wrote over each other.
    @InjectRepository(ApprovalPolicyApprovalRecord)
    private readonly policyApprovals: Repository<ApprovalPolicyApprovalRecord>,
    private readonly accessPolicy: AccessPolicyService,
    // EE hook (approval_policy): multi-step / quorum policies. Absent in
    // the community build — @Optional() resolves to undefined and the
    // single-gate flow below is untouched.
    @Optional()
    @Inject(APPROVAL_POLICY_HOOK)
    private readonly approvalPolicyHook?: ApprovalPolicyHook,
    // Notification pipeline (NotificationsModule is @Global). @Optional()
    // so community/unit-test instantiations without the module keep
    // working — emission is skipped when absent. This deliberately adds
    // no module import edge (the cycle-safe pattern used for EE hooks).
    @Optional()
    private readonly notifications?: NotificationsService,
  ) {
    super();
  }

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => {
      this.sweepExpired().catch((err) => {
        this.logger.warn(`Approval expiry sweep failed: ${err.message}`);
      });
    }, EXPIRY_SWEEP_INTERVAL_MS);
    // Don't hold the event loop open for it, matching the other sweeps.
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
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
    // `approval_requests_run_toolcall_uq` is the guard that makes this
    // idempotent: a stalled `next-step` job redelivered alongside the
    // original used to produce two gates for one tool call and two
    // approval notifications. Losing the insert race is an answer, not a
    // failure — the winner already paused the run, emitted and notified
    // — so return their row rather than surfacing a 500 on a request the
    // caller is entitled to make.
    let saved: ApprovalRequest;
    try {
      saved = await this.approvals.save(row);
    } catch (err: any) {
      if (!isUniqueViolation(err) || !input.toolCallId) throw err;
      const raced = await this.approvals.findOne({
        where: { runId: input.runId, toolCallId: input.toolCallId },
      });
      if (!raced) throw err;
      return raced;
    }

    // Pause the run.
    await this.runs.update({ id: input.runId }, { status: AgentRunStatus.WAITING_APPROVAL });

    this.emit('approval.requested', saved);
    this.notifyPending(saved).catch(() => {});
    return saved;
  }

  async approve(
    id: string,
    decision: ApprovalDecision,
    caller: { id: string },
    organizationId: string,
  ): Promise<ApprovalRequest> {
    return this.decide(id, 'approved', decision, caller, organizationId);
  }

  async reject(
    id: string,
    decision: ApprovalDecision,
    caller: { id: string },
    organizationId: string,
  ): Promise<ApprovalRequest> {
    return this.decide(id, 'rejected', decision, caller, organizationId);
  }

  private async decide(
    id: string,
    next: ApprovalStatus,
    decision: ApprovalDecision,
    caller: { id: string },
    organizationId: string,
  ): Promise<ApprovalRequest> {
    // Scoped, like findOne() below. The controller resolved the caller's
    // organization and then dropped it here, so the row was fetched by id
    // alone: AccessPolicyService refused the decision itself, but the
    // 'approval already <status>' branch ran BEFORE that check and
    // answered for another tenant's request -- an existence-and-outcome
    // oracle on any approval id in the install.
    const row = await this.approvals.findOne({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('approval request not found');

    const can = await this.accessPolicy.canAccess(caller, row, 'manage');
    if (!can.allowed) throw new ForbiddenException(can.reason);

    if (row.status !== 'pending') {
      throw new BadRequestException(`approval already ${row.status}`);
    }

    // EE (approval_policy): a policy-governed request only flips to
    // approved once its steps/quorum are satisfied. A rejection is always
    // immediate (a single rejection kills the request, as in OSS).
    if (next === 'approved') {
      const stillPending = await this.applyPolicyProgress(row, caller);
      if (stillPending) return stillPending;
    }

    // The flip IS the guard.
    //
    // The pending check above happens several awaits before this write
    // (canAccess, and applyPolicyProgress which writes), and a
    // multi-reviewer queue is the designed use case -- so two reviewers
    // acting at once both read 'pending'. One approved, saved, and
    // emitted, which resumed the run and executed the gated tool call;
    // the other then wrote 'rejected' over it. The row ended up
    // rejected on a request whose action had already run, the initiator
    // got two contradictory notifications, and the human-in-the-loop
    // gate was defeated. Only the writer who actually moved the row off
    // 'pending' emits.
    const decidedAt = new Date();
    const claim = await this.approvals
      .createQueryBuilder()
      .update()
      .set({
        status: next,
        decidedBy: decision.decidedBy,
        decidedAt,
        decisionReason: decision.decisionReason ?? null,
      })
      .where('id = :id', { id: row.id })
      .andWhere('status = :pending', { pending: 'pending' })
      .execute();

    if (!claim.affected) {
      const current = await this.approvals.findOne({ where: { id: row.id } });
      throw new BadRequestException(`approval already ${current?.status ?? 'decided'}`);
    }

    row.status = next;
    row.decidedBy = decision.decidedBy;
    row.decidedAt = decidedAt;
    row.decisionReason = decision.decisionReason ?? null;
    const saved = row;

    this.emit('approval.decided', saved);
    this.notifyDecided(saved).catch(() => {});
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
   *
   * The collected approvals are rows in `approval_policy_approvals`, one
   * per approver, unique on (requestId, approverId) — not a list in the
   * request's payload. A list meant every reviewer read it, appended
   * itself and wrote the whole thing back, and two reviewers acting at
   * once (the designed use case for a quorum) each wrote over the
   * other: on a 3-of-N gate holding [A], B wrote [A,B] and C, loaded
   * before B committed, wrote [A,C]. B's approval was gone, so either
   * the quorum never completed and a properly approved request expired
   * denied, or the erased approver dropped out of the repeat-approver
   * guard and one human satisfied a 3-of-3 twice over. An INSERT per
   * approval cannot overwrite anyone, and the index — not a list
   * lookup — is what refuses a second approval from the same person.
   */
  private async applyPolicyProgress(
    row: ApprovalRequest,
    caller: { id: string },
  ): Promise<ApprovalRequest | null> {
    const state = (row.payload as Record<string, any> | null)?._policy;
    if (!this.approvalPolicyHook || !state?.policyId) return null;

    const roles = await this.resolveApproverRoles(caller.id, row);

    // The INSERT is the guard. A repeat approver is rejected by the
    // unique index, which holds no matter how many reviewers are in
    // flight, rather than by a read of a list that a concurrent write
    // can erase.
    try {
      await this.policyApprovals.insert({
        requestId: row.id,
        organizationId: row.organizationId,
        approverId: caller.id,
        roles,
      });
    } catch (err: any) {
      // A unique violation here is the index saying this person has
      // already approved.
      if (isUniqueViolation(err)) {
        throw new BadRequestException('caller has already approved this request');
      }
      throw err;
    }

    const collected = await this.collectPolicyApprovals(row);

    // A scorer that THREW is not a scorer that said "no policy".
    //
    // Both used to end here as `progress === null`, and null falls back
    // to the OSS single gate -- so one transient error turned a
    // configured 3-of-5 or multi-step gate into a single approver, and
    // the gated tool call ran. That is the one outcome a human-in-the-
    // loop control must never produce by accident. The request stays
    // pending instead, and the caller is told to try again.
    let progress: ApprovalPolicyProgress | null;
    try {
      progress = await this.approvalPolicyHook.scoreProgress(
        row.organizationId,
        state.policyId,
        collected,
      );
    } catch (err: any) {
      this.logger.error(`approval policy scoring failed: ${err?.message ?? err}`);
      throw new ServiceUnavailableException({
        success: false,
        code: 'APPROVAL_POLICY_UNAVAILABLE',
        message:
          'This request is governed by an approval policy that could not be evaluated just now. It is still pending -- try again.',
      });
    }

    // A genuine null -- unlicensed, or the policy was deleted -- is the
    // designed degradation to the OSS single gate.
    if (!progress) return null;

    row.payload = {
      ...(row.payload ?? {}),
      _policy: { ...state, approvals: collected, progress },
    };
    if (progress.satisfied) return null;

    // Only the payload column, and only the derived snapshot in it: the
    // authoritative approvals are the rows, so a concurrent reviewer
    // writing their own snapshot a moment later costs nothing and is
    // recomputed on the next decision. A save() of the whole entity
    // here would additionally write this reviewer's stale `status` and
    // `decidedBy` back over whatever the CAS'd flip below committed.
    await this.approvals.update({ id: row.id }, { payload: row.payload });
    this.emit('approval.progress', row);
    return row;
  }

  /**
   * Every approval collected for a request, oldest first.
   *
   * Reads the rows, and folds in anything a request still carries in
   * `payload._policy.approvals` so a row written that way is still
   * counted. Deduped by approverId with the row winning, because the
   * row is the one the unique index protects.
   */
  private async collectPolicyApprovals(
    row: ApprovalRequest,
  ): Promise<ApprovalPolicyApproval[]> {
    const rows = await this.policyApprovals.find({
      where: { requestId: row.id },
      order: { createdAt: 'ASC' },
    });
    const byApprover = new Map<string, ApprovalPolicyApproval>();
    const inPayload = (row.payload as Record<string, any> | null)?._policy?.approvals;
    if (Array.isArray(inPayload)) {
      for (const entry of inPayload) {
        if (entry?.approverId) {
          byApprover.set(entry.approverId, {
            approverId: entry.approverId,
            roles: Array.isArray(entry.roles) ? entry.roles : [],
          });
        }
      }
    }
    for (const record of rows) {
      byApprover.set(record.approverId, {
        approverId: record.approverId,
        roles: Array.isArray(record.roles) ? record.roles : [],
      });
    }
    return [...byApprover.values()];
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
    let flipped = 0;
    for (const row of expired) {
      // Same conditional flip as decide(): this sweep could otherwise
      // stamp 'expired' and emit over a request that was approved and
      // resumed a moment earlier.
      const claim = await this.approvals
        .createQueryBuilder()
        .update()
        .set({ status: 'expired', decidedAt: now, decisionReason: 'approval expired' })
        .where('id = :id', { id: row.id })
        .andWhere('status = :pending', { pending: 'pending' })
        .execute();
      if (!claim.affected) continue;

      row.status = 'expired';
      row.decidedAt = now;
      row.decisionReason = 'approval expired';
      flipped++;
      this.emit('approval.decided', row);
      this.notifyDecided(row).catch(() => {});
    }
    return flipped;
  }

  // ── Notifications (best-effort, fire-and-forget) ─────────────────

  /**
   * approval.pending — notify the users who can decide: org
   * owners/admins plus, for team-scoped requests, the team's LEAD(s)
   * (mirrors the RBAC rule documented on ApprovalRequest).
   */
  private async notifyPending(row: ApprovalRequest): Promise<void> {
    if (!this.notifications) return;
    const baseUrl = process.env.FRONTEND_URL || 'https://app.staging.almyty.com';
    await this.notifications.emit({
      type: 'approval.pending',
      organizationId: row.organizationId,
      roleTarget: {
        orgRoles: [OrganizationRole.OWNER, OrganizationRole.ADMIN],
        teamLeadOfTeamId: row.teamId,
      },
      title: 'Approval requested',
      body: row.reason,
      link: `/approvals/${row.id}`,
      email: {
        template: 'approval.pending',
        params: {
          reason: row.reason,
          approvalUrl: `${baseUrl}/approvals/${row.id}`,
        },
      },
    });
  }

  /**
   * approval.decided — notify the run's initiator (skipping them when
   * they decided their own request). Also fires for sweep expiry.
   */
  private async notifyDecided(row: ApprovalRequest): Promise<void> {
    if (!this.notifications) return;
    const run = await this.runs.findOne({ where: { id: row.runId } });
    const initiatorId = run?.userId;
    if (!initiatorId || initiatorId === row.decidedBy) return;
    const baseUrl = process.env.FRONTEND_URL || 'https://app.staging.almyty.com';
    const outcome = row.status === 'approved' ? 'approved' : row.status === 'expired' ? 'expired' : 'rejected';
    await this.notifications.emit({
      type: 'approval.decided',
      organizationId: row.organizationId,
      userIds: [initiatorId],
      title: `Approval ${outcome}`,
      body: row.decisionReason || row.reason,
      link: `/approvals/${row.id}`,
      email: {
        template: 'approval.decided',
        params: {
          status: row.status,
          decisionReason: row.decisionReason,
          runUrl: `${baseUrl}/approvals/${row.id}`,
        },
      },
    });
  }
}
