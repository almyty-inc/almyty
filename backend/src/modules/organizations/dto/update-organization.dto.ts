import { IntersectionType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsObject,
  IsOptional,
} from 'class-validator';

import { CreateOrganizationDto } from './create-organization.dto';

/**
 * Admin-only org fields that are NOT on CreateOrganizationDto. Adding
 * `plan` or `billingInfo` on create would let any authenticated user
 * self-assign their own org to enterprise tier; here they're only
 * reachable on update, which the org controller gates to owner/admin.
 */
class OrganizationAdminFieldsDto {
  @IsOptional()
  @IsEnum(['free', 'pro', 'enterprise'])
  plan?: 'free' | 'pro' | 'enterprise';

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsObject()
  billingInfo?: Record<string, any>;

  @IsOptional()
  @IsDateString()
  planExpiresAt?: string;
}

export class UpdateOrganizationDto extends IntersectionType(
  PartialType(CreateOrganizationDto),
  OrganizationAdminFieldsDto,
) {}
