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
  Matches,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';

import { RunnerIsolationTier } from '../../../entities/runner.entity';
import {
  RESOURCE_VISIBILITIES,
  ResourceVisibility,
} from '../../../common/authorization/access-policy.service';

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

const RUNNER_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const RUNNER_NAME_MESSAGE = 'name must match [a-zA-Z0-9_-]{1,64}';

export class RegisterRunnerDto {
  // The accepted name is `[a-zA-Z0-9_-]{1,64}`: it is published as part
  // of a runner's capability tool names and shown in `/runners`, so it
  // stays a single safe token. RunnerService.register enforces the same
  // rule (it is the contract, not a nicety); declaring it here too means
  // a bad name is refused by the validation pipe with a field-level
  // error instead of a bare 400 from the service.
  @IsString()
  @MaxLength(64)
  @Matches(RUNNER_NAME_RE, { message: RUNNER_NAME_MESSAGE })
  name!: string;

  @IsOptional()
  @IsObject()
  labels?: Record<string, string>;

  @ValidateNested()
  @Type(() => RunnerRuntimeInfoDto)
  runtimeInfo!: RunnerRuntimeInfoDto;

  @ValidateNested()
  @Type(() => RunnerConfigDto)
  config!: RunnerConfigDto;

  @IsOptional()
  @IsEnum(RESOURCE_VISIBILITIES)
  visibility?: ResourceVisibility;

  @IsOptional()
  @IsUUID()
  teamId?: string | null;
}

/** POST /runners: the pending record the web setup page creates. */
export class CreateRunnerDto {
  @IsString()
  @MaxLength(64)
  @Matches(RUNNER_NAME_RE, { message: RUNNER_NAME_MESSAGE })
  name!: string;

  @IsOptional()
  @IsObject()
  labels?: Record<string, string>;

  @IsOptional()
  @IsEnum(RESOURCE_VISIBILITIES)
  visibility?: ResourceVisibility;

  @IsOptional()
  @IsUUID()
  teamId?: string | null;
}

/** PATCH /runners/:id. The name only changes while the runner has never connected. */
export class UpdateRunnerDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(RUNNER_NAME_RE, { message: RUNNER_NAME_MESSAGE })
  name?: string;

  @IsOptional()
  @IsObject()
  labels?: Record<string, string>;

  @IsOptional()
  @IsEnum(RESOURCE_VISIBILITIES)
  visibility?: ResourceVisibility;

  @IsOptional()
  @IsUUID()
  teamId?: string | null;
}