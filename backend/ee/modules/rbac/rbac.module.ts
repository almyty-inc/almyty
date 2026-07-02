import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CustomRole } from '../../../src/entities/custom-role.entity';
import { CustomRoleAssignment } from '../../../src/entities/custom-role-assignment.entity';
import { AbacPolicy } from '../../../src/entities/abac-policy.entity';
import { ADVANCED_RBAC_HOOK } from '../../../src/common/ee-hooks/ee-hooks';

import { CustomRoleService } from './custom-role.service';
import { PolicyEvaluatorService } from './policy-evaluator.service';
import { AdvancedRbacHookImpl } from './advanced-rbac.hook';
import { RbacController } from './rbac.controller';

/**
 * EE (advanced_rbac): custom roles + ABAC. Guarded at the controller by
 * `EntitlementGuard` — the module always loads, but every route 402s
 * without a license, so the OSS build keeps only the built-in roles.
 *
 * `@Global()` so the `ADVANCED_RBAC_HOOK` binding is resolvable by the
 * core RolesGuard's `@Optional()` injection without the core importing
 * anything from `ee/`.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([CustomRole, CustomRoleAssignment, AbacPolicy]),
  ],
  providers: [
    CustomRoleService,
    PolicyEvaluatorService,
    AdvancedRbacHookImpl,
    { provide: ADVANCED_RBAC_HOOK, useExisting: AdvancedRbacHookImpl },
  ],
  controllers: [RbacController],
  exports: [CustomRoleService, PolicyEvaluatorService, ADVANCED_RBAC_HOOK],
})
export class RbacModule {}