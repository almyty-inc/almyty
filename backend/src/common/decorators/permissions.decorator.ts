import { SetMetadata } from '@nestjs/common';
import { PERMISSIONS_KEY } from '../../modules/auth/guards/roles.guard';

export const RequirePermissions = (...permissions: string[]) => 
  SetMetadata(PERMISSIONS_KEY, permissions);