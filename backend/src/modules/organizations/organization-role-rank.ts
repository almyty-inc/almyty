import { OrganizationRole } from '../../entities/user-organization.entity';

/**
 * Organization role precedence. Lower value = more privilege.
 *
 * Its own file rather than a const on OrganizationsService, because the
 * invite helper needs it too and the service already imports the helper.
 */
export const ORGANIZATION_ROLE_RANK: Record<OrganizationRole, number> = {
  [OrganizationRole.OWNER]: 0,
  [OrganizationRole.ADMIN]: 1,
  [OrganizationRole.MEMBER]: 2,
  [OrganizationRole.VIEWER]: 3,
};
