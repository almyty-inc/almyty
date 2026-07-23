import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, Optional, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GatewaysService } from '../gateways/gateways.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { TeamMembershipHelper } from './team-membership.helper';
/**
 * Invitation flow extracted from OrganizationsService:
 * inviteUser, acceptInvite, getInviteDetails. The original service
 * keeps the rest of the org / member / team CRUD; this helper
 * focuses on the multi-step token + email choreography.
 */
@Injectable()
export class OrganizationsInvitesHelper {
  private readonly logger = new Logger(OrganizationsInvitesHelper.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly mailService: MailService,
    @Inject(forwardRef(() => GatewaysService))
    private readonly gatewaysService: GatewaysService,
    private readonly teamMembershipHelper: TeamMembershipHelper,
    // @Global notifications pipeline; @Optional() keeps existing unit
    // tests (constructed without it) working.
    @Optional()
    private readonly notifications?: NotificationsService,
  ) {}

  async inviteUser(organizationId: string, inviteUserDto: InviteUserDto, invitedBy: string): Promise<{ inviteSent: boolean }> {
    const org = await this.organizationRepository.findOne({ where: { id: organizationId } });
    if (!org) throw new NotFoundException('Organization not found');

    const inviter = await this.userRepository.findOne({ where: { id: invitedBy } });
    const inviterName = inviter ? `${inviter.firstName} ${inviter.lastName}`.trim() : 'A team member';

    const inviteToken = crypto.randomBytes(32).toString('base64url');
    const inviteExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Check if user already exists
    const user = await this.userRepository.findOne({
      where: { email: inviteUserDto.email },
    });

    if (user) {
      // Check if already a member
      const existingMembership = await this.userOrganizationRepository.findOne({
        where: { userId: user.id, organizationId },
      });

      if (existingMembership) {
        if (existingMembership.isActive && existingMembership.inviteAccepted) {
          throw new ConflictException('User is already a member of this organization');
        }
        // Update existing pending membership
        existingMembership.role = inviteUserDto.role;
        existingMembership.invitedBy = invitedBy;
        existingMembership.inviteToken = inviteToken;
        existingMembership.inviteExpiresAt = inviteExpiresAt;
        existingMembership.inviteAccepted = false;
        existingMembership.isActive = true;
        await this.userOrganizationRepository.save(existingMembership);
      } else {
        // Create membership for existing user (pending acceptance)
        const membership = this.userOrganizationRepository.create({
          userId: user.id,
          organizationId,
          role: inviteUserDto.role,
          invitedBy,
          inviteToken,
          inviteExpiresAt,
          inviteAccepted: false,
          isActive: true,
        });
        await this.userOrganizationRepository.save(membership);
      }

      // Send invite email to existing user
      const emailSent = await this.mailService.sendInvitation({
        to: inviteUserDto.email,
        organizationName: org.name,
        inviterName,
        role: inviteUserDto.role,
        inviteToken,
        isNewUser: false,
      });

      // In-app notification alongside the invitation email (existing
      // users only — a not-yet-registered invitee has no inbox to put
      // a row in). Email channel intentionally omitted: sendInvitation
      // above already delivered it.
      if (this.notifications) {
        this.notifications
          .emit({
            type: 'invite.received',
            organizationId,
            userIds: [user.id],
            title: `You're invited to ${org.name}`,
            body: `${inviterName} invited you to join ${org.name} as ${inviteUserDto.role}.`,
            link: `/invite/accept?token=${encodeURIComponent(inviteToken)}`,
          })
          .catch(() => {});
      }

      return { inviteSent: emailSent };
    }

    // User doesn't exist — store pending invite in organization metadata
    // When the user registers via the invite link, the accept endpoint creates the real membership
    // We store invite info in the organization's metadata so we can look it up by token
    const pendingInvites = (org.settings as any)?.pendingInvites || [];
    pendingInvites.push({
      email: inviteUserDto.email,
      role: inviteUserDto.role,
      inviteToken,
      inviteExpiresAt: inviteExpiresAt.toISOString(),
      invitedBy,
    });
    await this.organizationRepository.update(organizationId, {
      settings: { ...(org.settings as any || {}), pendingInvites },
    });

    // Send invite email to new user
    const emailSent = await this.mailService.sendInvitation({
      to: inviteUserDto.email,
      organizationName: org.name,
      inviterName,
      role: inviteUserDto.role,
      inviteToken,
      isNewUser: true,
    });

    this.logger.log(`Invitation sent to new user: ${inviteUserDto.email} (token: ${inviteToken.substring(0, 8)}...)`);
    return { inviteSent: emailSent };
  }

