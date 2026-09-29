import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

import { AppAuthMode } from '../../../entities/agent-app.entity';
import { DistributionTarget } from '../../../entities/agent-app-distribution.entity';
import type { MacPackaging } from '../build-targets';
import { BUILD_VERSION_INVALID, BUILD_VERSION_PATTERN, MAX_BUILD_VERSION_LENGTH } from '../agent-app.rules';

/**
 * The /apps write bodies, as classes.
 *
 * `CreateAppDto`, `UpdateAppDto` and `RequestBuildDto` were interfaces
 * exported from the services. An interface has no runtime representation,
 * so `design:paramtype` for the `@Body()` parameter was `Object` and the
 * global ValidationPipe returned the raw body untouched: none of
 * `whitelist`, `forbidNonWhitelisted` or any decorator applied. A POST
 * /apps with no `slug` reached `dto.slug.trim()` and came back as a 500
 * rather than a 400, and every extra property in the body was carried
 * into `appRepository.create()`.
 *
 * The nested config objects stay `@IsObject()` rather than
 * `@ValidateNested()`, matching CreateGatewayBodyDto next door: the
 * shapes are open-ended json the services read defensively, and turning
 * them into validated classes would start rejecting keys that are
 * currently stored.
 */
export class CreateAppBodyDto {
  @ApiProperty({ description: 'App name shown to end users' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ description: 'URL-safe identifier; validated again by appSlugError' })
  @IsString()
  @MaxLength(255)
  slug: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  agentIds?: string[];

  @ApiPropertyOptional({ description: 'Presentation shared by every distribution' })
  @IsOptional()
  @IsObject()
  branding?: Record<string, any>;

  @ApiPropertyOptional({ enum: AppAuthMode })
  @IsOptional()
  @IsEnum(AppAuthMode)
  authMode?: AppAuthMode;

  @ApiPropertyOptional({ description: 'What a distributed artifact may do on the machine it runs on' })
  @IsOptional()
  @IsObject()
  capabilities?: Record<string, any>;

  @ApiPropertyOptional({ nullable: true, description: 'What a stranger is allowed to cost' })
  @IsOptional()
  @IsObject()
  limits?: Record<string, any> | null;

  @ApiPropertyOptional({ nullable: true, description: 'Visitor data controls and retention' })
  @IsOptional()
  @IsObject()
  privacy?: Record<string, any> | null;
}

/** PATCH /apps/:slug. Every create field optional, plus the active flag. */
export class UpdateAppBodyDto extends PartialType(CreateAppBodyDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** POST /apps/:slug/builds. */
export class RequestBuildBodyDto {
  @ApiProperty({ enum: DistributionTarget })
  @IsEnum(DistributionTarget)
  target: DistributionTarget;

  @ApiProperty({ description: 'Build platform, checked again against platformsFor(target)' })
  @IsString()
  @MaxLength(64)
  platform: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_BUILD_VERSION_LENGTH)
  @Matches(BUILD_VERSION_PATTERN, { message: BUILD_VERSION_INVALID })
  version?: string;

  @ApiPropertyOptional({ enum: ['zip', 'dmg'] })
  @IsOptional()
  @IsIn(['zip', 'dmg'])
  macPackaging?: MacPackaging;
}

/**
 * POST /apps/:slug/distributions/:target/build: what a build on the
 * customer's own machine produced.
 *
 * This body was an inline type, so the global ValidationPipe saw `Object`
 * and passed it through whole: any field, of any type and size, was
 * spread into the distribution's `lastBuild` and stored.
 */
export class RecordBuildBodyDto {
  @ApiPropertyOptional({ example: '1.2.3' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_BUILD_VERSION_LENGTH)
  @Matches(BUILD_VERSION_PATTERN, { message: BUILD_VERSION_INVALID })
  version?: string;

  @ApiPropertyOptional({ example: 'darwin-arm64' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9_-]*$/i, { message: 'platform is letters, digits, dashes and underscores' })
  platform?: string;

  @ApiPropertyOptional({ description: "The artifact's digest, hex or base64, optionally prefixed with its algorithm" })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  @Matches(/^[A-Za-z0-9:+/=_.-]+$/, { message: 'checksum is a hex or base64 digest' })
  checksum?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  signed?: boolean;

  @ApiPropertyOptional({ description: 'Why the build failed, when it did' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error?: string;
}
