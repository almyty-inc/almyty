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
import { A2AService } from '../a2a.service';

/**
 * Gateway-scoped A2A controller using human-readable slug URLs.
 * Pattern: /a2a/:orgSlug/:gatewayEndpoint/...
 * Mirrors gateway-mcp.controller.ts for consistency.
 */
@Controller('a2a/:orgId')
export class GatewayA2AController {
  private readonly logger = new Logger(GatewayA2AController.name);

  constructor(
    private readonly a2aService: A2AService,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
  ) {}

  /**
   * Resolve organization from slug, name-based slug, or UUID.
   */
  private async resolveOrganization(orgSlugOrId: string): Promise<any> {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgSlugOrId);

    if (isUUID) {
      return this.gatewayRepository.manager.getRepository('Organization').findOne({
        where: { id: orgSlugOrId },
      });
    }

    let org = await this.gatewayRepository.manager.getRepository('Organization').findOne({
      where: { slug: orgSlugOrId },
    });

    if (!org) {
      const allOrgs = await this.gatewayRepository.manager.getRepository('Organization').find();
      org = allOrgs.find(o =>
        o.name?.toLowerCase().replace(/\s+/g, '-') === orgSlugOrId,
      );
    }

    return org;
  }

  private async resolveGateway(orgId: string, endpoint: string): Promise<Gateway> {
    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return this.gatewayRepository.findOne({
      where: {
        endpoint: normalizedEndpoint,
        organizationId: orgId,
        status: GatewayStatus.ACTIVE,
      },
      relations: ['organization'],
    });
  }

  @Get('*')
  @Header('Content-Type', 'application/json')
  async handleGetRequest(
    @Param('orgId') orgSlugOrId: string,
    @Req() req: any,
  ) {
    const fullPath = req.path;
    const afterOrg = fullPath.replace(`/a2a/${orgSlugOrId}`, '');

    const segments = afterOrg.split('/').filter(Boolean);
    if (segments.length < 2) {
      throw new HttpException('Invalid A2A path. Expected: /a2a/{org}/{gateway}/.well-known/a2a', HttpStatus.BAD_REQUEST);
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

    this.logger.log(`A2A gateway request: org=${orgSlugOrId}, gateway=${gateway.name}, action=${action}`);

    if (action === '.well-known/a2a') {
      const baseUrl = process.env.BASE_URL || 'http://localhost:4000';
      return {
        protocol: 'a2a',
        version: '1.0.0',
        server: { name: 'apifai', version: '1.0.0', description: gateway.name },
        endpoints: {
          agents: `${baseUrl}/a2a/${orgSlugOrId}${gatewayEndpoint}/agents`,
          messages: `${baseUrl}/a2a/${orgSlugOrId}${gatewayEndpoint}/messages`,
          discovery: `${baseUrl}/a2a/${orgSlugOrId}${gatewayEndpoint}/.well-known/a2a`,
        },
        gateway: { id: gateway.id, name: gateway.name },
      };
    }

    if (action === 'agents') {
      return this.a2aService.listAgents(org.id);
    }

    throw new HttpException(`Unknown A2A action: ${action}`, HttpStatus.NOT_FOUND);
  }

  @Post('*')
  @Header('Content-Type', 'application/json')
  async handlePostRequest(
    @Param('orgId') orgSlugOrId: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    const fullPath = req.path;
    const afterOrg = fullPath.replace(`/a2a/${orgSlugOrId}`, '');

    const segments = afterOrg.split('/').filter(Boolean);
    if (segments.length < 2) {
      throw new HttpException('Invalid A2A path', HttpStatus.BAD_REQUEST);
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

    this.logger.log(`A2A gateway POST: org=${orgSlugOrId}, gateway=${gateway.name}, action=${action}`);

    if (action === 'messages' && body.fromAgentId && body.toAgentId) {
      return this.a2aService.sendMessage(body.fromAgentId, body.toAgentId, body.content, body.messageType);
    }

    if (action === 'agents' && body.name) {
      return this.a2aService.registerAgent(org.id, body);
    }

    throw new HttpException(`Unknown A2A action: ${action}`, HttpStatus.NOT_FOUND);
  }
}
