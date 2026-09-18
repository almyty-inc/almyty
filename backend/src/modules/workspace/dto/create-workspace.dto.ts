import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

import { RunnerIsolationTier } from '../../../entities/runner.entity';

/**
 * Body of POST /workspaces.
 *
 * A class, not the `CreateWorkspaceInput` interface the service takes,
 * because Nest's global ValidationPipe decides what to validate from
 * the parameter's runtime metatype. An interface erases to `Object`,
 * which the pipe classifies as a native type and skips entirely -- so
 * this endpoint had neither validation nor the app-wide
 * `forbidNonWhitelisted` policy, and `isolation: "whatever"` reached
 * the enum column and came back as a 500 instead of a 400.
 *
 * `ttlMs` is bounded here as well as clamped in the service. The
 * service clamps to MAX_TTL_MS and treats anything not positive as
 * "no TTL", which is a real state (the workspaces table has a partial
 * index for it and the UI renders "no TTL"), so the floor of 1 here is
 * about the API not being the way someone asks for it by accident.
 */
export class CreateWorkspaceDto {
  @IsString()
  @MaxLength(4096)
  cwd!: string;

  @IsOptional()
  @IsEnum(RunnerIsolationTier)
  isolation?: RunnerIsolationTier;

  /** Time-to-live in milliseconds. Default 1 hour, max 24 hours. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 60 * 60 * 1000)
  ttlMs?: number;

  @IsOptional()
  @IsUUID()
  runnerId?: string;
}
