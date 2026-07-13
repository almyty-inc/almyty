import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { NotificationsService } from '../../../src/modules/notifications/notifications.service';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';

import { User } from '../../../src/entities/user.entity';
import {
  UserOrganization,
  OrganizationRole,
} from '../../../src/entities/user-organization.entity';
import { Team } from '../../../src/entities/team.entity';
import { UserTeam, TeamRole } from '../../../src/entities/user-team.entity';
import { SsoConfigService } from './sso-config.service';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

export interface ScimName {
  givenName?: string;
  familyName?: string;
}
export interface ScimUserInput {
  schemas?: string[];
  userName?: string;
  name?: ScimName;
  emails?: { value: string; primary?: boolean }[];
  active?: boolean;
  displayName?: string;
}
export interface ScimPatchOp {
  schemas?: string[];
  Operations?: {
    op: string;
    path?: string;
    value?: any;
  }[];
}
export interface ScimGroupInput {
  schemas?: string[];
  displayName?: string;
  members?: { value: string }[];
}

/**
 * SCIM 2.0 provisioning. Users map to `User` + a per-org `UserOrganization`
 * membership; Groups map to `Team` + `UserTeam`. Deactivation
 * (PATCH active:false / DELETE) deactivates the org membership rather than the
 * global user account, so a user provisioned by two IdPs isn't locked out of
 * one org by the other.
 */
