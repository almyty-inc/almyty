import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { MailService } from '../mail/mail.service';
import { GatewaysService } from '../gateways/gateways.service';
import { InviteUserDto } from './dto/invite-user.dto';
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
      relations: ['organization'],
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
      relations: ['organization'],
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

}
