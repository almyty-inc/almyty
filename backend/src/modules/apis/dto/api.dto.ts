import { IsString, IsOptional, IsEnum, IsObject, IsNumber, IsBoolean, ValidateNested, Matches } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiType } from '../../../entities/api.entity';

const stripHtml = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim() : value;

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
  @Transform(stripHtml)
  @IsString()
  name: string;

  @Transform(stripHtml)
  @IsOptional()
  @IsString()
  description?: string;

  @Matches(/^https?:\/\/.+/, { message: 'baseUrl must be a valid HTTP or HTTPS URL' })
  @IsString()
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
  @Transform(stripHtml)
  @IsOptional()
  @IsString()
  name?: string;

  @Transform(stripHtml)
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Matches(/^https?:\/\/.+/, { message: 'baseUrl must be a valid HTTP or HTTPS URL' })
  @IsString()
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
  @Matches(/^https?:\/\/.+/, { message: 'schemaUrl must be a valid HTTP or HTTPS URL' })
  @IsString()
  schemaUrl?: string;

  @Transform(stripHtml)
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  generateTools?: boolean;
}