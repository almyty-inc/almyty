import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Api } from '../../entities/api.entity';
import { Tool } from '../../entities/tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { User } from '../../entities/user.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';

import { ApisModule } from '../apis/apis.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { AgentsModule } from '../agents/agents.module';

import { OnboardingService } from './onboarding.service';
import { SampleWorkspaceService } from './sample-workspace.service';
import { OnboardingController } from './onboarding.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Api,
      Tool,
      Gateway,
      Agent,
      User,
      RequestLog,
      LlmProvider,
    ]),
    ApisModule,
    GatewaysModule,
    AgentsModule,
  ],
  providers: [OnboardingService, SampleWorkspaceService],
  controllers: [OnboardingController],
  exports: [OnboardingService, SampleWorkspaceService],
})
export class OnboardingModule {}
