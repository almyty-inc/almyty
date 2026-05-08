import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseUUIDPipe,
  UseGuards,
  Request,
  NotFoundException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';

import { GatewaysService } from '../gateways.service';
import { ChannelGatewayService } from './channel-gateway.service';

/**
 * Observability + connectivity surface for channel-type gateways.
 * Mounted under /gateways/:id/* alongside the main gateways
 * controller; we keep this in its own file so the gateway controller
 * stays focused on CRUD/auth/protocol routing.
 *
 * RBAC:
 *   - GET /gateways/:id/events           — member, admin, owner
 *   - POST /gateways/:id/test-connection — admin, owner only (the
 *     auth-probe leaks creds-validity; not for plain members)
 */
@Controller('gateways')
@ApiTags('Gateway channels')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ChannelEventsController {
  constructor(
    private readonly gatewaysService: GatewaysService,
    private readonly channelGatewayService: ChannelGatewayService,
  ) {}

  @Get(':id/events')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List recent channel events for this gateway' })
  async listEvents(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    const orgId = req.user.currentOrganizationId;
    const gateway = await this.gatewaysService.getGateway(id, orgId, false);
    if (!gateway) throw new NotFoundException('Gateway not found');
    const events = await this.channelGatewayService.listEventsForGateway(
      gateway.id,
      limit ? Math.min(parseInt(limit, 10) || 100, 500) : 100,
    );
    return { success: true, data: events };
  }

  @Post(':id/test-connection')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Probe channel-gateway connectivity (auth check only, no message sent)' })
  async testConnection(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const orgId = req.user.currentOrganizationId;
    const gateway = await this.gatewaysService.getGateway(id, orgId, false);
    if (!gateway) throw new NotFoundException('Gateway not found');
    const result = await this.channelGatewayService.testConnection(gateway);
    return { success: true, data: result };
  }
}
