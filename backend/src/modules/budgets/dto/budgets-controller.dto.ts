import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import type { SpendBudgetBehavior, SpendBudgetPeriod } from '../../../entities/spend-budget.entity';

/**
 * The POST /budgets body, as a class.
 *
 * It used to be the service's `CreateBudgetDto` interface, which erases
 * at runtime: Nest had no metatype for the parameter, so the global
 * ValidationPipe skipped it entirely and the app-wide
 * whitelist/forbidNonWhitelisted policy never applied to a money
 * endpoint. `BudgetsService.validate()` covers limitCents, periodType,
 * behavior and softThresholdPct by hand, but nothing checked that
 * `agentId` was a uuid or that `active` was a boolean, and any extra
 * property in the body reached the service untouched.
 */
export class CreateBudgetBodyDto {
  @ApiPropertyOptional({ description: 'Scope the budget to one agent; omit or null for the whole organization' })
  @IsOptional()
  @IsUUID()
  agentId?: string | null;

  @ApiPropertyOptional({
    description:
      'Always refused: spend is not attributed per LLM provider. Declared so the body is rejected with the service message rather than stripped by the whitelist.',
  })
  @IsOptional()
  @IsUUID()
  llmProviderId?: string | null;

  @ApiPropertyOptional({ enum: ['day', 'month'], default: 'month' })
  @IsOptional()
  @IsIn(['day', 'month'])
  periodType?: SpendBudgetPeriod;

  @ApiPropertyOptional({ description: 'Ceiling for the period, in cents' })
  @IsInt()
  @Min(1)
  limitCents: number;

  @ApiPropertyOptional({ enum: ['warn_log', 'reject'], default: 'warn_log' })
  @IsOptional()
  @IsIn(['warn_log', 'reject'])
  behavior?: SpendBudgetBehavior;

  @ApiPropertyOptional({ description: 'Warn at this percentage of the limit', default: 80 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  softThresholdPct?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** The PATCH /budgets/:id body: every field of the create body, optional. */
export class UpdateBudgetBodyDto extends PartialType(CreateBudgetBodyDto) {}
