import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 3650;

/**
 * PUT body for an org retention policy. Every field is optional; a day
 * field set to `null` means "keep forever" for that data class
 * (`@IsOptional` skips validation for both `undefined` and `null`, so
 * explicit nulls pass through and clear the limit).
 */
export class UpdateRetentionPolicyDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(RETENTION_MIN_DAYS)
  @Max(RETENTION_MAX_DAYS)
  agentRunsDays?: number | null;

  @IsOptional()
  @IsInt()
  @Min(RETENTION_MIN_DAYS)
  @Max(RETENTION_MAX_DAYS)
  conversationsDays?: number | null;

  @IsOptional()
  @IsInt()
  @Min(RETENTION_MIN_DAYS)
  @Max(RETENTION_MAX_DAYS)
  requestLogsDays?: number | null;

  @IsOptional()
  @IsInt()
  @Min(RETENTION_MIN_DAYS)
  @Max(RETENTION_MAX_DAYS)
  usageMetricsDays?: number | null;

  @IsOptional()
  @IsInt()
  @Min(RETENTION_MIN_DAYS)
  @Max(RETENTION_MAX_DAYS)
  auditLogDays?: number | null;

  /**
   * The two classes the sweep gained without a way to configure them.
   *
   * The controller and main both validate with whitelist +
   * forbidNonWhitelisted, so a PUT carrying either of these was rejected
   * 400 -- the column could never be set to non-null through the
   * product, and the sweep clause behind it was unreachable.
   */
  @IsOptional()
  @IsInt()
  @Min(RETENTION_MIN_DAYS)
  @Max(RETENTION_MAX_DAYS)
  toolExecutionsDays?: number | null;

  @IsOptional()
  @IsInt()
  @Min(RETENTION_MIN_DAYS)
  @Max(RETENTION_MAX_DAYS)
  notificationsDays?: number | null;
}
