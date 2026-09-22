import { plainToInstance } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  validateSync,
} from 'class-validator';

import type { RouteObjective } from '../../model-catalog/routing/model-router';
import type { ModelPrivacyTier } from '../../../entities/model.entity';

export const ROUTE_OBJECTIVES: readonly RouteObjective[] = ['cheapest', 'fastest', 'pinned'];
export const MODEL_PRIVACY_TIERS: readonly ModelPrivacyTier[] = ['local', 'private_cloud', 'public'];

@ValidatorConstraint({ name: 'booleanRecord', async: false })
class BooleanRecordConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return value != null && typeof value === 'object' && !Array.isArray(value) && Object.values(value as object).every((v) => typeof v === 'boolean');
  }
  defaultMessage(): string {
    return 'capabilities must be an object of booleans';
  }
}

/** The shape of `settings.defaultRouting`: the same policy an llm_call node may carry. */
export class RoutingPolicyDto {
  @IsOptional() @IsIn(ROUTE_OBJECTIVES) objective?: RouteObjective;
  @IsOptional() @IsIn(MODEL_PRIVACY_TIERS) privacyTier?: ModelPrivacyTier;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(64, { each: true }) regions?: string[];
  @IsOptional() @Validate(BooleanRecordConstraint) capabilities?: Record<string, boolean>;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(255, { each: true }) fallbackChain?: string[];
  @IsOptional() @IsString() @MaxLength(255) pinnedModel?: string;
  @IsOptional() @IsInt() @Min(0) budgetHeadroomCents?: number | null;
}

/** Violations for a `defaultRouting` value; empty when valid. `null` and `undefined` clear the policy and are fine. */
export function routingPolicyViolations(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object' || Array.isArray(value)) return ['defaultRouting must be an object'];
  const errors = validateSync(plainToInstance(RoutingPolicyDto, value), { whitelist: true, forbidNonWhitelisted: true });
  return errors.flatMap((e) => Object.values(e.constraints ?? {}).map((m) => `defaultRouting.${m}`));
}

/**
 * The egress allowlist: hosts this organization may reach even though they
 * are private. A bad shape here is worth a 400 rather than a surprise
 * later, because the value is read on a security decision.
 */
export function egressAllowlistViolations(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return ['settings.egressAllowlist must be a list of hosts'];
  const bad = value.filter((h) => typeof h !== 'string' || !h.trim());
  if (bad.length) return ['settings.egressAllowlist entries must be non-empty hostnames'];
  // A URL here means somebody pasted the endpoint instead of its host,
  // and it would silently never match.
  const withScheme = value.filter((h: string) => /:\/\//.test(h) || h.includes('/'));
  if (withScheme.length) {
    return [`settings.egressAllowlist takes hosts, not URLs: ${withScheme.join(', ')}`];
  }
  return [];
}

/**
 * Validates the typed parts of an organization's `settings` object without
 * touching the keys other features keep there (limits, pending invites).
 */
@ValidatorConstraint({ name: 'organizationSettings', async: false })
export class OrganizationSettingsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value == null || typeof value !== 'object') return true;
    const v = value as Record<string, unknown>;
    return routingPolicyViolations(v.defaultRouting).length === 0 && egressAllowlistViolations(v.egressAllowlist).length === 0;
  }
  defaultMessage(args: ValidationArguments): string {
    const value = args.value as Record<string, unknown> | null | undefined;
    const problems = [...routingPolicyViolations(value?.defaultRouting), ...egressAllowlistViolations(value?.egressAllowlist)];
    return problems.join('; ') || 'settings is invalid';
  }
}
