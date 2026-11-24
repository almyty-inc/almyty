import { IsInt, IsNumber, IsOptional, Min } from 'class-validator';

/**
 * An organization's own hosted limits (PUT /environments/capacity/limits):
 * the whole set, each only lower than the plan's (checked against the plan
 * in hosted-limits.service.ts). A field left out or null follows the plan.
 */
export class HostedLimitsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  maxConcurrentRunners?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxWorkspaces?: number | null;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  monthlyCeilingUsd?: number | null;
}