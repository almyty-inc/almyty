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
import { ReferralsModule } from '../referrals/referrals.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, ApiKey, Organization, UserOrganization]),
    ReferralsModule,
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
        // nestjs/jwt 11.x tightened the SignOptions.expiresIn type
        // to `number | StringValue` where StringValue is the
        // `ms` library's template-literal string union. A runtime
        // string like "24h" IS valid but TypeScript can't narrow
        // it from ConfigService.get<string>(). Cast through `any`
        // to the expected runtime shape — jsonwebtoken accepts
        // any parseable ms string at runtime regardless of the
        // type declaration.
        const expiresIn = configService.get<string>('JWT_EXPIRES_IN', '24h') as any;
        return {
          secret: secret || 'dev-only-jwt-secret-change-me-in-production',
          signOptions: {
            expiresIn,
            // issuer + audience bind every signed token to THIS
            // service. If an attacker ever gets hold of a JWT_SECRET
            // that's shared across multiple services (common mistake
            // in microservices architectures), a token signed by
            // Service A still can't be used against Service B
            // because B's verify will reject the `aud` mismatch.
            // It's also a trivial extra check against a shared-secret
            // compromise: a forged token is unlikely to guess both
            // the secret AND the correct claim shape.
            issuer: 'almyty',
            audience: 'almyty-api',
          },
          verifyOptions: {
            // Only enforce iss/aud if they're present on the token.
            // Tokens issued before this commit don't carry these
            // claims; once they expire (24h) everyone re-logs in
            // with the stricter shape. After the grace window
            // `ignoreNotBefore` can be dropped to `false` in a
            // follow-up but that's a follow-up cleanup, not a
            // security regression.
            issuer: 'almyty',
            audience: 'almyty-api',
            ignoreExpiration: false,
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