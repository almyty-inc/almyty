import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Runner } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { Workspace } from '../../entities/workspace.entity';

import { RunnerService } from './runner.service';
import { RunnerController } from './runner.controller';

/**
 * Runner module: registration, heartbeat, and the state machine.
 *
 * Workspace operations live in WorkspaceModule but RunnerService
 * needs read access to Workspace to count active workspaces during
 * heartbeat-driven state computation. We register all three entities
 * here and re-export the service so WorkspaceModule can depend on
 * us for state queries (canAcceptWork, the active session lookup).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Runner, RunnerSession, Workspace])],
  providers: [RunnerService],
  controllers: [RunnerController],
  exports: [RunnerService],
})
export class RunnerModule {}
