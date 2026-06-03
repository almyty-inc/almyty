import { IsString, IsOptional, IsEnum, IsObject, IsNumber, IsBoolean, ValidateNested, Matches, MaxLength } from 'class-validator';
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
  @MaxLength(100)
  name: string;

  @Transform(stripHtml)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
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

  // Team-scoping. The dashboard's Connect-API dialog always sends
  // these (defaulting visibility='org' / teamId=null) so omitting them
  // from the whitelist made every UI-driven create return 400 with
  // "property visibility should not exist; property teamId should not
  // exist". The entity columns already exist; the gap was only in the
  // DTO validator.
  @IsOptional()
  @IsEnum(['org', 'team'])
  visibility?: 'org' | 'team';

  @IsOptional()
  @IsString()
  teamId?: string | null;
}

export class UpdateApiDto {
  @Transform(stripHtml)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @Transform(stripHtml)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
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

  // Same team-scoping fields on update so the edit dialog works too.
  @IsOptional()
  @IsEnum(['org', 'team'])
  visibility?: 'org' | 'team';

  @IsOptional()
  @IsString()
  teamId?: string | null;
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
export class CreateHttpApiDto {
  @Transform(stripHtml)
  @IsString()
  @MaxLength(100)
  name!: string;

  @Matches(/^https?:\/\/.+/, { message: 'baseUrl must be a valid HTTP or HTTPS URL' })
  @IsString()
  @MaxLength(2048)
  baseUrl!: string;

  @Transform(stripHtml)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

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
  @IsEnum(['org', 'team'])
  visibility?: 'org' | 'team';

  @IsOptional()
  @IsString()
  teamId?: string | null;
}

export class CreateSdkApiDto {
  @Transform(stripHtml)
  @IsString()
  @MaxLength(100)
  name!: string;

  @Transform(stripHtml)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  // Map of npm package name -> version range. Validated by the
  // installer at import time; the DTO just bounds shape.
  @IsObject()
  dependencies!: Record<string, string>;

  @IsOptional()
  @IsObject()
  npmRegistry?: Record<string, any>;

  @IsOptional()
  @IsEnum(['org', 'team'])
  visibility?: 'org' | 'team';

  @IsOptional()
  @IsString()
  teamId?: string | null;
}
