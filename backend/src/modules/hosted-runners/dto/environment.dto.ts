import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { RESOURCE_VISIBILITIES, ResourceVisibility } from '../../../common/authorization/access-policy.service';
import { RunnerConfigDto, RunnerRuntimeInfoDto } from '../../runner/dto/register-runner.dto';

/** Lowercase, starts with a letter: an environment's name becomes part of tool names (`env.<name>.*`). */
export const ENVIRONMENT_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const NAME_MESSAGE = 'name must be lowercase letters, digits and dashes, starting with a letter, at most 64 characters';

/** An environment variable a binding may set: upper-case, not one almyty sets itself. */
export const ENV_VAR_RE = /^(?!ALMYTY_)(?!HOME$)(?!PATH$)[A-Z_][A-Z0-9_]{0,127}$/;

export class EnvironmentRepoDto {
  @IsString()
  @MaxLength(2048)
  @Matches(/^https:\/\//, { message: 'repo.url must be an https URL' })
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  ref?: string | null;

  @IsOptional()
  @IsUUID()
  connectionId?: string | null;
}

export class EnvironmentImageDto {
  /** A curated image name from the install's settings (`images`). */
  @IsString()
  @MaxLength(64)
  base!: string;
}

export class EnvironmentEnvBindingDto {
  @IsUUID()
  connectionId!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z_][A-Za-z0-9_.-]*$/, { message: 'field must name a field of the connection' })
  field!: string;

  @IsString()
  @Matches(ENV_VAR_RE, { message: 'envVar must be upper-case letters, digits and underscores, and not ALMYTY_*, HOME or PATH' })
  envVar!: string;
}

export class EnvironmentCacheDto {
  @IsArray()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  paths!: string[];
}

export class EnvironmentEgressDto {
  @IsArray()
  @IsString({ each: true })
  @MaxLength(253, { each: true })
  allowHosts!: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  allowBinaries?: string[];
}

class EnvironmentFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => EnvironmentRepoDto)
  repo?: EnvironmentRepoDto | null;

  @IsOptional()
  @IsString()
  @MaxLength(65536)
  setupScript?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EnvironmentEnvBindingDto)
  envBindings?: EnvironmentEnvBindingDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => EnvironmentCacheDto)
  cache?: EnvironmentCacheDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => EnvironmentEgressDto)
  egress?: EnvironmentEgressDto;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  resourceClass?: string;

  /** Within the install's bounds (settings `idleTimeoutMinutes`); refused outside them. */
  @IsOptional()
  @IsInt()
  @Min(1)
  idleTimeoutMinutes?: number;

  /** The organization's own cluster. Not offered yet: refused unless empty. */
  @IsOptional()
  @IsUUID()
  clusterConnectionId?: string | null;

  /** `team` and `org` need the hosted_shared_environments entitlement (Business). */
  @IsOptional()
  @IsEnum(RESOURCE_VISIBILITIES)
  visibility?: ResourceVisibility;

  @IsOptional()
  @IsUUID()
  teamId?: string | null;
}

export class CreateEnvironmentDto extends EnvironmentFieldsDto {
  @IsString()
  @Matches(ENVIRONMENT_NAME_RE, { message: NAME_MESSAGE })
  name!: string;

  @ValidateNested()
  @Type(() => EnvironmentImageDto)
  image!: EnvironmentImageDto;
}

export class UpdateEnvironmentDto extends EnvironmentFieldsDto {
  @IsOptional()
  @IsString()
  @Matches(ENVIRONMENT_NAME_RE, { message: NAME_MESSAGE })
  name?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => EnvironmentImageDto)
  image?: EnvironmentImageDto;
}

/** POST /runners/enroll: what a hosted runner pod sends, with its single-use token. */
export class EnrollRunnerDto {
  @IsString()
  @MaxLength(256)
  token!: string;

  @ValidateNested()
  @Type(() => RunnerRuntimeInfoDto)
  runtimeInfo!: RunnerRuntimeInfoDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => RunnerConfigDto)
  config?: RunnerConfigDto;
}
