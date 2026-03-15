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
import { A2AService } from '../a2a.service';
import { GatewayResolverService } from '../services/gateway-resolver.service';

@Controller('a2a/:orgId')
export class GatewayA2AController {
  private readonly logger = new Logger(GatewayA2AController.name);

  constructor(
    private readonly a2aService: A2AService,
    private readonly gatewayResolver: GatewayResolverService,
  ) {}

  @Get('*')
  @Header('Content-Type', 'application/json')
  async handleGetRequest(
    @Param('orgId') orgSlugOrId: string,
    @Req() req: any,
  ) {
    const { gatewayEndpoint, action } = this.gatewayResolver.parsePathSegments(req, orgSlugOrId, 'a2a');
    const { organization, gateway } = await this.gatewayResolver.resolveAndAuthenticate(orgSlugOrId, gatewayEndpoint, req);

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
      return this.a2aService.listAgents(organization.id);
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
    const { gatewayEndpoint, action } = this.gatewayResolver.parsePathSegments(req, orgSlugOrId, 'a2a');
    const { organization, gateway } = await this.gatewayResolver.resolveAndAuthenticate(orgSlugOrId, gatewayEndpoint, req);

    this.logger.log(`A2A gateway POST: org=${orgSlugOrId}, gateway=${gateway.name}, action=${action}`);

    if (action === 'messages' && body.fromAgentId && body.toAgentId) {
      return this.a2aService.sendMessage(body.fromAgentId, body.toAgentId, body.content, body.messageType);
    }

    if (action === 'agents' && body.name) {
      return this.a2aService.registerAgent(organization.id, body);
    }

    throw new HttpException(`Unknown A2A action: ${action}`, HttpStatus.NOT_FOUND);
  }
}
