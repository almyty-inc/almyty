import { SetMetadata } from '@nestjs/common';
import { ROLES_KEY } from '../../modules/auth/guards/roles.guard';
import { OrganizationRole } from '../../entities/user-organization.entity';

export const Roles = (...roles: OrganizationRole[]) => SetMetadata(ROLES_KEY, roles);