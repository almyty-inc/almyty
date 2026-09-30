import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';

import { Agent } from '../../entities/agent.entity';
import { AgentChannel } from '../../entities/agent-channel.entity';
import { AppBuild } from '../../entities/app-build.entity';
import { Credential } from '../../entities/credential.entity';
import { Gateway } from '../../entities/gateway.entity';

import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { FilesModule } from '../files/files.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { AgentChannelsController } from './agent-channels.controller';
import { AgentChannelsService } from './agent-channels.service';
import { AppBuildsService, APP_BUILD_QUEUE } from './app-builds.service';
import { AppBuildProcessor } from './app-build.processor';
import { buildProcessingEnabled } from './build-mode';
import { BuildSignerService } from './build-signer.service';

/**
 * Channels on an agent: the web chat, the website widget, messaging
 * platforms, A2A, and the desktop and terminal apps people download.
 *
 * Depends on the agent only to read and manage it; never on the agent
 * runtime. A channel decides who may talk to an agent and where, never
 * how it thinks.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AgentChannel, Agent, AppBuild, Credential, Gateway]),
    BullModule.registerQueue({ name: APP_BUILD_QUEUE }),
    // Downloads go through the same storage the rest of the product uses,
    // so a deployment on S3 gets signed download URLs for free.
    FilesModule,
    // Publishing a channel stands up a gateway of the matching type.
    // Gateways does not depend on us, so this is a plain import.
    GatewaysModule,
    AuthorizationModule,
  ],
  controllers: [AgentChannelsController],
  providers: [
    AgentChannelsService,
    AppBuildsService,
    BuildSignerService,
    // Only consume build jobs when this process is meant to. An API pod
    // running alongside a dedicated build worker sets APP_BUILD_MODE=off
    // so it does not grab a job it cannot fully handle.
    ...(buildProcessingEnabled() ? [AppBuildProcessor] : []),
  ],
  exports: [AgentChannelsService, AppBuildsService],
})
export class AgentChannelsModule {}
