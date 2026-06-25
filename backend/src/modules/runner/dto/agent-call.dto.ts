import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Request bodies for the runner's coding-agent orchestration endpoints. These
 * map onto the runner-side agent.spawn / agent.status params; the controller
 * peels off workspaceId (which RunnerCallService routes separately) and passes
 * the rest through as the dispatch params.
 */
export class AgentSpawnDto {
  /** Coding-agent platform id (claude, codex, gemini, …). */
  @IsString()
  @MaxLength(64)
  platform!: string;

  /** Workspace to spawn the member in (runner-scoped). */
  @IsString()
  @MaxLength(128)
  workspaceId!: string;

  /** Provider API key injected for headless auth. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  apiKey?: string;

  /** Override the env var the key is set on (multi-provider CLIs). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  apiKeyEnvVar?: string;

  /** Isolated config/auth/session home for this member. */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  configDir?: string;

  /** Skip per-tool permission prompts. Default true on the runner side. */
  @IsOptional()
  @IsBoolean()
  autoApprove?: boolean;

  /** Pin a model where the CLI supports a plain --model flag. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;

  /** Resume a prior session id. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  resumeSessionId?: string;

  /** Extra argv appended last. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  extraArgs?: string[];

  /** Working directory for the member. */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cwd?: string;
}

export class AgentStatusDto {
  @IsString()
  @MaxLength(128)
  workspaceId!: string;

  @IsString()
  @MaxLength(128)
  processId!: string;

  /** Optional platform override; otherwise resolved from the process binary. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  platform?: string;
}