@Injectable()
export class ScimService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserOrganization)
    private readonly membershipRepo: Repository<UserOrganization>,
    @InjectRepository(Team)
    private readonly teamRepo: Repository<Team>,
    @InjectRepository(UserTeam)
    private readonly userTeamRepo: Repository<UserTeam>,
    private readonly configService: SsoConfigService,
    // Core notification pipeline (@Global). EE -> core is the allowed
    // dependency direction; @Optional() keeps existing tests working.
    @Optional()
    private readonly notifications?: NotificationsService,
  ) {}

  // ── Users ─────────────────────────────────────────────────────────

  private extractEmail(input: ScimUserInput): string {
    const primary = input.emails?.find((e) => e.primary) ?? input.emails?.[0];
    const email = (primary?.value || input.userName || '').toLowerCase();
    if (!email) {
      throw new BadRequestException('SCIM user requires userName or emails');
    }
    return email;
  }

  async createUser(orgId: string, input: ScimUserInput) {
    const email = this.extractEmail(input);
    const defaultRole = await this.defaultRole(orgId);

    let user = await this.userRepo.findOne({ where: { email } });
    if (!user) {
      const passwordHash = await bcrypt.hash(randomBytes(24).toString('hex'), 12);
      user = await this.userRepo.save(
        this.userRepo.create({
          email,
          passwordHash,
          firstName: input.name?.givenName || email.split('@')[0],
          lastName: input.name?.familyName || '',
          isVerified: true,
          isActive: input.active ?? true,
        }),
      );
    }

    const existing = await this.membershipRepo.findOne({
      where: { userId: user.id, organizationId: orgId },
    });
    if (existing) {
      // Idempotent re-provision: reactivate rather than 409 on churn.
      if (!existing.isActive) {
        existing.isActive = true;
        await this.membershipRepo.save(existing);
      }
      if (input.active === false) {
        existing.isActive = false;
        await this.membershipRepo.save(existing);
      }
      return this.toScimUser(user, existing);
    }

    const membership = await this.membershipRepo.save(
      this.membershipRepo.create({
        userId: user.id,
        organizationId: orgId,
        role: defaultRole,
        isActive: input.active ?? true,
        inviteAccepted: true,
      }),
    );
    return this.toScimUser(user, membership);
  }

  async getUser(orgId: string, userId: string) {
    const { user, membership } = await this.loadMember(orgId, userId);
    return this.toScimUser(user, membership);
  }

  async listUsers(orgId: string, filter?: string) {
    let emailFilter: string | undefined;
    if (filter) {
      // Minimal SCIM filter support: `userName eq "value"`.
      const match = /userName\s+eq\s+"([^"]+)"/i.exec(filter);
      if (match) emailFilter = match[1].toLowerCase();
    }

    const memberships = await this.membershipRepo.find({
      where: { organizationId: orgId },
      relations: ['user'],
    });
    const resources = memberships
      .filter((m) => m.user)
      .filter((m) => !emailFilter || m.user.email.toLowerCase() === emailFilter)
      .map((m) => this.toScimUser(m.user, m));

    return {
      schemas: [LIST_SCHEMA],
      totalResults: resources.length,
      startIndex: 1,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  }

  /** PUT — full replace. */
  async replaceUser(orgId: string, userId: string, input: ScimUserInput) {
    const { user, membership } = await this.loadMember(orgId, userId);
    const wasActive = membership.isActive;
    if (input.name?.givenName !== undefined) user.firstName = input.name.givenName;
    if (input.name?.familyName !== undefined) user.lastName = input.name.familyName;
    await this.userRepo.save(user);
    if (input.active !== undefined) {
      membership.isActive = input.active;
      await this.membershipRepo.save(membership);
    }
    if (wasActive && !membership.isActive) this.notifyDeprovision(orgId, user);
    return this.toScimUser(user, membership);
  }

  /** PATCH — the common Okta/Entra deactivation is `replace active:false`. */
  async patchUser(orgId: string, userId: string, patch: ScimPatchOp) {
    const { user, membership } = await this.loadMember(orgId, userId);
    const wasActive = membership.isActive;
    for (const op of patch.Operations ?? []) {
      const operation = op.op?.toLowerCase();
      if (operation !== 'replace' && operation !== 'add') continue;

      // Either `{ path: 'active', value: false }` or `{ value: { active: false } }`.
      if (op.path === 'active') {
        membership.isActive = coerceBool(op.value);
      } else if (op.value && typeof op.value === 'object') {
        if ('active' in op.value) membership.isActive = coerceBool(op.value.active);
        if (op.value.name?.givenName !== undefined)
          user.firstName = op.value.name.givenName;
        if (op.value.name?.familyName !== undefined)
          user.lastName = op.value.name.familyName;
      }
    }
    await this.userRepo.save(user);
    await this.membershipRepo.save(membership);
    if (wasActive && !membership.isActive) this.notifyDeprovision(orgId, user);
    return this.toScimUser(user, membership);
  }

  /** DELETE — deprovision from the org (deactivate membership). */
  async deleteUser(orgId: string, userId: string) {
    const { user, membership } = await this.loadMember(orgId, userId);
    const wasActive = membership.isActive;
    membership.isActive = false;
    await this.membershipRepo.save(membership);
    if (wasActive) this.notifyDeprovision(orgId, user);
  }

  /**
   * security.scim_deprovision — tell org admins their IdP deactivated a
   * member. Best-effort and fire-and-forget: a notification failure
   * must never fail the SCIM call the IdP is waiting on.
   */
  private notifyDeprovision(orgId: string, user: User): void {
    if (!this.notifications) return;
    this.notifications
      .emit({
        type: 'security.scim_deprovision',
        organizationId: orgId,
        roleTarget: { orgRoles: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
        title: 'Member deprovisioned via SCIM',
        body: `Your identity provider deactivated ${user.email} in your organization.`,
        link: '/settings',
        email: {
          template: 'security.scim_deprovision',
          params: { memberEmail: user.email },
        },
      })
      .catch(() => {});
  }

  private async loadMember(orgId: string, userId: string) {
    const membership = await this.membershipRepo.findOne({
      where: { userId, organizationId: orgId },
    });
    if (!membership) throw new NotFoundException('User not found');
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return { user, membership };
  }

  private async defaultRole(orgId: string): Promise<OrganizationRole> {
    const config = await this.configService.get(orgId);
    return (config?.defaultRole as OrganizationRole) || OrganizationRole.MEMBER;
  }

  private toScimUser(user: User, membership: UserOrganization) {
    return {
      schemas: [USER_SCHEMA],
      id: user.id,
      userName: user.email,
      name: { givenName: user.firstName, familyName: user.lastName },
      displayName: `${user.firstName} ${user.lastName}`.trim(),
      emails: [{ value: user.email, primary: true }],
      active: membership.isActive,
      meta: { resourceType: 'User' },
    };
  }

  // ── Groups (mapped to Teams) ──────────────────────────────────────

  async createGroup(orgId: string, input: ScimGroupInput) {
    if (!input.displayName) {
      throw new BadRequestException('SCIM group requires displayName');
    }
    const existing = await this.teamRepo.findOne({
      where: { organizationId: orgId, name: input.displayName },
    });
    if (existing) {
      throw new ConflictException('A group with this name already exists');
    }
    const team = await this.teamRepo.save(
      this.teamRepo.create({
        organizationId: orgId,
        name: input.displayName,
        description: 'Provisioned via SCIM',
      }),
    );
    await this.syncGroupMembers(team.id, input.members ?? []);
    return this.toScimGroup(team, input.members?.map((m) => m.value) ?? []);
  }

  async getGroup(orgId: string, groupId: string) {
    const team = await this.loadTeam(orgId, groupId);
    const members = await this.userTeamRepo.find({
      where: { teamId: team.id, isActive: true },
    });
    return this.toScimGroup(team, members.map((m) => m.userId));
  }

  async listGroups(orgId: string) {
    const teams = await this.teamRepo.find({ where: { organizationId: orgId } });
    const resources = await Promise.all(
      teams.map(async (t) => {
        const members = await this.userTeamRepo.find({
          where: { teamId: t.id, isActive: true },
        });
        return this.toScimGroup(t, members.map((m) => m.userId));
      }),
    );
    return {
      schemas: [LIST_SCHEMA],
      totalResults: resources.length,
      startIndex: 1,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  }

  async patchGroup(orgId: string, groupId: string, patch: ScimPatchOp) {
    const team = await this.loadTeam(orgId, groupId);
    for (const op of patch.Operations ?? []) {
      const operation = op.op?.toLowerCase();
      if (op.path === 'members') {
        const values: string[] = Array.isArray(op.value)
          ? op.value.map((v: any) => v.value)
          : [];
        if (operation === 'add') {
          await this.syncGroupMembers(team.id, values.map((value) => ({ value })));
        } else if (operation === 'remove') {
          await this.removeGroupMembers(team.id, values);
        }
      } else if (operation === 'replace' && op.value?.displayName) {
        team.name = op.value.displayName;
        await this.teamRepo.save(team);
      }
    }
    return this.getGroup(orgId, groupId);
  }

  async deleteGroup(orgId: string, groupId: string) {
    const team = await this.loadTeam(orgId, groupId);
    if (team.isDefault) {
      throw new BadRequestException('The default team cannot be deleted');
    }
    await this.teamRepo.remove(team);
  }

  private async loadTeam(orgId: string, groupId: string): Promise<Team> {
    const team = await this.teamRepo.findOne({
      where: { id: groupId, organizationId: orgId },
    });
    if (!team) throw new NotFoundException('Group not found');
    return team;
  }

  private async syncGroupMembers(
    teamId: string,
    members: { value: string }[],
  ): Promise<void> {
    for (const m of members) {
      const existing = await this.userTeamRepo.findOne({
        where: { teamId, userId: m.value },
      });
      if (existing) {
        if (!existing.isActive) {
          existing.isActive = true;
          await this.userTeamRepo.save(existing);
        }
      } else {
        await this.userTeamRepo.save(
          this.userTeamRepo.create({
            teamId,
            userId: m.value,
            role: TeamRole.MEMBER,
            isActive: true,
          }),
        );
      }
    }
  }

  private async removeGroupMembers(
    teamId: string,
    userIds: string[],
  ): Promise<void> {
    for (const userId of userIds) {
      const existing = await this.userTeamRepo.findOne({
        where: { teamId, userId },
      });
      if (existing) {
        existing.isActive = false;
        await this.userTeamRepo.save(existing);
      }
    }
  }

  private toScimGroup(team: Team, memberIds: string[]) {
    return {
      schemas: [GROUP_SCHEMA],
      id: team.id,
      displayName: team.name,
      members: memberIds.map((value) => ({ value })),
      meta: { resourceType: 'Group' },
    };
  }
}

function coerceBool(value: any): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return !!value;
}

export { PATCH_SCHEMA };
