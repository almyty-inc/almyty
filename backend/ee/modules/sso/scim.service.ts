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
import { SsoConfigService, provisioningRole } from './sso-config.service';
import { isEffectiveMembership } from '../../../src/common/authorization/membership';

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
    if (user) {
      // An account with this address already exists somewhere on the
      // platform. `users` is platform-wide and `email` is its unique key,
      // so adopting the row here let one organization's SCIM token pull
      // another tenant's person into its own org -- and then rename them
      // through PUT/PATCH, which writes the shared row every other tenant
      // reads. An IdP may provision identities; it may not claim ones that
      // already exist outside its own membership.
      const existingMembership = await this.membershipRepo.findOne({
        where: { userId: user.id, organizationId: orgId },
      });
      if (!existingMembership) {
        throw new ConflictException(
          'An almyty account already exists for this address. Invite them to the organization instead; SCIM can only create new identities.',
        );
      }
    }
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
      relations: { user: true },
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
    if (await this.mayWriteProfile(orgId, userId)) {
      if (input.name?.givenName !== undefined) user.firstName = input.name.givenName;
      if (input.name?.familyName !== undefined) user.lastName = input.name.familyName;
      await this.userRepo.save(user);
    }
    if (input.active !== undefined) {
      membership.isActive = input.active;
      await this.membershipRepo.save(membership);
    }
    if (wasActive && !membership.isActive) this.notifyDeprovision(orgId, user);
    return this.toScimUser(user, membership);
  }

  /**
   * May this organization's IdP write the shared `users` row?
   *
   * Only when this is the person's only organization. `users` is
   * platform-wide: a name written here shows up in every other tenant the
   * person belongs to, so an IdP that is one of several does not get to
   * decide what they are called everywhere. Membership alone is not
   * enough -- that is the check `loadMember` already made.
   */
  private async mayWriteProfile(orgId: string, userId: string): Promise<boolean> {
    const elsewhere = await this.membershipRepo.count({
      where: { userId, isActive: true },
    });
    return elsewhere <= 1;
  }

  /** PATCH — the common Okta/Entra deactivation is `replace active:false`. */
  async patchUser(orgId: string, userId: string, patch: ScimPatchOp) {
    const { user, membership } = await this.loadMember(orgId, userId);
    const wasActive = membership.isActive;
    const mayWriteProfile = await this.mayWriteProfile(orgId, userId);
    let profileTouched = false;
    for (const op of patch.Operations ?? []) {
      const operation = op.op?.toLowerCase();
      if (operation !== 'replace' && operation !== 'add') continue;

      // Either `{ path: 'active', value: false }` or `{ value: { active: false } }`.
      if (op.path === 'active') {
        membership.isActive = coerceBool(op.value);
      } else if (op.value && typeof op.value === 'object') {
        if ('active' in op.value) membership.isActive = coerceBool(op.value.active);
        if (!mayWriteProfile) continue;
        if (op.value.name?.givenName !== undefined) {
          user.firstName = op.value.name.givenName;
          profileTouched = true;
        }
        if (op.value.name?.familyName !== undefined) {
          user.lastName = op.value.name.familyName;
          profileTouched = true;
        }
      }
    }
    if (profileTouched) await this.userRepo.save(user);
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
    // Never owner, whatever the stored row says (see PROVISIONABLE_ROLES).
    return provisioningRole(config?.defaultRole);
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
    const kept = await this.syncGroupMembers(orgId, team.id, input.members ?? []);
    return this.toScimGroup(team, kept);
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
          await this.syncGroupMembers(orgId, team.id, values.map((value) => ({ value })));
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

  /**
   * Put `members` on the team -- the ones who are members of this
   * organization. The ids come straight from the request; written as given
   * they let one tenant's SCIM token put any user on the platform on its
   * teams. Returns the ids that were kept.
   */
  private async syncGroupMembers(
    orgId: string,
    teamId: string,
    members: { value: string }[],
  ): Promise<string[]> {
    const kept: string[] = [];
    for (const m of members) {
      if (typeof m?.value !== 'string' || !m.value) continue;
      const membership = await this.membershipRepo.findOne({
        where: { userId: m.value, organizationId: orgId },
      });
      if (!isEffectiveMembership(membership)) continue;
      kept.push(m.value);
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
    return kept;
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
