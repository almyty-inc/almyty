import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Agent } from '../../entities/agent.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { Tool } from '../../entities/tool.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { ApiKey } from '../../entities/api-key.entity';

import { AgentsService } from './agents.service';
import { AgentExecutionEngine } from './agent-execution.engine';
import { AgentNodeExecutor } from './agent-node-executor';
import { AgentTemplateResolver } from './agent-template-resolver';
import { AgentWebhookService } from './agent-webhook.service';
import { AgentSchedulerService } from './agent-scheduler.service';
import { AgentsController } from './agents.controller';
import { AgentOpenAICompatController } from './agent-openai-compat.controller';

import { LlmProvidersModule } from '../llm-providers/llm-providers.module';
import { ToolsModule } from '../tools/tools.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Agent,
      AgentExecution,
      Tool,
      LlmProvider,
      Gateway,
      GatewayTool,
      User,
      Organization,
      ApiKey,
    ]),
    forwardRef(() => LlmProvidersModule),
    forwardRef(() => ToolsModule),
  ],
  providers: [AgentsService, AgentExecutionEngine, AgentNodeExecutor, AgentTemplateResolver, AgentWebhookService, AgentSchedulerService],
  controllers: [AgentsController, AgentOpenAICompatController],
  exports: [AgentsService, AgentExecutionEngine],
})
export class AgentsModule {}
