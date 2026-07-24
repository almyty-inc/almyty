import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../../entities/user.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { OnboardingModule } from '../onboarding/onboarding.module';

import { LifecycleEmailService } from './lifecycle-email.service';
import { LifecycleController } from './lifecycle.controller';
import { LifecycleEmailProcessor, LIFECYCLE_EMAIL_QUEUE } from './lifecycle-email.processor';

/**
 * New-signup activation lifecycle emails (welcome + up to 3 nudges).
 *
 * MailService is provided by the @Global MailModule, so it does not need
 * importing here. OnboardingService comes from OnboardingModule (which
 * exports it). The JwtModule below is a self-contained instance used only
 * to sign/verify the unsubscribe token — signed and verified in the same
 * process, with no expiry so unsubscribe links never rot.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserOrganization]),
    OnboardingModule,
    BullModule.registerQueue({ name: LIFECYCLE_EMAIL_QUEUE }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        if (!secret && process.env.NODE_ENV === 'production') {
          throw new Error(
            'JWT_SECRET environment variable is required in production. ' +
              'Refusing to start the lifecycle module with an undefined signing key.',
          );
        }
        return {
          secret: secret || 'dev-only-jwt-secret-change-me-in-production',
          // No expiresIn: an unsubscribe link should keep working forever.
          signOptions: { issuer: 'almyty', audience: 'almyty-api' },
          verifyOptions: { issuer: 'almyty', audience: 'almyty-api' },
        };
      },
    }),
  ],
  controllers: [LifecycleController],
  providers: [LifecycleEmailService, LifecycleEmailProcessor],
  exports: [LifecycleEmailService],
})
export class LifecycleModule {}