  async acceptInvite(token: string, userId: string): Promise<{ organizationId: string; organizationName: string }> {
    // Defense-in-depth: reject empty/null tokens before hitting the DB.
    // Without this, a null token would `WHERE inviteToken IS NULL` and
    // potentially match any stale never-invited membership — same class
    // of bug as the confirmPasswordReset empty-token issue we fixed in
    // auth.service.ts.
    if (!token || typeof token !== 'string') {
      throw new NotFoundException('Invalid or expired invitation');
    }

    // Resolve the caller. We need their email so we can verify that
    // the pending-invite path creates a membership for the right person.
    const caller = await this.userRepository.findOne({ where: { id: userId } });
    if (!caller) {
      throw new NotFoundException('User not found');
    }

    // Check membership-based invites (existing users)
    const membership = await this.userOrganizationRepository.findOne({
      where: { inviteToken: token },
      relations: { organization: true },
    });

    if (membership) {
      if (membership.inviteExpiresAt && membership.inviteExpiresAt < new Date()) {
        throw new BadRequestException('Invitation has expired');
      }
      if (membership.inviteAccepted) {
        throw new ConflictException('Invitation has already been accepted');
      }
      // The membership row was created by inviteUser() with the invited
      // user's id already filled in. If the CALLER isn't that user, they
      // must not be allowed to accept on someone else's behalf.
      if (membership.userId !== userId) {
        throw new NotFoundException('Invalid or expired invitation');
      }

      membership.inviteAccepted = true;
      membership.inviteToken = null;
      await this.userOrganizationRepository.save(membership);
      await this.teamMembershipHelper.joinDefaultTeam(membership.organizationId, userId, membership.role);

      return {
        organizationId: membership.organizationId,
        organizationName: membership.organization?.name || 'Organization',
      };
    }

    // Check pending invites in org metadata (new users).
    //
    // Previously this iterated every organization row in memory
    // (O(orgs) per accept + an unbounded `find()` load that is a
    // DoS vector on a large instance). Now we narrow to the single
    // matching row via a JSONB containment query — the JSON path
    // operator `@>` lets Postgres match elements of
    // `settings.pendingInvites` that contain `{inviteToken: <t>}`
    // in a single round trip, bounded work regardless of org count.
    const candidateOrgs = await this.organizationRepository
      .createQueryBuilder('org')
      .where(`org.settings->'pendingInvites' @> :needle`, {
        needle: JSON.stringify([{ inviteToken: token }]),
      })
      .getMany();
    for (const org of candidateOrgs) {
      const pendingInvites = (org.settings as any)?.pendingInvites || [];
      const invite = pendingInvites.find((i: any) => i.inviteToken === token);
      if (invite) {
        if (new Date(invite.inviteExpiresAt) < new Date()) {
          throw new BadRequestException('Invitation has expired');
        }

        // CRITICAL: verify the caller's email matches the invite's email.
        // Without this, anyone with the token (intercepted email, leaked
        // link) could accept the invite as THEMSELVES and silently gain
        // membership in someone else's organization.
        const callerEmail = (caller.email || '').toLowerCase();
        const inviteEmail = (invite.email || '').toLowerCase();
        if (!callerEmail || !inviteEmail || callerEmail !== inviteEmail) {
          throw new NotFoundException('Invalid or expired invitation');
        }

        // Create the real membership
        const newMembership = this.userOrganizationRepository.create({
          userId,
          organizationId: org.id,
          role: invite.role,
          invitedBy: invite.invitedBy,
          inviteAccepted: true,
          isActive: true,
        });
        await this.userOrganizationRepository.save(newMembership);
        await this.teamMembershipHelper.joinDefaultTeam(org.id, userId, invite.role);

        // Remove from pending
        const updated = pendingInvites.filter((i: any) => i.inviteToken !== token);
        await this.organizationRepository.update(org.id, {
          settings: { ...(org.settings as any || {}), pendingInvites: updated },
        });

        return { organizationId: org.id, organizationName: org.name };
      }
    }

    throw new NotFoundException('Invalid or expired invitation');
  }

