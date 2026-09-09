import { BullModule } from '@nestjs/bull';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Agent } from '../../../src/entities/agent.entity';
import { AuditLog } from '../../../src/entities/audit-log.entity';
import { ConnectionGrant } from '../../../src/entities/connection-grant.entity';
import { ConnectionPolicy } from '../../../src/entities/connection-policy.entity';
import { Credential } from '../../../src/entities/credential.entity';
import { SpendBudget } from '../../../src/entities/spend-budget.entity';
import { Team } from '../../../src/entities/team.entity';
import { User } from '../../../src/entities/user.entity';
import { UserOrganization } from '../../../src/entities/user-organization.entity';
import { UserTeam } from '../../../src/entities/user-team.entity';
import { BudgetsModule } from '../../../src/modules/budgets/budgets.module';
import { ConnectionsModule } from '../../../src/modules/connections/connections.module';
import { SsoModule } from '../sso/sso.module';
import { ConnectionsGovernanceController } from './connections-governance.controller';
import { ConnectionsGovernanceHookImpl } from './connections-governance.hook';
import { CONNECTIONS_GOVERNANCE_QUEUE, ConnectionsGovernanceProcessor } from './connections-governance.processor';
import { ConnectionsGovernanceService } from './connections-governance.service';
import { GroupPrincipalSyncService } from './group-principal-sync.service';
import {
  CONNECTION_GRANT_REVOKER,
  CONNECTION_PRINCIPAL_SOURCE,
  CONNECTION_ROTATOR,
  CONNECTIONS_GOVERNANCE_HOOK,
} from './seams';
import { ConnectionsRotatorBridge } from '../../../src/modules/connections/connections-rotator.bridge';
import { GrantsService } from '../../../src/modules/connections/grants/grants.service';

/**
 * EE (connections_governance): org-wide policy over the Connections
 * layer. Safety is free (catalog, single store, health, grants, manual
 * rotation, disconnect, audit events live in core); governance is paid
 * (policy rules, review, scheduled rotation, expiry enforcement, team
 * and role principal sync, audit export and retention).
 *
 * `@Global()` so the `CONNECTIONS_GOVERNANCE_HOOK` and
 * `CONNECTION_PRINCIPAL_SOURCE` bindings resolve from core's
 * `@Optional()` injections without core importing anything from `ee/`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ConnectionPolicy, Credential, ConnectionGrant, Agent, User, AuditLog, SpendBudget, UserTeam, Team, UserOrganization]),
    BullModule.registerQueue({ name: CONNECTIONS_GOVERNANCE_QUEUE }),
    ConnectionsModule,
    BudgetsModule,
    SsoModule,
  ],
  providers: [
    ConnectionsGovernanceService,
    ConnectionsGovernanceHookImpl,
    ConnectionsGovernanceProcessor,
    GroupPrincipalSyncService,
    { provide: CONNECTION_ROTATOR, useExisting: ConnectionsRotatorBridge },
    { provide: CONNECTION_GRANT_REVOKER, useExisting: GrantsService },
  ],
  controllers: [ConnectionsGovernanceController],
  exports: [ConnectionsGovernanceService, GroupPrincipalSyncService, ConnectionsGovernanceHookImpl],
})
export class ConnectionsGovernanceModule {}
