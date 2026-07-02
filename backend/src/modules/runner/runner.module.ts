import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Runner } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { Workspace } from '../../entities/workspace.entity';
import { Tool } from '../../entities/tool.entity';

import { RunnerService } from './runner.service';
import { RunnerController } from './runner.controller';
import { RunnerCallService } from './runner-call.service';
import { RunnerCapabilityPublisher } from './runner-capability.publisher';
import { CodingRelayService } from './coding-relay.service';
import { McpModule } from '../mcp/mcp.module';
import { AuthorizationModule } from '../../common/authorization/authorization.module';

/**
 * Runner module: registration, heartbeat, FSM, and the dispatch
 * bridge to running runners.
 *
 * RunnerService manages the row + state machine. RunnerCallService
 * sits on the Streamable HTTP transport and turns dispatch calls
 * into request envelopes. RunnerCapabilityPublisher mints/cleans up
 * Tool rows that point at runner methods so the rest of the platform
 * (MCP gateways, OpenAI-compat, builders) sees runner methods as
 * normal tools.
 *
 * forwardRef on McpModule because McpModule already forwardRef's
 * ToolsModule, and ToolsModule will need RunnerModule for routing
 * dispatch — the cycle is McpModule → ToolsModule → RunnerModule →
 * McpModule. forwardRef on either edge is enough; we put it on the
 * runner side because McpModule's surface is the older one.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Runner, RunnerSession, Workspace, Tool]),
    forwardRef(() => McpModule),
    AuthorizationModule,
  ],
  providers: [RunnerService, RunnerCallService, RunnerCapabilityPublisher, CodingRelayService],
  controllers: [RunnerController],
  exports: [RunnerService, RunnerCallService, RunnerCapabilityPublisher, CodingRelayService],
})
export class RunnerModule {}
