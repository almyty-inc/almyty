import { IsString, IsOptional, IsEnum, IsObject, IsNumber, IsUrl, IsBoolean, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiType } from '../../../entities/api.entity';

export class AuthenticationConfigDto {
  @IsEnum(['none', 'api_key', 'bearer', 'basic', 'oauth2'])
  type: 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2';

  @IsObject()
  config: Record<string, any>;
}

export class RateLimitsDto {
  @IsOptional()
  @IsNumber()
  requestsPerSecond?: number;

  @IsOptional()
  @IsNumber()
  requestsPerMinute?: number;

  @IsOptional()
  @IsNumber()
  requestsPerHour?: number;
}

export class CreateApiDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsUrl()
  baseUrl: string;

  @IsOptional()
  @IsString()
  version?: string;

  @IsEnum(ApiType)
  type: ApiType;

  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsOptional()
  @ValidateNested()
  @Type(() => AuthenticationConfigDto)
  authentication?: AuthenticationConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => RateLimitsDto)
  rateLimits?: RateLimitsDto;

  @IsOptional()
  @IsNumber()
  timeoutMs?: number;

  @IsOptional()
  @IsNumber()
  retryAttempts?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class UpdateApiDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUrl()
  baseUrl?: string;

  @IsOptional()
  @IsString()
  version?: string;

  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsOptional()
  @ValidateNested()
  @Type(() => AuthenticationConfigDto)
  authentication?: AuthenticationConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => RateLimitsDto)
  rateLimits?: RateLimitsDto;

  @IsOptional()
  @IsNumber()
  timeoutMs?: number;

  @IsOptional()
  @IsNumber()
  retryAttempts?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class ImportSchemaDto {
  @IsOptional()
  @IsString()
  schemaContent?: string;

  @IsOptional()
  @IsUrl()
  schemaUrl?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  generateTools?: boolean;
}