import { IsArray, IsBoolean, IsEnum, IsNumber, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';

import { GatewayKind, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';

export class CreateGatewayBodyDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(GatewayType)
  type: GatewayType;

  @IsOptional()
  @IsString()
  agentId?: string;

  @IsString()
  endpoint: string;

  @IsObject()
  configuration: Record<string, any>;

  @IsOptional()
  @IsObject()
  rateLimitConfig?: {
    enabled: boolean;
    requestsPerMinute?: number;
    requestsPerHour?: number;
    requestsPerDay?: number;
    burstLimit?: number;
    windowSize?: number;
  };

  @IsOptional()
  @IsObject()
  corsConfig?: {
    origins: string[];
    methods: string[];
    allowedHeaders: string[];
    credentials: boolean;
  };

  @IsOptional()
  @IsObject()
  webhooks?: {
    enabled: boolean;
    endpoints: Array<{
      url: string;
      events: string[];
      secret?: string;
    }>;
  };

  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(300000)
  requestTimeout?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  maxRetries?: number;

  @IsOptional()
  @IsObject()
  customHeaders?: Record<string, string>;

  @IsOptional()
  @IsObject()
  healthCheck?: {
    enabled: boolean;
    endpoint?: string;
    interval?: number;
    timeout?: number;
  };

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class UpdateGatewayBodyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  endpoint?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsObject()
  configuration?: Record<string, any>;

  @IsOptional()
  @IsObject()
  rateLimitConfig?: {
    enabled: boolean;
    requestsPerMinute?: number;
    requestsPerHour?: number;
    requestsPerDay?: number;
    burstLimit?: number;
    windowSize?: number;
  };

  @IsOptional()
  @IsObject()
  corsConfig?: {
    origins: string[];
    methods: string[];
    allowedHeaders: string[];
    credentials: boolean;
  };

  @IsOptional()
  @IsObject()
  webhooks?: {
    enabled: boolean;
    endpoints: Array<{
      url: string;
      events: string[];
      secret?: string;
    }>;
  };

  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(300000)
  requestTimeout?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  maxRetries?: number;

  @IsOptional()
  @IsObject()
  customHeaders?: Record<string, string>;

  @IsOptional()
  @IsObject()
  healthCheck?: {
    enabled: boolean;
    endpoint?: string;
    interval?: number;
    timeout?: number;
  };

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class GatewaySearchQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(GatewayType)
  type?: GatewayType;

  @IsOptional()
  @IsEnum(GatewayStatus)
  status?: GatewayStatus;

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
  @IsEnum(['name', 'createdAt', 'updatedAt', 'totalRequests'])
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'totalRequests';

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

