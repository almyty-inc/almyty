import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { McpController } from './mcp.controller';
import { McpTransportController } from './controllers/mcp-transport.controller';
import { McpOAuthController } from './controllers/mcp-oauth.controller';
import { McpOAuthDiscoveryController } from './controllers/mcp-oauth-discovery.controller';
import { McpService } from './mcp.service';
import { AlmytyMcpService } from './almyty-mcp.service';
import { McpGatewayService } from './mcp-gateway.service';
import { McpSessionService } from './mcp-session.service';
import { UtcpService } from './utcp.service';
import { RealtimeExecutorService } from './realtime-executor.service';
import { GatewayResolverService } from './services/gateway-resolver.service';
import { McpOAuthService } from './services/mcp-oauth.service';
import { McpOAuthTokensHelper } from './services/mcp-oauth-tokens.helper';
import { McpOAuthResolveHelper } from './controllers/mcp-oauth-resolve.helper';
import { McpToolHandler } from './services/mcp-tool.handler';
import { McpContentHandler } from './services/mcp-content.handler';
import { McpServerRequestService } from './services/mcp-server-request.service';
import { SseTransport } from './transports/sse.transport';
import { WebSocketTransport } from './transports/websocket.transport';

// Import related entities
import { Tool } from '../../entities/tool.entity';
import { Api } from '../../entities/api.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { OAuthClient } from '../../entities/oauth-client.entity';
import { OAuthAuthorizationCode } from '../../entities/oauth-authorization-code.entity';
import { OAuthAccessToken } from '../../entities/oauth-access-token.entity';

// Import related modules
import { ToolsModule } from '../tools/tools.module';
import { GatewaysModule } from '../gateways/gateways.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tool,
      Api,
      Operation,
      Resource,
      Organization,
      User,
      Gateway,
      GatewayTool,
      ToolCategory,
      OAuthClient,
      OAuthAuthorizationCode,
      OAuthAccessToken,
    ]),
    forwardRef(() => ToolsModule),
    GatewaysModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET', 'dev-jwt-secret'),
        signOptions: { issuer: 'almyty', audience: 'almyty-api' },
        verifyOptions: { issuer: 'almyty', audience: 'almyty-api' },
      }),
    }),
  ],
  controllers: [McpOAuthDiscoveryController, McpOAuthController, McpController, McpTransportController],
  providers: [
    McpToolHandler,
    McpContentHandler,
    McpServerRequestService,
    AlmytyMcpService,
    McpService,
    McpGatewayService,
    McpSessionService,
    UtcpService,
    RealtimeExecutorService,
    GatewayResolverService,
    McpOAuthService,
    McpOAuthTokensHelper,
    McpOAuthResolveHelper,
    SseTransport,
    WebSocketTransport,
  ],
  exports: [
    AlmytyMcpService,
    McpService,
    McpGatewayService,
    McpSessionService,
    McpOAuthService,
    McpServerRequestService,
    UtcpService,
    RealtimeExecutorService,
    GatewayResolverService,
    SseTransport,
    WebSocketTransport,
  ],
})
export class McpModule {}
