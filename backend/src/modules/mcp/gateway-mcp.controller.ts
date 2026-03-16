import {
  All,
  Controller,
  Param,
  Body,
  Req,
  Logger,
  UseFilters,
} from '@nestjs/common';
import { McpService } from './mcp.service';
import { GatewayResolverService } from './services/gateway-resolver.service';
import { McpAuthExceptionFilter } from './filters/mcp-auth-exception.filter';

@Controller('mcp/:orgId')
@UseFilters(McpAuthExceptionFilter)
export class GatewayMcpController {
  private readonly logger = new Logger(GatewayMcpController.name);

  constructor(
    private readonly mcpService: McpService,
    private readonly gatewayResolver: GatewayResolverService,
  ) {}

  @All('*')
  async handleGatewayRequest(
    @Param('orgId') orgSlugOrId: string,
    @Req() req: any,
    @Body() body: any,
  ) {
    // Extract the gateway path after /mcp/:orgId/
    const fullPath = req.path;
    const gatewayPath = fullPath.replace(`/mcp/${orgSlugOrId}`, '');

    this.logger.log(`MCP gateway request: org=${orgSlugOrId}, path=${gatewayPath}`);

    const { gateway } = await this.gatewayResolver.resolveAndAuthenticate(
      orgSlugOrId,
      gatewayPath,
      req,
    );

    return this.mcpService.handleJsonRpc(
      body,
      gateway.organizationId,
      null,
      gateway.id,
    );
  }
}
