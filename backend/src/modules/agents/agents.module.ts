import { GatewaysModule } from '../gateways/gateways.module';
import { RunTracePrivacyService } from './run-trace-privacy.service';
import { Model } from '../../entities/model.entity';
import { HostedModelCall } from '../../entities/hosted-model-call.entity';
import { ModelPassThroughService } from './model-pass-through.service';
import { ModelPassThroughController } from './model-pass-through.controller';
import { AgentApiAccessService } from './agent-api-access.service';
import { AgentApiAccessController } from './agent-api-access.controller';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';

import { AgentRole } from '../../entities/agent-role.entity';
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
import { Workspace } from '../../entities/workspace.entity';
import { AgentWake } from '../../entities/agent-wake.entity';
import { AgentChannel } from '../../entities/agent-channel.entity';
import { ConnectionGrant } from '../../entities/connection-grant.entity';

import { AgentsService } from './agents.service';
import { AgentExecutionEngine } from './agent-execution.engine';
import { AgentExecutionCancellationService } from './agent-execution-cancellation.service';
import { AgentExecutionStateHelper } from './agent-execution-state.helper';
import { AgentOpenAIStreamHelper } from './agent-openai-stream.helper';
import { CompatAgentInvoker } from './compat-agent-invoker.service';
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
import { AlwaysOnService } from './always-on/always-on.service';
import { AlwaysOnController } from './always-on/always-on.controller';
import { AgentIdentityService } from './agent-identity';
import { AgentIdentityReachController, AgentIdentityReachService } from './agent-identity-reach';
import { AgentRuntimeProcessor } from './agent-runtime.processor';
import { AgentRunReaperService } from './agent-run-reaper.service';
import { AgentExecutionReaperService } from './agent-execution-reaper.service';
import { WorkflowApprovalResumeService } from './workflow-approval-resume.service';
import { AgentValidationHelper } from './agent-validation.helper';
import { AgentTechDocHelper } from './agent-tech-doc.helper';
import { AgentsController } from './agents.controller';
import { AgentExecutionController } from './agent-execution.controller';
import { AgentManagementController } from './agent-management.controller';
import { AgentScheduleController } from './agent-schedule.controller';
import { AgentRunsController } from './agent-runs.controller';
import { AgentOpenAICompatController } from './agent-openai-compat.controller';

import { LlmProvidersModule } from '../llm-providers/llm-providers.module';
import { ModelCatalogModule } from '../model-catalog/model-catalog.module';
import { AgentRolesService } from './agent-roles.service';
import { AgentReadinessService } from './agent-readiness.service';
import { AgentRolesController } from './agent-roles.controller';
import { StrategiesController } from './strategies/strategies.controller';
import { AgentExecutionSettingsController } from './agent-execution-settings.controller';
import { AgentAnthropicCompatController } from './agent-anthropic-compat.controller';
import { StrategyPipelineResolver } from './strategies/strategy-pipeline.resolver';
import { OrchestratorService } from './strategies/orchestrator.service';
import { Strategy } from '../../entities/strategy.entity';
import { AgentConstraintsModule } from '../agent-constraints/agent-constraints.module';
import { ToolsModule } from '../tools/tools.module';
import { ToolDiscoveryModule } from '../tool-discovery/tool-discovery.module';
import { CodeModeModule } from '../code-mode/code-mode.module';
import { MemoryModule } from '../memory/memory.module';
import { A2AModule } from '../a2a/a2a.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { BudgetsModule } from '../budgets/budgets.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Agent,
      AgentRole,
      Strategy,
      AgentExecution,
      AgentRun,
      Tool,
      LlmProvider,
      // The model pass-through: catalog cards, and the spend a pod's calls make.
      Model,
      HostedModelCall,
      Gateway,
      GatewayTool,
      User,
      Organization,
      ApiKey,
      Conversation,
      Message,
      ApprovalRequest,
      AgentFile,
      Workspace,
      AgentWake,
      AgentChannel,
      ConnectionGrant,
    ]),
    BullModule.registerQueue({ name: 'agent-scheduler' }),
    BullModule.registerQueue({ name: 'agent-runtime' }),
    forwardRef(() => LlmProvidersModule),
    // ModelRouterService is exported ONLY here. Without this import the
    // @Optional() router injections in AgentRolesService and
    // OrchestratorService resolve to undefined and every resolved role
    // answers "routing is not available on this install" -- a silence
    // that looked like a missing license rather than a missing import.
    forwardRef(() => ModelCatalogModule),
    forwardRef(() => ToolsModule),
    // ToolDiscoveryService answers search_tools and get_tool for agents in
    // discover mode (agent-tool-mode.ts); without it they rank by keywords only.
    forwardRef(() => ToolDiscoveryModule),
    // run_code for agents in the code tool mode, and the traces the run view reads.
    forwardRef(() => CodeModeModule),
    forwardRef(() => MemoryModule),
    forwardRef(() => A2AModule),
    forwardRef(() => ApprovalsModule),
    forwardRef(() => GatewaysModule),
    AuthorizationModule,
    AgentConstraintsModule,
    BudgetsModule,
  ],
  providers: [AgentApiAccessService, AgentReadinessService, AgentRunReaperService, AgentExecutionReaperService, OrchestratorService, StrategyPipelineResolver,
    AgentIdentityService, AgentIdentityReachService,
    AgentRolesService, AgentsService, AgentValidationHelper, AgentExecutionEngine, AgentExecutionStateHelper, CompatAgentInvoker, AgentOpenAIStreamHelper, AgentNodeExecutor, AgentTemplateResolver, AgentWebhookService, AgentSchedulerService, AgentAuditService, AgentRuntimeService, AgentRuntimeBuilders, AgentCollaborationHelper, AgentBuiltInToolsHelper, AlwaysOnService, AgentRuntimeEventsHelper, AgentRuntimeMiscHelper, AgentStepProcessor, AgentRuntimeProcessor, AgentSubAgentExecutors, AgentVerifierHelper, AgentContextCompactor, AgentTechDocHelper, AgentExecutionCancellationService,
    // Carries a workflow run on once the change sets its Code steps wait on are decided.
    WorkflowApprovalResumeService,
    // Personal data hidden in the traces runs store.
    RunTracePrivacyService,
    // Hosted pods' coding CLIs: their own calls, forwarded to an organization-wide provider.
    ModelPassThroughService],
  controllers: [AgentApiAccessController, AgentsController, AgentExecutionController, AgentManagementController, AgentScheduleController, AgentRunsController, AgentOpenAICompatController, AgentAnthropicCompatController, AgentRolesController, StrategiesController, AgentExecutionSettingsController, AlwaysOnController,
    AgentIdentityReachController,
    // The model pass-through's own routes: /v1/responses, /v1/messages/count_tokens (hosted pods only).
    ModelPassThroughController],
  exports: [AgentApiAccessService,
    AgentRolesService, AgentsService, AgentExecutionEngine, AgentRuntimeService, AgentExecutionCancellationService,
    // Channels and connections wake always-on agents through it.
    AlwaysOnService,
    AgentIdentityService],
})
export class AgentsModule {}
