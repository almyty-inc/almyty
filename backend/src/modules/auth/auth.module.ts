import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { ApiKeyStrategy } from './strategies/api-key.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { ApiKeyAuthGuard } from './guards/api-key-auth.guard';
import { RolesGuard } from './guards/roles.guard';

import { User } from '../../entities/user.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { Organization } from '../../entities/organization.entity';
import { UserOrganization } from '../../entities/user-organization.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, ApiKey, Organization, UserOrganization]),
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get<string>('JWT_EXPIRES_IN', '24h'),
        },
      }),
    }),
  ],
  providers: [
    AuthService,
    JwtStrategy,
    LocalStrategy,
    ApiKeyStrategy,
    JwtAuthGuard,
    LocalAuthGuard,
    ApiKeyAuthGuard,
    RolesGuard,
  ],
  controllers: [AuthController],
  exports: [AuthService, JwtAuthGuard, ApiKeyAuthGuard, RolesGuard],
})
export class AuthModule {}