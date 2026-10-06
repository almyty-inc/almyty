import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Runner } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { Workspace } from '../../entities/workspace.entity';
import { Tool } from '../../entities/tool.entity';
import { Agent } from '../../entities/agent.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';

import { RunnerService } from './runner.service';
import { RunnerController } from './runner.controller';
import { RunnerCallService } from './runner-call.service';
import { RunnerCapabilityPublisher } from './runner-capability.publisher';
import { CodingRelayService } from './coding-relay.service';
import { RunWorkspaceService } from './run-workspace.service';
import { WorkspaceModule } from '../workspace/workspace.module';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { WorkerStreamTransport } from './transport/worker-stream.transport';
import { WorkerStreamController } from './transport/worker-stream.controller';

/**
 * Runner module: registration, heartbeat, FSM, the worker stream, and the
 * dispatch bridge to running runners.
 *
 * RunnerService manages the row + state machine. WorkerStreamTransport
 * (`/runners/stream`, and `/mcp/streamable` for one runner release) is the
 * long-lived channel a runner daemon holds; it used to be the MCP
 * Streamable HTTP transport and moved here when MCP went stateless.
 * RunnerCallService sits on it and turns dispatch calls into request
 * envelopes. RunnerCapabilityPublisher mints/cleans up Tool rows that
 * point at runner methods so the rest of the platform (MCP gateways,
 * OpenAI-compat, builders) sees runner methods as normal tools.
 *
 * forwardRef on WorkspaceModule: WorkspaceModule imports RunnerModule so
 * its TTL tick can drive the runner FSM, and RunnerCallService imports
 * WorkspaceService so a heartbeat can be acked with the runner's
 * active-workspace set. Both edges are forwardRef'd so neither module's
 * file order decides whether the app boots.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Runner, RunnerSession, Workspace, Tool, Agent, AgentRun, AgentExecution]),
    forwardRef(() => WorkspaceModule),
    AuthorizationModule,
  ],
  providers: [
    RunnerService,
    RunnerCallService,
    RunnerCapabilityPublisher,
    CodingRelayService,
    RunWorkspaceService,
    WorkerStreamTransport,
  ],
  // WorkerStreamController first: Express matches routes in registration
  // order, and RunnerController's GET /runners/:runnerId (ParseUUIDPipe)
  // would otherwise take GET /runners/stream and answer 400.
  controllers: [WorkerStreamController, RunnerController],
  exports: [RunnerService, RunnerCallService, RunnerCapabilityPublisher, CodingRelayService, RunWorkspaceService],
})
export class RunnerModule {}
