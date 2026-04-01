import { IsString, IsOptional, IsObject, IsEnum, IsArray, IsUrl } from 'class-validator';
import { Transform } from 'class-transformer';
import { AgentStatus } from '../../../entities/agent.entity';

const stripHtml = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim() : value;

export class UpdateAgentDto {
  @Transform(stripHtml)
  @IsOptional()
  @IsString()
  name?: string;

  @Transform(stripHtml)
  @IsOptional()
  @IsString()
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
  memoryConfig?: {
    enabled?: boolean;
    autoSave?: boolean;
    scopes?: string[];
  };

  @IsOptional()
  @IsObject()
  agentConfig?: {
    canCallAgents?: boolean;
    canCreateAgents?: boolean;
  };

  @IsOptional()
  @IsObject()
  collaboration?: {
    strategy: 'sequential' | 'parallel' | 'race' | 'debate';
    agents: { agentId: string; role?: string }[];
    judgeAgentId?: string;
    maxRounds?: number;
  };

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
}
