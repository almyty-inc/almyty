import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserOrganization } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';

import { AccessPolicyService } from './access-policy.service';

/**
 * Shared authorization primitives. Imported anywhere a service needs
 * the team-scoping policy gate.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserOrganization, UserTeam])],
  providers: [AccessPolicyService],
  exports: [AccessPolicyService],
})
export class AuthorizationModule {}
