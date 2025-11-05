import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { McpController } from './mcp.controller';
import { McpTransportController } from './controllers/mcp-transport.controller';
import { UtcpController } from './controllers/utcp.controller';
import { A2AController } from './controllers/a2a.controller';
import { PublicController } from './controllers/public.controller';
import { McpService } from './mcp.service';
import { McpGatewayService } from './mcp-gateway.service';
import { McpSessionService } from './mcp-session.service';
import { UtcpService } from './utcp.service';
import { A2AService } from './a2a.service';
import { RealtimeExecutorService } from './realtime-executor.service';
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

// Import related modules
import { ToolsModule } from '../tools/tools.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { forwardRef } from '@nestjs/common';

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
    ]),
    forwardRef(() => ToolsModule),
  ],
  controllers: [McpController, McpTransportController, UtcpController, A2AController, PublicController],
  providers: [
    McpService,
    McpGatewayService,
    McpSessionService,
    UtcpService,
    A2AService,
    RealtimeExecutorService,
    SseTransport,
    WebSocketTransport,
  ],
  exports: [
    McpService,
    McpGatewayService,
    McpSessionService,
    UtcpService,
    A2AService,
    RealtimeExecutorService,
    SseTransport,
    WebSocketTransport,
  ],
})
export class McpModule {}