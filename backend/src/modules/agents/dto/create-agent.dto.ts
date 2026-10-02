import { IsString, IsOptional, IsObject, IsEnum, IsArray, MaxLength } from 'class-validator';
import { RESOURCE_VISIBILITIES, ResourceVisibility } from '../../../common/authorization/access-policy.service';
import { Transform } from 'class-transformer';
import { AgentStatus } from '../../../entities/agent.entity';
import type { AgentCollaboration } from '../collaboration-participants';
import type { AgentModels } from '../autonomous-models';
import type { AgentMemoryConfig } from '../agent-memory-settings';
import type { CodeModeConfig } from '../../code-mode/code-write-policy';

import { stripHtmlTransform as stripHtml } from '../../../common/security/strip-tags';

export class CreateAgentDto {
  @Transform(stripHtml)
  @IsString()
  @MaxLength(100)
  name: string;

  @Transform(stripHtml)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsEnum(AgentStatus)
  status?: AgentStatus;

  @IsOptional()
  @IsString()
  version?: string;

  @IsOptional()
  @IsEnum(['workflow', 'autonomous'])
  mode?: 'workflow' | 'autonomous';

  @IsOptional()
  @IsObject()
  pipeline?: {
    nodes: Array<{
      id: string;
      type: string;
      label?: string;
      config: Record<string, any>;
      position?: { x: number; y: number };
    }>;
    edges: Array<{
      id: string;
      source: string;
      target: string;
      label?: string;
      condition?: string;
    }>;
  };

  @IsOptional()
  @IsString()
  instructions?: string;

  @IsOptional()
  @IsString()
  personality?: string;

  @IsOptional()
  @IsObject()
  heartbeat?: {
    enabled: boolean;
    intervalMinutes: number;
    prompt: string;
  };

  @IsOptional()
  @IsArray()
  toolIds?: string[];

  @IsOptional()
  @IsObject()
  modelConfig?: {
    providerId?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };

  @IsOptional()
  @IsObject()
  // Shape checked in AgentsService (memoryConfigProblems), which names each problem.
  memoryConfig?: AgentMemoryConfig;

  @IsOptional()
  @IsObject()
  agentConfig?: {
    canCallAgents?: boolean;
    /** The other agents it may call (agent-capabilities.ts). */
    callableAgentIds?: string[];
    /** APIs it may use: every active tool of each, including later ones. */
    apiIds?: string[];
    canCreateAgents?: boolean;
    maxTemporaryAgents?: number;
    maxTemporaryAgentsAlive?: number;
    /** Machine label requirements, as `gpu=yes, os=mac` or an object; see Agent.agentConfig. */
    runnerLabels?: Record<string, string> | string;
    /** The one runner its runner tools run on; null or absent for any of the caller's runners. */
    runnerId?: string | null;
    /** How the model sees its tools (agent-tool-mode.ts); checked by toolModeProblems. */
    toolMode?: 'direct' | 'discover' | 'code' | 'auto';
    toolModeThresholdTokens?: number;
    pinnedToolIds?: string[];
    /** run_code's write policy, grants and extract() model (code-mode/code-write-policy.ts); checked by codeModeProblems. */
    codeMode?: CodeModeConfig;
  };

  // Shape checked in AgentsService (collaborationProblems) so a bad
  // participant is refused with a sentence naming it.
  @IsOptional()
  @IsObject()
  collaboration?: AgentCollaboration | null;

  // An autonomous agent's roles and strategy. Shape checked in
  // AgentsService (agentModelsProblems), which names each problem.
  @IsOptional()
  @IsObject()
  models?: AgentModels | null;

  @IsOptional()
  @IsObject()
  variables?: Record<string, any>;

  @IsOptional()
  @IsObject()
  settings?: Record<string, any>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @IsOptional()
  @IsString()
  webhookUrl?: string;

  // Team-scoping fields sent by the dashboard create/update dialogs.
  // The VisibilityField component always emits both; without these
  // entries on the whitelist the ValidationPipe 400s the request.
  @IsOptional()
  @IsEnum(RESOURCE_VISIBILITIES)
  visibility?: ResourceVisibility;

  @IsOptional()
  @IsString()
  teamId?: string | null;
}
