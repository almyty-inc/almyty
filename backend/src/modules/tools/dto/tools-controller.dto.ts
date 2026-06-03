import { IsString, IsOptional, IsEnum, IsArray, IsObject, IsNumber, Min, Max, MaxLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';

import { ToolType, ToolStatus, ToolExecutionMethod } from '../../../entities/tool.entity';

export class CreateToolBodyDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsString()
  @MaxLength(1000)
  description: string;

  @IsEnum(ToolType)
  type: ToolType;

  @IsObject()
  parameters: Record<string, any>;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsEnum(ToolExecutionMethod)
  executionMethod?: ToolExecutionMethod;

  @IsOptional()
  @IsObject()
  authConfig?: any;

  @IsOptional()
  @IsObject()
  configuration?: {
    timeout?: number;
    retries?: number;
    cache?: {
      enabled: boolean;
      ttl?: number;
    };
    rateLimit?: {
      requestsPerMinute?: number;
      requestsPerHour?: number;
    };
  };

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsString()
  operationId?: string;

  @IsOptional()
  @IsString()
  inputSchemaId?: string;

  @IsOptional()
  @IsString()
  outputSchemaId?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  // SDK tool fields. Tool.sdkConfig is the structured assembly
  // recipe the executor's sdk-code-assembler reads to build the
  // sandboxed JS that imports the npm package and calls into it;
  // tool.dependencies pins the exact version range. Without these
  // whitelisted on the DTO, ValidationPipe drops them and
  // SDK-type tools can't be created via the public API at all
  // (the executor + entity model are wired but the surface
  // wasn't). Both are arbitrary-shape JSON — the assembler
  // validates structure server-side via SdkConfig types.
  @IsOptional()
  @IsObject()
  sdkConfig?: any;

  @IsOptional()
  @IsObject()
  dependencies?: Record<string, string>;

  // Protocol-specific execution configs. Each entity column accepts
  // an arbitrary-shape JSON object; the executor (tool-protocol +
  // tool-grpc + tool-script) validates structure server-side via the
  // GraphqlConfig / SoapConfig / GrpcConfig / HttpConfig interfaces.
  // Without these on the whitelist, ValidationPipe drops them and
  // non-HTTP tool types cannot be created via the public REST API.
  @IsOptional()
  @IsObject()
  httpConfig?: any;

  @IsOptional()
  @IsObject()
  llmConfig?: any;

  @IsOptional()
  @IsObject()
  graphqlConfig?: any;

  @IsOptional()
  @IsObject()
  soapConfig?: any;

  @IsOptional()
  @IsObject()
  grpcConfig?: any;

  @IsOptional()
  @IsArray()
  examples?: Array<{ name: string; description?: string; input: Record<string, any>; expectedOutput?: any }>;

  // Team-scoping fields sent by the dashboard create/update dialogs.
  // The VisibilityField component always emits both; without these
  // entries on the whitelist the ValidationPipe 400s the request.
  @IsOptional()
  @IsEnum(['org', 'team'])
  visibility?: 'org' | 'team';

  @IsOptional()
  @IsString()
  teamId?: string | null;
}

export class UpdateToolBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsObject()
  parameters?: Record<string, any>;

  @IsOptional()
  @IsObject()
  configuration?: {
    timeout?: number;
    retries?: number;
    cache?: {
      enabled: boolean;
      ttl?: number;
    };
    rateLimit?: {
      requestsPerMinute?: number;
      requestsPerHour?: number;
    };
  };

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  // SDK tool fields — same rationale as CreateToolBodyDto.
  @IsOptional()
  @IsObject()
  sdkConfig?: any;

  @IsOptional()
  @IsObject()
  dependencies?: Record<string, string>;

  // Protocol-specific execution configs — same rationale as CreateToolBodyDto.
  @IsOptional()
  @IsObject()
  httpConfig?: any;

  @IsOptional()
  @IsObject()
  llmConfig?: any;

  @IsOptional()
  @IsObject()
  graphqlConfig?: any;

  @IsOptional()
  @IsObject()
  soapConfig?: any;

  @IsOptional()
  @IsObject()
  grpcConfig?: any;

  @IsOptional()
  @IsArray()
  examples?: Array<{ name: string; description?: string; input: Record<string, any>; expectedOutput?: any }>;

  // Team-scoping fields sent by the dashboard create/update dialogs.
  // The VisibilityField component always emits both; without these
  // entries on the whitelist the ValidationPipe 400s the request.
  @IsOptional()
  @IsEnum(['org', 'team'])
  visibility?: 'org' | 'team';

  @IsOptional()
  @IsString()
  teamId?: string | null;
}

export class GenerateToolsFromApiDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  includeOperations?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludeOperations?: string[];

  @IsOptional()
  @IsString()
  namePrefix?: string;

  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(300000)
  defaultTimeout?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  defaultRetries?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoryIds?: string[];
}

export class ExecuteToolDto {
  @IsObject()
  parameters: Record<string, any>;

  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(300000)
  timeout?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  retries?: number;

  @IsOptional()
  skipCache?: boolean;

  @IsOptional()
  skipRateLimit?: boolean;
}

export class ToolSearchQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(ToolType)
  type?: ToolType;

  @IsOptional()
  @IsEnum(ToolStatus)
  status?: ToolStatus;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => typeof value === 'string' ? value.split(',') : value)
  categoryIds?: string[];

  @IsOptional()
  @IsString()
  apiId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => typeof value === 'string' ? value.split(',') : value)
  tags?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsEnum(['name', 'createdAt', 'updatedAt', 'usage'])
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'usage';

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}
