import {
  All,
  Controller,
  Param,
  Body,
  Request,
  Req,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { McpService } from './mcp.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Gateway, GatewayStatus } from '../../entities/gateway.entity';

@Controller('mcp/:orgId')
export class GatewayMcpController {
  private readonly logger = new Logger(GatewayMcpController.name);

  constructor(
    private readonly mcpService: McpService,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
  ) {}

  // Handle requests to organization-scoped gateway endpoints
  @All('*')
  async handleGatewayRequest(
    @Param('orgId') orgSlugOrId: string,
    @Req() req: any,
    @Body() body: any,
  ) {
    // Extract the gateway path after /mcp/:orgId/
    const fullPath = req.path; // e.g., /mcp/orgSlug/petstore-mcp
    const gatewayPath = fullPath.replace(`/mcp/${orgSlugOrId}`, ''); // e.g., /petstore-mcp

    this.logger.log(`Gateway request: org=${orgSlugOrId}, path=${gatewayPath}, fullPath=${fullPath}`);

    // Find organization by slug, simple slug from name, or ID
    let org: any;
    // Check if it's a UUID format
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgSlugOrId);

    if (isUUID) {
      org = await this.gatewayRepository.manager.getRepository('Organization').findOne({
        where: { id: orgSlugOrId }
      });
    } else {
      // Try exact slug match first
      org = await this.gatewayRepository.manager.getRepository('Organization').findOne({
        where: { slug: orgSlugOrId }
      });

      // If not found, try to find by simple name-based slug
      if (!org) {
        const allOrgs = await this.gatewayRepository.manager.getRepository('Organization').find();
        org = allOrgs.find(o =>
          o.name?.toLowerCase().replace(/\s+/g, '-') === orgSlugOrId
        );
      }
    }

    if (!org) {
      throw new HttpException(
        `Organization not found: ${orgSlugOrId}`,
        HttpStatus.NOT_FOUND
      );
    }

    // Find gateway by endpoint and organization
    const gateway = await this.gatewayRepository.findOne({
      where: {
        endpoint: gatewayPath,
        organizationId: org.id,
        status: GatewayStatus.ACTIVE
      },
      relations: ['organization'],
    });

    if (!gateway) {
      throw new HttpException(
        `Gateway not found at ${gatewayPath} for organization ${orgSlugOrId}`,
        HttpStatus.NOT_FOUND
      );
    }

    this.logger.log(`Found gateway: ${gateway.name} (${gateway.type})`);

    // For MCP gateways, handle JSON-RPC
    if (gateway.type === 'mcp') {
      return this.mcpService.handleJsonRpc(
        body,
        gateway.organizationId,
        null, // No user context for public gateway
        gateway.id, // Pass gateway ID to scope tools
      );
    }

    throw new HttpException('Gateway type not supported', HttpStatus.BAD_REQUEST);
  }
}
