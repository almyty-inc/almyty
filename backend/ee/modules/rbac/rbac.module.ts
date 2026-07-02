import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CustomRole } from '../../../src/entities/custom-role.entity';
import { CustomRoleAssignment } from '../../../src/entities/custom-role-assignment.entity';
import { AbacPolicy } from '../../../src/entities/abac-policy.entity';

import { CustomRoleService } from './custom-role.service';
import { PolicyEvaluatorService } from './policy-evaluator.service';
import { RbacController } from './rbac.controller';

/**
 * EE (advanced_rbac): custom roles + ABAC. Guarded at the controller by
 * `EntitlementGuard` — the module always loads, but every route 402s
 * without a license, so the OSS build keeps only the built-in roles.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CustomRole, CustomRoleAssignment, AbacPolicy]),
  ],
  providers: [CustomRoleService, PolicyEvaluatorService],
  controllers: [RbacController],
  exports: [CustomRoleService, PolicyEvaluatorService],
})
export class RbacModule {}
