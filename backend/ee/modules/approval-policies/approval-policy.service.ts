import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  ApprovalPolicy,
  ApprovalStep,
  ApprovalMatchCondition,
} from '../../../src/entities/approval-policy.entity';
import {
  ApprovalContext,
  ApprovalPolicyEvaluator,
  CollectedApproval,
  PolicyProgress,
} from './approval-policy.evaluator';

export interface CreateApprovalPolicyInput {
  organizationId: string;
  name: string;
  description?: string;
  teamId?: string | null;
  match?: ApprovalMatchCondition[];
  steps?: ApprovalStep[];
  priority?: number;
  enabled?: boolean;
}

/**
 * EE (approval_policy): CRUD for multi-step / conditional / quorum
 * approval policies, plus the resolve + score helpers the approvals
 * runtime calls. The OSS single-gate approval stays in the approvals
 * module; this only fires when a request matches a configured policy.
 */
@Injectable()
export class ApprovalPolicyService {
  constructor(
    @InjectRepository(ApprovalPolicy)
    private readonly policies: Repository<ApprovalPolicy>,
    private readonly evaluator: ApprovalPolicyEvaluator,
  ) {}

  async create(input: CreateApprovalPolicyInput): Promise<ApprovalPolicy> {
    if (!input.name?.trim()) throw new BadRequestException('policy name is required');
    this.validateSteps(input.steps ?? []);
    const row = this.policies.create({
      organizationId: input.organizationId,
      name: input.name.trim(),
      description: input.description ?? null,
      teamId: input.teamId ?? null,
      match: input.match ?? [],
      steps: input.steps ?? [],
      priority: input.priority ?? 0,
      enabled: input.enabled ?? true,
    });
    return this.policies.save(row);
  }

  async list(organizationId: string): Promise<ApprovalPolicy[]> {
    return this.policies.find({
      where: { organizationId },
      order: { priority: 'DESC', createdAt: 'ASC' },
    });
  }

  async get(organizationId: string, id: string): Promise<ApprovalPolicy> {
    const row = await this.policies.findOne({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('approval policy not found');
    return row;
  }

  async update(
    organizationId: string,
    id: string,
    patch: Partial<CreateApprovalPolicyInput>,
  ): Promise<ApprovalPolicy> {
    const row = await this.get(organizationId, id);
    if (patch.steps !== undefined) {
      this.validateSteps(patch.steps);
      row.steps = patch.steps;
    }
    if (patch.name !== undefined) row.name = patch.name.trim();
    if (patch.description !== undefined) row.description = patch.description ?? null;
    if (patch.teamId !== undefined) row.teamId = patch.teamId ?? null;
    if (patch.match !== undefined) row.match = patch.match;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    return this.policies.save(row);
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const row = await this.get(organizationId, id);
    await this.policies.remove(row);
  }

  /**
   * Resolve which policy (if any) governs a request context. Returns null
   * when no policy matches — the caller then applies the OSS single-gate.
   */
  async resolveForContext(
    organizationId: string,
    ctx: ApprovalContext,
  ): Promise<ApprovalPolicy | null> {
    const policies = await this.policies.find({
      where: { organizationId, enabled: true },
    });
    return this.evaluator.resolvePolicy(policies, ctx);
  }

  /** Score collected approvals against a policy (delegates to evaluator). */
  scoreProgress(policy: ApprovalPolicy, approvals: CollectedApproval[]): PolicyProgress {
    return this.evaluator.progress(policy, approvals);
  }

  private validateSteps(steps: ApprovalStep[]): void {
    if (!Array.isArray(steps)) throw new BadRequestException('steps must be an array');
    for (const step of steps) {
      if (!step.name?.trim()) throw new BadRequestException('each step needs a name');
      if (!step.approverRole?.trim())
        throw new BadRequestException(`step "${step.name}" needs an approverRole`);
      if (!Number.isInteger(step.minApprovals) || step.minApprovals < 1) {
        throw new BadRequestException(`step "${step.name}" needs minApprovals >= 1`);
      }
    }
  }
}
