import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Agent } from '../../../entities/agent.entity';
import { ConnectionGrant } from '../../../entities/connection-grant.entity';
import { Credential } from '../../../entities/credential.entity';
import { SpendBudget } from '../../../entities/spend-budget.entity';
import { Team } from '../../../entities/team.entity';
import { UserOrganization } from '../../../entities/user-organization.entity';
import { UserTeam } from '../../../entities/user-team.entity';
import { Workspace } from '../../../entities/workspace.entity';
import { AuditLogModule } from '../../audit-log/audit-log.module';
import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { GrantsController } from './grants.controller';
import { GrantsService } from './grants.service';
import { GrantsUsePolicy } from './grants-use.policy';

/**
 * Connections, gate 2: grants. Imported by ConnectionsModule, which
 * wires `GrantsService.assertCanUse` into the resolver seam; on boot
 * the module also installs itself as the consumer-side use policy of
 * the credential reference resolver (gate 3's seam).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ConnectionGrant, Credential, UserOrganization, UserTeam, Team, Agent, Workspace, SpendBudget]),
    AuditLogModule,
  ],
  controllers: [GrantsController],
  providers: [GrantsService, GrantsUsePolicy],
  exports: [GrantsService, GrantsUsePolicy],
})
export class GrantsModule implements OnModuleInit {
  constructor(
    private readonly policy: GrantsUsePolicy,
    private readonly refs: CredentialRefResolver,
  ) {}

  onModuleInit(): void {
    this.refs.usePolicy(this.policy);
  }
}
