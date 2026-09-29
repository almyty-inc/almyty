import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Api } from '../../entities/api.entity';
import { Tool } from '../../entities/tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { User } from '../../entities/user.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { AgentChannel } from '../../entities/agent-channel.entity';
import { Runner } from '../../entities/runner.entity';

import { GatewaysModule } from '../gateways/gateways.module';
import { AgentsModule } from '../agents/agents.module';
import { AuthorizationModule } from '../../common/authorization/authorization.module';

import { OnboardingService } from './onboarding.service';
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
      AgentChannel,
      Runner,
    ]),
    GatewaysModule,
    AgentsModule,
    AuthorizationModule,
  ],
  providers: [OnboardingService],
  controllers: [OnboardingController],
  exports: [OnboardingService],
})
export class OnboardingModule {}
