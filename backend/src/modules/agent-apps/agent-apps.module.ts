import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';

import { AgentApp } from '../../entities/agent-app.entity';
import { AppDistribution } from '../../entities/agent-app-distribution.entity';
import { Agent } from '../../entities/agent.entity';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { AppBuild } from '../../entities/app-build.entity';
import { FilesModule } from '../files/files.module';
import { AgentAppsController } from './agent-apps.controller';
import { AgentAppsService } from './agent-apps.service';
import { AppBuildsService, APP_BUILD_QUEUE } from './app-builds.service';
import { AppBuildProcessor } from './app-build.processor';

/**
 * The agent factory: turning agents into products a customer ships.
 *
 * Depends on Agent only to verify ownership when a app names one.
 * It deliberately does not depend on the agent runtime: a app
 * decides what a product is called and who may use it, never how an
 * agent thinks.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AgentApp, AppDistribution, Agent, AppBuild]),
    BullModule.registerQueue({ name: APP_BUILD_QUEUE }),
    // Artifacts go through the same storage the rest of the product
    // uses, so a deployment on S3 gets signed download URLs for free.
    FilesModule,
    AuthorizationModule,
  ],
  controllers: [AgentAppsController],
  providers: [AgentAppsService, AppBuildsService, AppBuildProcessor],
  exports: [AgentAppsService, AppBuildsService],
})
export class AgentAppsModule {}
