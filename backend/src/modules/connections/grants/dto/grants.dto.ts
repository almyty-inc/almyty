import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import { GRANT_PERMISSIONS, GRANT_PRINCIPAL_TYPES, GrantPermission, GrantPrincipalType } from '../../../../entities/connection-grant.entity';

/**
 * Shape check only. Whether the principal exists in the organization,
 * whether a role name is real and whether the actor may bind that
 * agent or workspace is decided by GrantsService.
 */
export class CreateGrantDto {
  @IsIn(GRANT_PRINCIPAL_TYPES as readonly string[]) principalType: GrantPrincipalType;
  @IsString() @MinLength(1) @MaxLength(64) principalId: string;
  @IsOptional() @IsIn(GRANT_PERMISSIONS as readonly string[]) permission?: GrantPermission;
  @IsOptional() @IsUUID() budgetId?: string;
  @IsOptional() @IsISO8601({ strict: true }) expiresAt?: string;
}
