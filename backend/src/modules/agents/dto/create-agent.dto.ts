import { IsString, IsOptional, IsObject, IsEnum, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AgentStatus } from '../../../entities/agent.entity';

export class CreateAgentDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(AgentStatus)
  status?: AgentStatus;

  @IsOptional()
  @IsString()
  version?: string;

  @IsObject()
  pipeline: {
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
  @IsObject()
  variables?: Record<string, any>;

  @IsOptional()
  @IsObject()
  settings?: Record<string, any>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
