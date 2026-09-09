import { Module, forwardRef } from '@nestjs/common';
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
import { LlmSessionsController } from './llm-sessions.controller';
import { LlmModelsHelper } from './llm-models.helper';
import { LlmChatHelper } from './llm-chat.helper';
import { LlmStatsHelper } from './llm-stats.helper';
import { LlmChatRunnerHelper } from './llm-chat-runner.helper';
import { DefaultModelResolver } from './default-model.resolver';
import { LlmProviderSecretsHelper } from './llm-provider-secrets.helper';
import { EndpointProviderHelper } from './endpoint-provider.helper';

import { ModelCatalogModule } from '../model-catalog/model-catalog.module';

import { ToolsModule } from '../tools/tools.module';
import { AuthorizationModule } from '../../common/authorization/authorization.module';

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
    forwardRef(() => ToolsModule),
    AuthorizationModule,
    // Supplies PriceFeedService (live prices for cost calculation) and the
    // ModelRouterService the chat runner walks; the catalog's validation run
    // needs the runner back, hence the forwardRef.
    forwardRef(() => ModelCatalogModule),
  ],
  providers: [LlmProvidersService, LlmModelsHelper, LlmChatHelper, LlmStatsHelper, LlmChatRunnerHelper, DefaultModelResolver, LlmProviderSecretsHelper, EndpointProviderHelper],
  controllers: [LlmProvidersController, LlmSessionsController],
  exports: [LlmProvidersService, LlmModelsHelper, LlmChatRunnerHelper, LlmProviderSecretsHelper, EndpointProviderHelper],
})
export class LlmProvidersModule {}
