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
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('JWT_SECRET');
        // Hard-fail in production if JWT_SECRET is not set. Without this,
        // the JWT module initializes with `secret: undefined`, and the
        // first login request throws a generic 500 — extremely hard to
        // diagnose. Worse, if any path somehow treated undefined as "no
        // signing" it would be a catastrophic auth bypass. Fail early,
        // fail loud.
        if (!secret) {
          if (process.env.NODE_ENV === 'production') {
            throw new Error(
              'JWT_SECRET environment variable is required in production. ' +
                'Refusing to start with an undefined signing key.',
            );
          }
          // Dev/test: warn and use a fixed placeholder so the server
          // can still boot for local development.
          // eslint-disable-next-line no-console
          console.warn(
            '[SECURITY WARNING] JWT_SECRET not set. Using dev fallback. Set JWT_SECRET in production!',
          );
        }
        return {
          secret: secret || 'dev-only-jwt-secret-change-me-in-production',
          signOptions: {
            expiresIn: configService.get<string>('JWT_EXPIRES_IN', '24h'),
          },
        };
      },
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