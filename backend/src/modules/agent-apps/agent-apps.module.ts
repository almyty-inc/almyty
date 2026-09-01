import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';

import { AgentApp } from '../../entities/agent-app.entity';
import { AppDistribution } from '../../entities/agent-app-distribution.entity';
import { Agent } from '../../entities/agent.entity';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { AppBuild } from '../../entities/app-build.entity';
import { Credential } from '../../entities/credential.entity';
import { FilesModule } from '../files/files.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { AgentAppsController } from './agent-apps.controller';
import { AgentAppsService } from './agent-apps.service';
import { AppBuildsService, APP_BUILD_QUEUE } from './app-builds.service';
import { AppBuildProcessor } from './app-build.processor';
import { buildProcessingEnabled } from './build-mode';
import { BuildSignerService } from './build-signer.service';

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
    TypeOrmModule.forFeature([AgentApp, AppDistribution, Agent, AppBuild, Credential]),
    BullModule.registerQueue({ name: APP_BUILD_QUEUE }),
    // Artifacts go through the same storage the rest of the product
    // uses, so a deployment on S3 gets signed download URLs for free.
    FilesModule,
    // Publishing a distribution stands up a gateway of the matching
    // type. Gateways does not depend on us, so this is a plain import
    // rather than a forwardRef.
    GatewaysModule,
    AuthorizationModule,
  ],
  controllers: [AgentAppsController],
  providers: [
    AgentAppsService,
    AppBuildsService,
    BuildSignerService,
    // Only consume build jobs when this process is meant to. An API pod
    // running alongside a dedicated build worker sets APP_BUILD_MODE=off
    // so it does not grab a job it cannot fully handle.
    ...(buildProcessingEnabled() ? [AppBuildProcessor] : []),
  ],
  exports: [AgentAppsService, AppBuildsService],
})
export class AgentAppsModule {}
