import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LlmProvider } from '../../entities/llm-provider.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
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
      Conversation,
      Message,
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