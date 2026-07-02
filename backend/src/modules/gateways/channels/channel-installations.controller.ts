import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { GatewaysService } from '../gateways.service';
import { ChannelInstallationService } from './channel-installation.service';

/**
 * Authenticated dashboard surface for multi-workspace channel
 * installations. Listing shows tenant + metadata only (credentials
 * never leave the server); revoking flips status and clears the
 * stored token.
 */
@Controller('gateways')
@ApiTags('Channel installations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ChannelInstallationsController {
  constructor(
    private readonly gatewaysService: GatewaysService,
    private readonly installationService: ChannelInstallationService,
  ) {}

  @Get(':id/installations')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List workspace installations for this channel gateway' })
  async listInstallations(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const orgId = req.user.currentOrganizationId;
    const gateway = await this.gatewaysService.getGateway(id, orgId, false);
    if (!gateway) throw new NotFoundException('Gateway not found');
    const installations = await this.installationService.listForGateway(gateway.id);
    return { success: true, data: installations };
  }

  @Post(':id/installations/:installationId/revoke')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Revoke a workspace installation (clears its stored token)' })
  async revokeInstallation(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('installationId', ParseUUIDPipe) installationId: string,
  ) {
    const orgId = req.user.currentOrganizationId;
    const gateway = await this.gatewaysService.getGateway(id, orgId, false);
    if (!gateway) throw new NotFoundException('Gateway not found');
    const installation = await this.installationService.revoke(gateway.id, installationId);
    return { success: true, data: installation };
  }
}
