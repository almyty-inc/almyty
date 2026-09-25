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
import { GatewayAppLinkService } from './gateway-app-link.service';

/**
 * `GET /gateways/:gatewayId/app`: the app a gateway was published from.
 *
 * A gateway an app stood up is configured on the app, so the gateway
 * page shows "Managed in <app>" and links there instead of offering a
 * second set of the same settings. `data` is null for a gateway no app
 * owns.
 */
@Controller('gateways')
@ApiTags('Gateways')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PrivateGatewayGuard)
export class GatewayAppLinkController {
  constructor(
    private readonly gateways: GatewaysService,
    private readonly appLink: GatewayAppLinkService,
  ) {}

  @Get(':gatewayId/app')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'The app that manages this gateway, if any' })
  async managedBy(@Param('gatewayId', ParseUUIDPipe) gatewayId: string, @Request() req: any) {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) throw new BadRequestException('No organization found');
    // Visible to this caller, or a 404 exactly like the gateway page's.
    await this.gateways.getGateway(gatewayId, organizationId, false, { id: req.user.id });
    return { success: true, data: await this.appLink.managedBy(organizationId, gatewayId) };
  }
}
