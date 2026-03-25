import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Organization } from '../../entities/organization.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { User } from '../../entities/user.entity';

import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { InvitesController } from './invites.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Organization,
      UserOrganization,
      Team,
      UserTeam,
      User,
    ]),
  ],
  providers: [OrganizationsService],
  controllers: [OrganizationsController, InvitesController],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}