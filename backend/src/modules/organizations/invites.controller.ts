import {
  Controller,
  Get,
  Post,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
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
    const data = await this.organizationsService.acceptInvite(token, req.user.id);
    return { success: true, data, message: 'Invitation accepted' };
  }
}
