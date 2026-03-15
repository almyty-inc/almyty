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
import { UtcpService } from '../utcp.service';
import { GatewayResolverService } from '../services/gateway-resolver.service';

@Controller('utcp/:orgId')
export class GatewayUtcpController {
  private readonly logger = new Logger(GatewayUtcpController.name);

  constructor(
    private readonly utcpService: UtcpService,
    private readonly gatewayResolver: GatewayResolverService,
  ) {}

  @Get('*')
  @Header('Content-Type', 'application/json')
  async handleGetRequest(
    @Param('orgId') orgSlugOrId: string,
    @Req() req: any,
  ) {
    const { gatewayEndpoint, action } = this.gatewayResolver.parsePathSegments(req, orgSlugOrId, 'utcp');
    const { organization, gateway } = await this.gatewayResolver.resolveAndAuthenticate(orgSlugOrId, gatewayEndpoint, req);

    this.logger.log(`UTCP gateway request: org=${orgSlugOrId}, gateway=${gateway.name}, action=${action}`);

    if (action === '.well-known/utcp') {
      return this.utcpService.getDiscoveryInfo(organization.id);
    }

    if (action === 'manual') {
      return this.utcpService.generateManual(organization.id);
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
    const { gatewayEndpoint, action } = this.gatewayResolver.parsePathSegments(req, orgSlugOrId, 'utcp');
    const { organization, gateway } = await this.gatewayResolver.resolveAndAuthenticate(orgSlugOrId, gatewayEndpoint, req);

    this.logger.log(`UTCP gateway POST: org=${orgSlugOrId}, gateway=${gateway.name}, action=${action}`);

    if (action === 'execute') {
      return this.utcpService.executeUtcpTool(body, organization.id);
    }

    throw new HttpException(`Unknown UTCP action: ${action}`, HttpStatus.NOT_FOUND);
  }
}
