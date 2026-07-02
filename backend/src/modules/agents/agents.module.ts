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
import { ApprovalRequest } from '../../entities/approval-request.entity';
import { AgentFile } from '../../entities/file.entity';

import { AgentsService } from './agents.service';
import { AgentExecutionEngine } from './agent-execution.engine';
import { AgentExecutionStateHelper } from './agent-execution-state.helper';
import { AgentOpenAIStreamHelper } from './agent-openai-stream.helper';
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
import { AgentVerifierHelper } from './agent-verifier.helper';
import { AgentContextCompactor } from './agent-context-compactor.helper';
import { AgentHeartbeatHelper } from './agent-heartbeat.helper';
import { AgentRuntimeProcessor } from './agent-runtime.processor';
import { AgentRunReaperService } from './agent-run-reaper.service';
import { AgentValidationHelper } from './agent-validation.helper';
import { AgentTechDocHelper } from './agent-tech-doc.helper';
import { AgentsController } from './agents.controller';
import { AgentExecutionController } from './agent-execution.controller';
import { AgentManagementController } from './agent-management.controller';
import { AgentScheduleController } from './agent-schedule.controller';
import { AgentRunsController } from './agent-runs.controller';
import { AgentOpenAICompatController } from './agent-openai-compat.controller';

import { LlmProvidersModule } from '../llm-providers/llm-providers.module';
import { AgentConstraintsModule } from '../agent-constraints/agent-constraints.module';
import { ToolsModule } from '../tools/tools.module';
import { MemoryModule } from '../memory/memory.module';
import { A2AModule } from '../a2a/a2a.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { BudgetsModule } from '../budgets/budgets.module';

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
      ApprovalRequest,
      AgentFile,
    ]),
    BullModule.registerQueue({ name: 'agent-scheduler' }),
    BullModule.registerQueue({ name: 'agent-runtime' }),
    forwardRef(() => LlmProvidersModule),
    forwardRef(() => ToolsModule),
    forwardRef(() => MemoryModule),
    forwardRef(() => A2AModule),
    forwardRef(() => ApprovalsModule),
    AuthorizationModule,
    AgentConstraintsModule,
    BudgetsModule,
  ],
  providers: [AgentsService, AgentValidationHelper, AgentExecutionEngine, AgentExecutionStateHelper, AgentOpenAIStreamHelper, AgentNodeExecutor, AgentTemplateResolver, AgentWebhookService, AgentSchedulerService, AgentAuditService, AgentRuntimeService, AgentRuntimeBuilders, AgentCollaborationHelper, AgentBuiltInToolsHelper, AgentHeartbeatHelper, AgentRuntimeEventsHelper, AgentRuntimeMiscHelper, AgentStepProcessor, AgentRuntimeProcessor, AgentSubAgentExecutors, AgentVerifierHelper, AgentContextCompactor, AgentTechDocHelper],
  controllers: [AgentsController, AgentExecutionController, AgentManagementController, AgentScheduleController, AgentRunsController, AgentOpenAICompatController],
  exports: [AgentsService, AgentExecutionEngine, AgentRuntimeService],
})
export class AgentsModule {}
