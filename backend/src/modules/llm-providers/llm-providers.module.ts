import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LlmProvider } from '../../entities/llm-provider.entity';
import { LlmSession } from '../../entities/llm-session.entity';
import { LlmMessage } from '../../entities/llm-message.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Tool } from '../../entities/tool.entity';

import { LlmProvidersService } from './llm-providers.service';
import { LlmProvidersController } from './llm-providers.controller';

import { ToolsModule } from '../tools/tools.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      LlmProvider,
      LlmSession,
      LlmMessage,
      User,
      Organization,
      Gateway,
      Tool,
    ]),
    ToolsModule,
  ],
  providers: [LlmProvidersService],
  controllers: [LlmProvidersController],
  exports: [LlmProvidersService],
})
export class LlmProvidersModule {}