  /**
   * Public endpoint — the invite link is reachable by anyone who
   * can guess or intercept the token, so we must NOT leak the
   * invited email address back to a caller who doesn't already
   * know it (the inviter clearly knows, and the invited recipient
   * sees it in the email client, so withholding it here costs
   * nothing legitimate). Returning the email would let a leaked
   * link enumerate "who was this sent to" across the platform,
   * which is a privacy regression.
   *
   * Also: the pending-invites lookup now uses a JSONB containment
   * query instead of `organizationRepository.find()` + in-memory
   * scan. The old shape was O(orgs) per call and loaded every org
   * row into memory — a DoS vector on a large instance.
   */
  async getInviteDetails(token: string): Promise<{ organizationName: string; role: string; isExpired: boolean }> {
    // Defense-in-depth: reject empty/null tokens before the DB.
    if (!token || typeof token !== 'string') {
      throw new NotFoundException('Invalid invitation');
    }

    // Check membership-based invites (existing users)
    const membership = await this.userOrganizationRepository.findOne({
      where: { inviteToken: token },
      relations: { organization: true },
    });

    if (membership) {
      const isExpired = membership.inviteExpiresAt ? membership.inviteExpiresAt < new Date() : false;
      return {
        organizationName: membership.organization?.name || 'Organization',
        role: membership.role,
        isExpired,
      };
    }

    // Check pending invites in org metadata (new users) — narrow
    // to the single matching row via a JSONB containment query.
    const candidateOrgs = await this.organizationRepository
      .createQueryBuilder('org')
      .where(`org.settings->'pendingInvites' @> :needle`, {
        needle: JSON.stringify([{ inviteToken: token }]),
      })
      .getMany();
    for (const org of candidateOrgs) {
      const pendingInvites = (org.settings as any)?.pendingInvites || [];
      const invite = pendingInvites.find((i: any) => i.inviteToken === token);
      if (invite) {
        return {
          organizationName: org.name,
          role: invite.role,
          isExpired: new Date(invite.inviteExpiresAt) < new Date(),
        };
      }
    }

    throw new NotFoundException('Invalid invitation');
  }

