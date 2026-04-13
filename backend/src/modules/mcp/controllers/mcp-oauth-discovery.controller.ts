import { Controller, Get, Param, Header, Logger } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { McpOAuthController } from './mcp-oauth.controller';

/**
 * Root-level OAuth discovery routes per RFC 8414 Section 3 and RFC 9728.
 *
 * RFC 8414 specifies that authorization server metadata lives at:
 *   {scheme}://{authority}/.well-known/oauth-authorization-server{path}
 *
 * So for server URL https://api.almyty.com/mcp/org/gateway, the metadata is at:
 *   https://api.almyty.com/.well-known/oauth-authorization-server/mcp/org/gateway
 *
 * MCP clients (Claude Code, Claude Desktop) follow this convention.
 * These routes delegate to the same McpOAuthController methods.
 */
@Controller('.well-known')
export class McpOAuthDiscoveryController {
  private readonly logger = new Logger(McpOAuthDiscoveryController.name);

  constructor(private readonly mcpOAuthController: McpOAuthController) {}

  @Get('oauth-authorization-server/mcp/:orgSlug/:gatewaySlug')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Header('Content-Type', 'application/json')
  async authServerMetadata(
    @Param('orgSlug') orgSlug: string,
    @Param('gatewaySlug') gatewaySlug: string,
  ) {
    return this.mcpOAuthController.getAuthorizationServerMetadata(orgSlug, gatewaySlug);
  }

  @Get('oauth-protected-resource/mcp/:orgSlug/:gatewaySlug')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Header('Content-Type', 'application/json')
  async protectedResourceMetadata(
    @Param('orgSlug') orgSlug: string,
    @Param('gatewaySlug') gatewaySlug: string,
  ) {
    return this.mcpOAuthController.getProtectedResourceMetadata(orgSlug, gatewaySlug);
  }
}
