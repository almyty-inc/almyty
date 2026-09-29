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

@Controller('invites')
@ApiTags('Invitations')
export class InvitesController {
  constructor(private readonly organizationsService: OrganizationsService) {}

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
    // Joining an organization is the account's decision. A session minted
    // from another organization's SSO assertion speaks for that
    // organization's IdP, which could otherwise read the invite link from
    // the person's notifications and accept it for them.
    if (ssoSessionOrganization(req.user)) {
      throw new ForbiddenException({
        code: 'SSO_SESSION_CANNOT_ACCEPT_INVITE',
        message: 'Sign in with your password to accept an invitation.',
      });
    }
    const data = await this.organizationsService.acceptInvite(token, req.user.id);
    return { success: true, data, message: 'Invitation accepted' };
  }
}