  /**
   * List all pending invites for an organization. Aggregates both
   * sources — UserOrganization rows where the recipient is already a
   * registered user, and the org.settings.pendingInvites array where
   * the recipient hasn't signed up yet.
   *
   * Tokens are NOT returned; only enough info to display and revoke
   * (the token would let anyone with read-access accept the invite on
   * the recipient's behalf, defeating the email-binding check in
   * acceptInvite). Revocation uses a server-side ID instead.
   */
  async listPendingInvites(organizationId: string): Promise<Array<{
    id: string;
    email: string;
    role: string;
    invitedBy: string;
    inviteExpiresAt: string;
    source: 'membership' | 'settings';
    isExpired: boolean;
  }>> {
    const now = new Date();

    // 1. Membership-based invites (existing users, not yet accepted).
    const pendingMemberships = await this.userOrganizationRepository
      .createQueryBuilder('uo')
      .leftJoinAndSelect('uo.user', 'user')
      .where('uo.organizationId = :organizationId', { organizationId })
      .andWhere('uo.inviteAccepted = :accepted', { accepted: false })
      .andWhere('uo.inviteToken IS NOT NULL')
      .getMany();

    const membershipInvites = pendingMemberships.map((m) => ({
      id: 'mem:' + m.id,
      email: m.user?.email || '',
      role: m.role,
      invitedBy: m.invitedBy || '',
      inviteExpiresAt: m.inviteExpiresAt ? m.inviteExpiresAt.toISOString() : '',
      source: 'membership' as const,
      isExpired: m.inviteExpiresAt ? m.inviteExpiresAt < now : false,
    }));

    // 2. Settings-based invites (new users not yet registered).
    const org = await this.organizationRepository.findOne({ where: { id: organizationId } });
    const settingsInvites: any[] = (org?.settings as any)?.pendingInvites || [];
    const settingsInviteRows = settingsInvites.map((i) => ({
      // Short hash of the token so the UI has a stable revoke handle
      // without exposing the token itself. The same hashing is repeated
      // in revokePendingInvite below.
      id: 'set:' + crypto.createHash('sha256').update(i.inviteToken).digest('hex').slice(0, 16),
      email: i.email,
      role: i.role,
      invitedBy: i.invitedBy || '',
      inviteExpiresAt: i.inviteExpiresAt,
      source: 'settings' as const,
      isExpired: new Date(i.inviteExpiresAt) < now,
    }));

    return [...membershipInvites, ...settingsInviteRows].sort((a, b) =>
      a.email.localeCompare(b.email),
    );
  }

  /**
   * Revoke a pending invite. The id is the opaque handle returned by
   * listPendingInvites (`mem:<uuid>` or `set:<hash>`).
   *
   * Revoking a membership invite clears the token and marks the row
   * inactive; the recipient would just see "invitation expired" on
   * their next attempt. Revoking a settings invite removes it from
   * the org.settings.pendingInvites array.
   */
  async revokePendingInvite(organizationId: string, inviteId: string): Promise<{ revoked: boolean }> {
    if (!inviteId || (!inviteId.startsWith('mem:') && !inviteId.startsWith('set:'))) {
      throw new BadRequestException('Invalid invite id');
    }

    if (inviteId.startsWith('mem:')) {
      const membershipId = inviteId.slice(4);
      const membership = await this.userOrganizationRepository.findOne({
        where: { id: membershipId, organizationId, inviteAccepted: false },
      });
      if (!membership) {
        throw new NotFoundException('Invite not found');
      }
      membership.inviteToken = null;
      membership.inviteExpiresAt = null;
      membership.isActive = false;
      await this.userOrganizationRepository.save(membership);
      this.logger.log(`Revoked membership invite ${membershipId} in org ${organizationId}`);
      return { revoked: true };
    }

    // settings-based revoke: match by sha256(token).slice(0,16)
    const targetHash = inviteId.slice(4);
    const org = await this.organizationRepository.findOne({ where: { id: organizationId } });
    if (!org) {
      throw new NotFoundException('Organization not found');
    }
    const pendingInvites: any[] = (org.settings as any)?.pendingInvites || [];
    const matchIdx = pendingInvites.findIndex(
      (i) => crypto.createHash('sha256').update(i.inviteToken).digest('hex').slice(0, 16) === targetHash,
    );
    if (matchIdx === -1) {
      throw new NotFoundException('Invite not found');
    }
    const updated = pendingInvites.filter((_, idx) => idx !== matchIdx);
    await this.organizationRepository.update(organizationId, {
      settings: { ...(org.settings as any || {}), pendingInvites: updated },
    });
    this.logger.log(`Revoked settings invite ${targetHash} in org ${organizationId}`);
    return { revoked: true };
  }

}
