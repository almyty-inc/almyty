import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Organization } from '../../entities/organization.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { User } from '../../entities/user.entity';

import { OrganizationsService } from './organizations.service';
import { OrganizationsInvitesHelper } from './organizations-invites.helper';
import { OrganizationsController } from './organizations.controller';
import { InvitesController } from './invites.controller';
import { GatewaysModule } from '../gateways/gateways.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Organization,
      UserOrganization,
      Team,
      UserTeam,
      User,
    ]),
    forwardRef(() => GatewaysModule),
  ],
  providers: [OrganizationsService],
  controllers: [OrganizationsController, InvitesController],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}