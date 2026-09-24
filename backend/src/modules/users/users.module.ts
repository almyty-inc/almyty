import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../../entities/user.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { ApiKey } from '../../entities/api-key.entity';

import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserOrganization, ApiKey]),
    // AuthService.changeEmail: the one path allowed to move a login address.
    AuthModule,
  ],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}