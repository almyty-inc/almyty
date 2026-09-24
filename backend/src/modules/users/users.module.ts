import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../../entities/user.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { ApiKey } from '../../entities/api-key.entity';

import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { ConnectionsModule } from '../connections/connections.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserOrganization, ApiKey]),
    // Deleting an account wipes and provider-revokes the person's own connections.
    forwardRef(() => ConnectionsModule),
  ],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}