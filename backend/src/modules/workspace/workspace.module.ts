import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';

import { Runner } from '../../entities/runner.entity';
import { Workspace } from '../../entities/workspace.entity';

import { WorkspaceService } from './workspace.service';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceTickProcessor, WORKSPACE_TICK_QUEUE } from './workspace-tick.processor';
import { RunnerModule } from '../runner/runner.module';

/**
 * Workspace module: lifecycle (create / release / sweep) and the
 * BullMQ tick that drives both the runner state machine forward and
 * the workspace TTL sweep.
 *
 * Both jobs land on a single queue because they run on the same
 * cadence (heartbeat interval) and share the BullMQ worker pool.
 * Splitting them would just mean two cron schedules to keep aligned.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Workspace, Runner]),
    BullModule.registerQueue({ name: WORKSPACE_TICK_QUEUE }),
    RunnerModule,
  ],
  providers: [WorkspaceService, WorkspaceTickProcessor],
  controllers: [WorkspaceController],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
