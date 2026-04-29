import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  CONTENT_FORMAT_VALUES,
  CREATED_BY_VALUES,
  ContentFormat,
  CreatedBy,
  Mode,
  MODE_VALUES,
  Provenance,
  ScopeType,
  SCOPE_TYPE_VALUES,
  Tier,
  TIER_VALUES,
} from './canonical.types';

/**
 * HTTP boundary DTOs (class-validator). The internal MemoryItem
 * shape is a plain TS interface; these DTOs validate the wire form
 * and the controller maps them into the service's PutInput.
 */

class ProvenanceDto implements Provenance {
  @ApiProperty({ nullable: true })
  @IsOptional()
  @IsString()
  agent_id: string | null = null;

  @ApiProperty({ nullable: true })
  @IsOptional()
  @IsString()
  session_id: string | null = null;

  @ApiProperty({ nullable: true })
  @IsOptional()
  @IsString()
  collab_id: string | null = null;

  @ApiProperty({ nullable: true })
  @IsOptional()
  @IsString()
  model: string | null = null;

  @ApiProperty({ nullable: true })
  @IsOptional()
  @IsString()
  provider: string | null = null;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  tool_chain: string[] = [];

  @ApiProperty({ enum: CREATED_BY_VALUES })
  @IsEnum(CREATED_BY_VALUES as readonly string[])
  created_by: CreatedBy;

  @ApiProperty({ nullable: true })
  @IsOptional()
  @IsString()
  source_backend: string | null = null;
}

class ScopeRefDto {
  @ApiProperty({ enum: SCOPE_TYPE_VALUES })
  @IsEnum(SCOPE_TYPE_VALUES as readonly string[])
  scope_type: ScopeType;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  scope_id: string;
}

export class PutMemoryDto {
  @ApiProperty({ enum: MODE_VALUES })
  @IsEnum(MODE_VALUES as readonly string[])
  mode: Mode;

  @ApiProperty({ type: ScopeRefDto })
  @ValidateNested()
  @Type(() => ScopeRefDto)
  scope: ScopeRefDto;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  content: string;

  @ApiPropertyOptional({ enum: CONTENT_FORMAT_VALUES })
  @IsOptional()
  @IsEnum(CONTENT_FORMAT_VALUES as readonly string[])
  content_format?: ContentFormat;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  file_refs?: string[];

  @ApiPropertyOptional({ enum: TIER_VALUES })
  @IsOptional()
  @IsEnum(TIER_VALUES as readonly string[])
  tier?: Tier;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  ttl_seconds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  source_uri?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  source_version?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  source_checksum?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  chunk_index?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  chunk_total?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  chunk_of?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @ApiProperty({ type: ProvenanceDto })
  @ValidateNested()
  @Type(() => ProvenanceDto)
  provenance: ProvenanceDto;
}

export class SearchMemoryDto {
  @ApiProperty({ type: ScopeRefDto })
  @ValidateNested()
  @Type(() => ScopeRefDto)
  scope: ScopeRefDto;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  query: string;

  @ApiPropertyOptional({ enum: MODE_VALUES })
  @IsOptional()
  @IsEnum(MODE_VALUES as readonly string[])
  mode?: Mode;

  @ApiPropertyOptional({ enum: TIER_VALUES })
  @IsOptional()
  @IsEnum(TIER_VALUES as readonly string[])
  tier?: Tier;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  top_k?: number;

  @ApiPropertyOptional()
  @IsOptional()
  fts_only?: boolean;
}

export class ListMemoryDto {
  @ApiProperty({ type: ScopeRefDto })
  @ValidateNested()
  @Type(() => ScopeRefDto)
  scope: ScopeRefDto;

  @ApiPropertyOptional({ enum: MODE_VALUES })
  @IsOptional()
  @IsEnum(MODE_VALUES as readonly string[])
  mode?: Mode;

  @ApiPropertyOptional({ enum: TIER_VALUES })
  @IsOptional()
  @IsEnum(TIER_VALUES as readonly string[])
  tier?: Tier;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  include_superseded?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  include_deleted?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class SupersedeMemoryDto {
  @ApiProperty({ type: PutMemoryDto })
  @ValidateNested()
  @Type(() => PutMemoryDto)
  new_item: PutMemoryDto;
}
