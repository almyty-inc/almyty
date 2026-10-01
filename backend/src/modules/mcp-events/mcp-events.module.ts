import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GatewayTool } from '../../entities/gateway-tool.entity';
import { McpChangeBus } from './mcp-change-bus.service';

/**
 * Global so the modules that change what a gateway serves (gateways, tools,
 * mcp-sources) can announce it, and the MCP module can deliver it on
 * subscriptions/listen streams, without either importing the other.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([GatewayTool])],
  providers: [McpChangeBus],
  exports: [McpChangeBus],
})
export class McpEventsModule {}
