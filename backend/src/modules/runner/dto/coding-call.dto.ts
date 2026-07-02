import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Request bodies for the chat-to-runner coding bridge endpoints. These map
 * onto the runner-side coding.* params; unlike the agent.* surface there is
 * no workspaceId — coding sessions are daemon-global and namespaced by the
 * runner itself.
 */
export class CodingStartDto {
  /** Coding-agent platform id (claude, codex, gemini, ...). */
  @IsString()
  @MaxLength(64)
  agent!: string;

  /** The task prompt handed to the CLI. */
  @IsString()
  @MinLength(1)
  @MaxLength(16384)
  task!: string;

  /** Working directory on the runner machine; defaults to the daemon home. */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cwd?: string;

  /** Pin a model where the CLI supports a plain --model flag. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;

  /** Extra argv appended before the task. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  extraArgs?: string[];
}

export class CodingInputDto {
  /** A line of input for the session's stdin. */
  @IsString()
  @MinLength(1)
  @MaxLength(16384)
  data!: string;
}

export class CodingStopDto {
  /** KILL instead of TERM. */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/** Route-param shape shared by the per-session endpoints. */
export const CODING_SESSION_ID_RE = /^cs_[A-Za-z0-9-]{1,64}$/;

export class CodingSessionIdParam {
  @IsString()
  @Matches(CODING_SESSION_ID_RE, { message: 'invalid coding session id' })
  sessionId!: string;
}
