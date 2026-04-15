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
import { AlmytyMcpService } from './almyty-mcp.service';
import { McpOAuthService } from './services/mcp-oauth.service';
import { GatewayResolverService } from './services/gateway-resolver.service';
import { McpAuthExceptionFilter } from './filters/mcp-auth-exception.filter';

@Controller('mcp/:orgId')
@UseFilters(McpAuthExceptionFilter)
export class GatewayMcpController {
  private readonly logger = new Logger(GatewayMcpController.name);

  constructor(
    private readonly mcpService: McpService,
    private readonly almytyMcpService: AlmytyMcpService,
    private readonly mcpOAuthService: McpOAuthService,
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

    if (gateway.isSystem) {
      // Resolve userId from OAuth bearer token
      let userId = req.user?.sub || req.user?.id;
      if (!userId) {
        const token = req.headers?.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7).trim()
          : null;
        if (token) {
          const validation = await this.mcpOAuthService.validateAccessToken(token);
          if (validation.valid) userId = validation.userId;
        }
      }
      const result = await this.almytyMcpService.handleJsonRpc(body, gateway.organizationId, userId);
      this.logger.log(`System MCP response: method=${body?.method}, userId=${userId}, hasResult=${!!result?.result}, hasError=${!!result?.error}`);
      return result;
    }

    return this.mcpService.handleJsonRpc(
      body,
      gateway.organizationId,
      null,
      gateway.id,
    );
  }
}
