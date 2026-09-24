import { IntersectionType, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

import { CreateOrganizationDto } from './create-organization.dto';

/**
 * Org fields only an org admin/owner may change (the org controller gates
 * PATCH to those roles), kept off CreateOrganizationDto.
 *
 * `plan`, `billingInfo` and `planExpiresAt` are deliberately NOT here: they
 * are what an org pays for, written only by the Stripe webhook and the
 * referral rewards. `billingInfo` carries the signed entitlement token and
 * the Stripe customer id, so accepting it from the org's own admins let
 * them paste in another org's token (its token is not bound to an org) or
 * point billing at someone else's Stripe customer and open their portal.
 */
class OrganizationAdminFieldsDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateOrganizationDto extends IntersectionType(
  PartialType(CreateOrganizationDto),
  OrganizationAdminFieldsDto,
) {}
