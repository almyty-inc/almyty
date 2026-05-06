import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';

import { Agent } from '../../entities/agent.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Tool } from '../../entities/tool.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';

import { AgentsService } from './agents.service';
import { AgentExecutionEngine } from './agent-execution.engine';
import { AgentExecutionStateHelper } from './agent-execution-state.helper';
import { AgentNodeExecutor } from './agent-node-executor';
import { AgentTemplateResolver } from './agent-template-resolver';
import { AgentWebhookService } from './agent-webhook.service';
import { AgentSchedulerService } from './agent-scheduler.service';
import { AgentAuditService } from './agent-audit.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentRuntimeBuilders } from './agent-runtime-builders';
import { AgentCollaborationHelper } from './agent-collaboration.helper';
import { AgentBuiltInToolsHelper } from './agent-builtin-tools.helper';
import { AgentRuntimeEventsHelper } from './agent-runtime-events.helper';
import { AgentRuntimeMiscHelper } from './agent-runtime-misc.helper';
import { AgentStepProcessor } from './agent-step-processor';
import { AgentSubAgentExecutors } from './agent-subagent-executors.helper';
import { AgentHeartbeatHelper } from './agent-heartbeat.helper';
import { AgentRuntimeProcessor } from './agent-runtime.processor';
import { AgentValidationHelper } from './agent-validation.helper';
import { AgentsController } from './agents.controller';
import { AgentExecutionController } from './agent-execution.controller';
import { AgentManagementController } from './agent-management.controller';
import { AgentRunsController } from './agent-runs.controller';
import { AgentOpenAICompatController } from './agent-openai-compat.controller';

import { LlmProvidersModule } from '../llm-providers/llm-providers.module';
import { ToolsModule } from '../tools/tools.module';
import { MemoryModule } from '../memory/memory.module';
import { A2AModule } from '../a2a/a2a.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Agent,
      AgentExecution,
      AgentRun,
      Tool,
      LlmProvider,
      Gateway,
      GatewayTool,
      User,
      Organization,
      ApiKey,
      Conversation,
      Message,
    ]),
    BullModule.registerQueue({ name: 'agent-scheduler' }),
    BullModule.registerQueue({ name: 'agent-runtime' }),
    forwardRef(() => LlmProvidersModule),
    forwardRef(() => ToolsModule),
    forwardRef(() => MemoryModule),
    forwardRef(() => A2AModule),
  ],
  providers: [AgentsService, AgentExecutionEngine, AgentExecutionStateHelper, AgentNodeExecutor, AgentTemplateResolver, AgentWebhookService, AgentSchedulerService, AgentAuditService, AgentRuntimeService, AgentRuntimeBuilders, AgentCollaborationHelper, AgentBuiltInToolsHelper, AgentHeartbeatHelper, AgentRuntimeEventsHelper, AgentRuntimeProcessor],
  controllers: [AgentsController, AgentManagementController, AgentRunsController, AgentOpenAICompatController],
  exports: [AgentsService, AgentExecutionEngine, AgentRuntimeService],
})
export class AgentsModule {}
