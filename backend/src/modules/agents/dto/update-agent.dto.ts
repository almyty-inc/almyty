import { IsString, IsOptional, IsObject, IsEnum, IsUrl } from 'class-validator';
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
