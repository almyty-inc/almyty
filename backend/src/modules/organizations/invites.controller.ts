import {
  Controller,
  ForbiddenException,
  Get,
  Post,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ssoSessionOrganization } from '../auth/sso-session';
import { OrganizationsService } from './organizations.service';

/**
 * Joining an organization is the account's decision. A session minted
 * from another organization's SSO assertion speaks for that
 * organization's IdP, which could otherwise open the person's
 * notifications and accept an invite for them.
 */
function refuseSsoSession(user: any): void {
  if (ssoSessionOrganization(user)) {
    throw new ForbiddenException({
      code: 'SSO_SESSION_CANNOT_ACCEPT_INVITE',
      message: 'Sign in with your password to accept an invitation.',
    });
  }
}

@Controller('invites')
@ApiTags('Invitations')
export class InvitesController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  // Declared before `:token`: the in-app notification names the
  // membership row, and only its invitee may open it.
  @Get('membership/:membershipId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get details of an invitation made out to the signed-in account' })
  async getMembershipInvite(@Param('membershipId') membershipId: string, @Request() req: any) {
    const data = await this.organizationsService.getInviteDetailsForMembership(membershipId, req.user.id);
    return { success: true, data, message: 'Invitation details retrieved' };
  }

  @Post('membership/:membershipId/accept')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Accept an invitation made out to the signed-in account' })
  async acceptMembershipInvite(@Param('membershipId') membershipId: string, @Request() req: any) {
    refuseSsoSession(req.user);
    const data = await this.organizationsService.acceptInviteForMembership(membershipId, req.user.id);
    return { success: true, data, message: 'Invitation accepted' };
  }

  @Get(':token')
  @ApiOperation({ summary: 'Get invitation details (public)' })
  async getInviteDetails(@Param('token') token: string) {
    const data = await this.organizationsService.getInviteDetails(token);
    return { success: true, data, message: 'Invitation details retrieved' };
  }

  @Post(':token/accept')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Accept invitation (requires login)' })
  async acceptInvite(@Param('token') token: string, @Request() req: any) {
    refuseSsoSession(req.user);
    const data = await this.organizationsService.acceptInvite(token, req.user.id);
    return { success: true, data, message: 'Invitation accepted' };
  }
}