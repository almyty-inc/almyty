import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { CustomRole } from '../../entities/custom-role.entity';
import { CustomRoleAssignment } from '../../entities/custom-role-assignment.entity';
import { AbacPolicy } from '../../entities/abac-policy.entity';
import {
  EvaluationContext,
  PolicyDecision,
  PolicyEvaluatorService,
} from './policy-evaluator.service';

export interface CreateCustomRoleInput {
  organizationId: string;
  name: string;
  description?: string;
  permissions?: string[];
}

export interface UpdateCustomRoleInput {
  name?: string;
  description?: string;
  permissions?: string[];
  active?: boolean;
}

/**
 * EE (advanced_rbac): CRUD for custom roles + their assignments, plus the
 * effective-permission resolver the rest of the app consults. Wraps the
 * stateless {@link PolicyEvaluatorService} with the org's persisted
 * roles/policies.
 */
@Injectable()
export class CustomRoleService {
  constructor(
    @InjectRepository(CustomRole)
    private readonly roles: Repository<CustomRole>,
    @InjectRepository(CustomRoleAssignment)
    private readonly assignments: Repository<CustomRoleAssignment>,
    @InjectRepository(AbacPolicy)
    private readonly policies: Repository<AbacPolicy>,
    private readonly evaluator: PolicyEvaluatorService,
  ) {}

  // ── Custom roles ──

  async createRole(input: CreateCustomRoleInput): Promise<CustomRole> {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('role name is required');
    const existing = await this.roles.findOne({
      where: { organizationId: input.organizationId, name },
    });
    if (existing) throw new ConflictException(`role "${name}" already exists`);
    const row = this.roles.create({
      organizationId: input.organizationId,
      name,
      description: input.description ?? null,
      permissions: this.normalizePermissions(input.permissions ?? []),
      active: true,
    });
    return this.roles.save(row);
  }

  async listRoles(organizationId: string): Promise<CustomRole[]> {
    return this.roles.find({
      where: { organizationId },
      order: { name: 'ASC' },
    });
  }

  async getRole(organizationId: string, id: string): Promise<CustomRole> {
    const row = await this.roles.findOne({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('custom role not found');
    return row;
  }

  async updateRole(
    organizationId: string,
    id: string,
    patch: UpdateCustomRoleInput,
  ): Promise<CustomRole> {
    const row = await this.getRole(organizationId, id);
    if (patch.name !== undefined) row.name = patch.name.trim();
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.permissions !== undefined)
      row.permissions = this.normalizePermissions(patch.permissions);
    if (patch.active !== undefined) row.active = patch.active;
    return this.roles.save(row);
  }

  async deleteRole(organizationId: string, id: string): Promise<void> {
    const row = await this.getRole(organizationId, id);
    await this.roles.remove(row);
  }

  // ── Assignments ──

  async assign(
    organizationId: string,
    roleId: string,
    userId: string,
    assignedBy?: string,
  ): Promise<CustomRoleAssignment> {
    await this.getRole(organizationId, roleId); // validates role in org
    const existing = await this.assignments.findOne({
      where: { customRoleId: roleId, userId },
    });
    if (existing) return existing;
    const row = this.assignments.create({
      organizationId,
      customRoleId: roleId,
      userId,
      assignedBy: assignedBy ?? null,
    });
    return this.assignments.save(row);
  }

  async unassign(organizationId: string, roleId: string, userId: string): Promise<void> {
    const row = await this.assignments.findOne({
      where: { organizationId, customRoleId: roleId, userId },
    });
    if (!row) throw new NotFoundException('assignment not found');
    await this.assignments.remove(row);
  }

  /**
   * Union of every permission granted to the user through their assigned
   * (active) custom roles within the org.
   */
  async getEffectivePermissions(organizationId: string, userId: string): Promise<string[]> {
    const rows = await this.assignments.find({ where: { organizationId, userId } });
    if (rows.length === 0) return [];
    const roleIds = rows.map((r) => r.customRoleId);
    const roles = await this.roles.find({ where: { id: In(roleIds) } });
    const set = new Set<string>();
    for (const role of roles) {
      if (!role.active) continue;
      for (const perm of role.permissions ?? []) set.add(perm);
    }
    return [...set].sort();
  }

  /** True if the user's effective custom-role grants cover `permission`. */
  async hasPermission(
    organizationId: string,
    userId: string,
    permission: string,
  ): Promise<boolean> {
    const perms = await this.getEffectivePermissions(organizationId, userId);
    return this.evaluator.permits(perms, permission);
  }

  // ── ABAC policies ──

  async createPolicy(policy: Partial<AbacPolicy> & { organizationId: string }): Promise<AbacPolicy> {
    if (!policy.name?.trim()) throw new BadRequestException('policy name is required');
    const row = this.policies.create({
      organizationId: policy.organizationId,
      name: policy.name.trim(),
      description: policy.description ?? null,
      effect: policy.effect ?? 'allow',
      action: policy.action ?? '*',
      conditions: policy.conditions ?? [],
      priority: policy.priority ?? 0,
      active: policy.active ?? true,
    });
    return this.policies.save(row);
  }

  async listPolicies(organizationId: string): Promise<AbacPolicy[]> {
    return this.policies.find({
      where: { organizationId },
      order: { priority: 'DESC', createdAt: 'ASC' },
    });
  }

  async deletePolicy(organizationId: string, id: string): Promise<void> {
    const row = await this.policies.findOne({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('policy not found');
    await this.policies.remove(row);
  }

  /**
   * Evaluate the org's ABAC policy set for an action + context. Loads the
   * active policies and delegates to the stateless evaluator.
   */
  async evaluateAccess(
    organizationId: string,
    action: string,
    ctx: EvaluationContext,
  ): Promise<PolicyDecision> {
    const policies = await this.policies.find({
      where: { organizationId, active: true },
    });
    return this.evaluator.evaluate(policies, action, ctx);
  }

  private normalizePermissions(perms: string[]): string[] {
    return [...new Set(perms.map((p) => p.trim()).filter(Boolean))].sort();
  }
}
