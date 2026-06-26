import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';

import { RunnerIsolationTier } from '../../../entities/runner.entity';

export class DetectedCodingAgentDto {
  @IsString()
  @MaxLength(64)
  id!: string;

  @IsString()
  @MaxLength(120)
  displayName!: string;

  @IsString()
  @MaxLength(120)
  binary!: string;

  @IsString()
  @MaxLength(120)
  resolvedBinary!: string;

  @IsString()
  @MaxLength(255)
  version!: string;

  @IsString()
  @MaxLength(64)
  providerFamily!: string;

  @IsBoolean()
  supportsMcp!: boolean;

  @IsBoolean()
  canManage!: boolean;
}

export class RunnerRuntimeInfoDto {
  @IsString()
  @MaxLength(32)
  os!: string;

  @IsString()
  @MaxLength(32)
  arch!: string;

  @IsString()
  @MaxLength(255)
  hostname!: string;

  @IsInt()
  @Min(1)
  @Max(1024)
  cpuCount!: number;

  @IsInt()
  @Min(0)
  memoryMb!: number;

  @IsString()
  @MaxLength(64)
  runnerVersion!: string;

  @IsObject()
  binaries!: Record<string, string | null>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DetectedCodingAgentDto)
  codingAgents?: DetectedCodingAgentDto[];
}

export class RunnerConfigDto {
  @IsEnum(RunnerIsolationTier)
  defaultIsolation!: RunnerIsolationTier;

  @IsInt()
  @Min(1)
  @Max(1024)
  maxConcurrent!: number;

  @IsArray()
  @IsString({ each: true })
  allowedCwdRoots!: string[];

  @IsArray()
  @IsString({ each: true })
  denyPatterns!: string[];

  @IsBoolean()
  networkBlocked!: boolean;

  @IsBoolean()
  installBlocked!: boolean;
}

export class RegisterRunnerDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsObject()
  labels!: Record<string, string>;

  @ValidateNested()
  @Type(() => RunnerRuntimeInfoDto)
  runtimeInfo!: RunnerRuntimeInfoDto;

  @ValidateNested()
  @Type(() => RunnerConfigDto)
  config!: RunnerConfigDto;

  @IsOptional()
  @IsEnum(['org', 'team'])
  visibility?: 'org' | 'team';

  @IsOptional()
  @IsUUID()
  teamId?: string | null;
}
