import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { PrivateGatewayGuard } from '../private-gateway.guard';
import { CustomDomainService } from './custom-domain.service';

/**
 * Set, verify and remove a hosted chat app's custom domain. The only
 * writer of a gateway's `customDomain` block; see CustomDomainService.
 * Same guards and roles as updating the gateway itself.
 */
@Controller('gateways')
@ApiTags('Gateways')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PrivateGatewayGuard)
export class CustomDomainController {
  constructor(private readonly domains: CustomDomainService) {}

  private org(req: any): string {
    const organizationId = req?.user?.currentOrganizationId;
    if (!organizationId) throw new BadRequestException('Organization context required. Send X-Organization-Id.');
    return organizationId;
  }

  @Get(':gatewayId/custom-domain')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'The hosted chat custom domain and the DNS records to publish' })
  async get(@Param('gatewayId', ParseUUIDPipe) gatewayId: string, @Request() req: any) {
    return { success: true, data: await this.domains.get(gatewayId, this.org(req), req.user.id) };
  }

  @Put(':gatewayId/custom-domain')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Claim a custom domain; it is served only after verification' })
  async set(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Body() body: { hostname?: unknown },
    @Request() req: any,
  ) {
    return { success: true, data: await this.domains.set(gatewayId, this.org(req), req.user.id, body?.hostname) };
  }

  @Post(':gatewayId/custom-domain/verify')
  @HttpCode(200)
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Check the TXT record and, if it matches, serve the domain' })
  async verify(@Param('gatewayId', ParseUUIDPipe) gatewayId: string, @Request() req: any) {
    return { success: true, data: await this.domains.verify(gatewayId, this.org(req), req.user.id) };
  }

  @Delete(':gatewayId/custom-domain')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Stop serving the custom domain' })
  async remove(@Param('gatewayId', ParseUUIDPipe) gatewayId: string, @Request() req: any) {
    await this.domains.remove(gatewayId, this.org(req), req.user.id);
    return { success: true };
  }
}
