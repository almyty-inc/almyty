import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { ChannelType } from '../../../entities/agent-channel.entity';
import type { MacPackaging } from '../build-targets';
import { BUILD_VERSION_INVALID, BUILD_VERSION_PATTERN, MAX_BUILD_VERSION_LENGTH } from '../channel-rules';

/**
 * The write bodies of an agent's channels and public settings, as classes
 * so the global ValidationPipe applies (whitelist, forbidNonWhitelisted).
 *
 * The nested objects stay `@IsObject()` rather than `@ValidateNested()`:
 * they are open json the service normalises field by field
 * (normalizeBranding, normalizeVisitorRules, splitChannelSecrets).
 */
export class AddChannelBodyDto {
  @ApiProperty({ enum: ChannelType })
  @IsEnum(ChannelType)
  type: ChannelType;

  @ApiPropertyOptional({ description: "The web chat's address, or a download's file name. Made from the agent's name when left out." })
  @IsOptional()
  @IsString()
  @MaxLength(63)
  slug?: string;

  @ApiPropertyOptional({ description: 'Platform settings and keys. Keys are moved to a credential, never stored here.' })
  @IsOptional()
  @IsObject()
  configuration?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Take the platform keys from this credential instead', nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  credentialId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: "Overrides of the agent's branding" })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsObject()
  branding?: Record<string, any> | null;

  @ApiPropertyOptional({ nullable: true, description: "Overrides of the agent's visitor rules" })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsObject()
  visitorRules?: Record<string, any> | null;
}

export class UpdateChannelBodyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  configuration?: Record<string, any>;

  @ApiPropertyOptional({ nullable: true, description: 'A credential to take the keys from; null stops using one' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  credentialId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: "Overrides of the agent's branding; null inherits all of it" })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsObject()
  branding?: Record<string, any> | null;

  @ApiPropertyOptional({ nullable: true, description: "Overrides of the agent's visitor rules; null inherits all of them" })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsObject()
  visitorRules?: Record<string, any> | null;
}

/** PATCH /agents/:agentId/public-settings. */
export class PublicSettingsBodyDto {
  @ApiPropertyOptional({ nullable: true, description: 'Name, colours, logo and greeting' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsObject()
  branding?: Record<string, any> | null;

  @ApiPropertyOptional({ nullable: true, description: 'Sign-in, limits, spend caps, retention, visitor rights' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsObject()
  visitorRules?: Record<string, any> | null;
}

/** POST /agents/:agentId/channels/:channelId/builds. */
export class RequestBuildBodyDto {
  @ApiProperty({ description: 'Build platform, checked again against platformsFor(type)' })
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
 * POST /agents/:agentId/channels/:channelId/build-record: what a build on
 * the customer's own machine produced.
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
