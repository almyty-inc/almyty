import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { PrivateGatewayGuard } from '../private-gateway.guard';
import { VisitorOAuthConfigService } from './visitor-oauth-config.service';

/**
 * Set, read and remove the OAuth provider a hosted chat surface signs
 * visitors in with. The only writer of a gateway's `visitorOAuth`
 * column; see VisitorOAuthConfigService. Same guards and roles as the
 * custom domain.
 */
@Controller('gateways')
@ApiTags('Gateways')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PrivateGatewayGuard)
export class VisitorOAuthConfigController {
  constructor(private readonly config: VisitorOAuthConfigService) {}

  private org(req: any): string {
    const organizationId = req?.user?.currentOrganizationId;
    if (!organizationId) throw new BadRequestException('Organization context required. Send X-Organization-Id.');
    return organizationId;
  }

  @Get(':gatewayId/visitor-oauth')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'The visitor OAuth provider of a hosted chat app, and the redirect URIs to register' })
  async get(@Param('gatewayId', ParseUUIDPipe) gatewayId: string, @Request() req: any) {
    return { success: true, data: await this.config.get(gatewayId, this.org(req), req.user.id) };
  }

  @Put(':gatewayId/visitor-oauth')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Set the visitor OAuth provider; the client secret is stored in credentials' })
  async set(@Param('gatewayId', ParseUUIDPipe) gatewayId: string, @Body() body: Record<string, any>, @Request() req: any) {
    return { success: true, data: await this.config.set(gatewayId, this.org(req), req.user.id, body) };
  }

  @Delete(':gatewayId/visitor-oauth')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Remove the visitor OAuth provider and its stored secret' })
  async remove(@Param('gatewayId', ParseUUIDPipe) gatewayId: string, @Request() req: any) {
    await this.config.remove(gatewayId, this.org(req), req.user.id);
    return { success: true };
  }
}
