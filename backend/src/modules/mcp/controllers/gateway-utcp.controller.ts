import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  HttpException,
  HttpStatus,
  Logger,
  Header,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Gateway, GatewayStatus } from '../../../entities/gateway.entity';
import { UtcpService } from '../utcp.service';

/**
 * Gateway-scoped UTCP controller using human-readable slug URLs.
 * Pattern: /utcp/:orgSlug/:gatewayEndpoint/...
 * Mirrors gateway-mcp.controller.ts for consistency.
 */
@Controller('utcp/:orgId')
export class GatewayUtcpController {
  private readonly logger = new Logger(GatewayUtcpController.name);

  constructor(
    private readonly utcpService: UtcpService,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
  ) {}

  /**
   * Resolve organization from slug, name-based slug, or UUID.
   * Reuses the same logic as GatewayMcpController.
   */
  private async resolveOrganization(orgSlugOrId: string): Promise<any> {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgSlugOrId);

    if (isUUID) {
      return this.gatewayRepository.manager.getRepository('Organization').findOne({
        where: { id: orgSlugOrId },
      });
    }

    // Try exact slug match
    let org = await this.gatewayRepository.manager.getRepository('Organization').findOne({
      where: { slug: orgSlugOrId },
    });

    // Fallback: name-based slug
    if (!org) {
      const allOrgs = await this.gatewayRepository.manager.getRepository('Organization').find();
      org = allOrgs.find(o =>
        o.name?.toLowerCase().replace(/\s+/g, '-') === orgSlugOrId,
      );
    }

    return org;
  }

  /**
   * Find an active gateway by endpoint path within an organization.
   */
  private async resolveGateway(orgId: string, endpoint: string): Promise<Gateway> {
    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const gateway = await this.gatewayRepository.findOne({
      where: {
        endpoint: normalizedEndpoint,
        organizationId: orgId,
        status: GatewayStatus.ACTIVE,
      },
      relations: ['organization'],
    });
    return gateway;
  }

  // Catch-all handler for gateway-scoped UTCP requests
  // Routes: GET /:orgSlug/:endpoint/.well-known/utcp
  //         GET /:orgSlug/:endpoint/manual
  //         POST /:orgSlug/:endpoint/execute
  @Get('*')
  @Header('Content-Type', 'application/json')
  async handleGetRequest(
    @Param('orgId') orgSlugOrId: string,
    @Req() req: any,
  ) {
    const fullPath = req.path;
    const afterOrg = fullPath.replace(`/utcp/${orgSlugOrId}`, '');

    // Parse: /<gatewayEndpoint>/<action>
    const segments = afterOrg.split('/').filter(Boolean);
    if (segments.length < 2) {
      throw new HttpException('Invalid UTCP path. Expected: /utcp/{org}/{gateway}/manual', HttpStatus.BAD_REQUEST);
    }

    const gatewayEndpoint = `/${segments[0]}`;
    const action = segments.slice(1).join('/');

    const org = await this.resolveOrganization(orgSlugOrId);
    if (!org) {
      throw new HttpException(`Organization not found: ${orgSlugOrId}`, HttpStatus.NOT_FOUND);
    }

    const gateway = await this.resolveGateway(org.id, gatewayEndpoint);
    if (!gateway) {
      throw new HttpException(`Gateway not found: ${gatewayEndpoint}`, HttpStatus.NOT_FOUND);
    }

    this.logger.log(`UTCP gateway request: org=${orgSlugOrId}, gateway=${gateway.name}, action=${action}`);

    if (action === '.well-known/utcp') {
      return this.utcpService.getDiscoveryInfo(org.id);
    }

    if (action === 'manual') {
      return this.utcpService.generateManual(org.id);
    }

    throw new HttpException(`Unknown UTCP action: ${action}`, HttpStatus.NOT_FOUND);
  }

  @Post('*')
  @Header('Content-Type', 'application/json')
  async handlePostRequest(
    @Param('orgId') orgSlugOrId: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    const fullPath = req.path;
    const afterOrg = fullPath.replace(`/utcp/${orgSlugOrId}`, '');

    const segments = afterOrg.split('/').filter(Boolean);
    if (segments.length < 2) {
      throw new HttpException('Invalid UTCP path. Expected: /utcp/{org}/{gateway}/execute', HttpStatus.BAD_REQUEST);
    }

    const gatewayEndpoint = `/${segments[0]}`;
    const action = segments.slice(1).join('/');

    const org = await this.resolveOrganization(orgSlugOrId);
    if (!org) {
      throw new HttpException(`Organization not found: ${orgSlugOrId}`, HttpStatus.NOT_FOUND);
    }

    const gateway = await this.resolveGateway(org.id, gatewayEndpoint);
    if (!gateway) {
      throw new HttpException(`Gateway not found: ${gatewayEndpoint}`, HttpStatus.NOT_FOUND);
    }

    this.logger.log(`UTCP gateway POST: org=${orgSlugOrId}, gateway=${gateway.name}, action=${action}`);

    if (action === 'execute') {
      return this.utcpService.executeUtcpTool(body, org.id);
    }

    throw new HttpException(`Unknown UTCP action: ${action}`, HttpStatus.NOT_FOUND);
  }
}
