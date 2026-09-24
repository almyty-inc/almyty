import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserOrganization } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';

import { AccessPolicyService } from './access-policy.service';
import { ExecutionAccessService } from './execution-access.service';

/**
 * Shared authorization primitives. Imported anywhere a service needs
 * the team-scoping policy gate, or the execution gate built on it.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserOrganization, UserTeam])],
  providers: [AccessPolicyService, ExecutionAccessService],
  exports: [AccessPolicyService, ExecutionAccessService],
})
export class AuthorizationModule {}
