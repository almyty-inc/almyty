import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PrivateGatewayGuard } from './private-gateway.guard';
import { GatewaysService } from './gateways.service';
import { ChannelLinkService } from './channel-link.service';

/**
 * `GET /gateways/:gatewayId/channel`: the agent channel a gateway answers for.
 *
 * A gateway a channel stood up is configured on the agent's Channels tab,
 * so the gateway page shows "Managed on <agent>" and links there instead
 * of offering a second set of the same settings. `data` is null for a
 * gateway no channel owns.
 */
@Controller('gateways')
@ApiTags('Gateways')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PrivateGatewayGuard)
export class ChannelLinkController {
  constructor(
    private readonly gateways: GatewaysService,
    private readonly channelLink: ChannelLinkService,
  ) {}

  @Get(':gatewayId/channel')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'The agent channel this gateway answers for, if any' })
  async managedBy(@Param('gatewayId', ParseUUIDPipe) gatewayId: string, @Request() req: any) {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) throw new BadRequestException('No organization found');
    // Visible to this caller, or a 404 exactly like the gateway page's.
    await this.gateways.getGateway(gatewayId, organizationId, false, { id: req.user.id });
    return { success: true, data: await this.channelLink.managedBy(organizationId, gatewayId) };
  }
}
