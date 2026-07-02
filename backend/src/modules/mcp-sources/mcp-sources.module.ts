import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { McpSource } from '../../entities/mcp-source.entity';
import { Tool } from '../../entities/tool.entity';
import { McpClientService } from './mcp-client.service';
import { McpSourcesService } from './mcp-sources.service';
import { McpSourcesController } from './mcp-sources.controller';

/**
 * External MCP servers as tool sources (MCP *client* side — the
 * modules/mcp tree is the server side that SERVES our tools over MCP).
 * Discovery materializes remote tools into the tools table; execution
 * is bridged from ToolExecutorService via McpSourcesService.
 */
@Module({
  imports: [TypeOrmModule.forFeature([McpSource, Tool])],
  providers: [McpClientService, McpSourcesService],
  controllers: [McpSourcesController],
  exports: [McpClientService, McpSourcesService],
})
export class McpSourcesModule {}
