import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Notification } from '../../entities/notification.entity';
import { NotificationPreference } from '../../entities/notification-preference.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

/**
 * Global, dependency-light notification pipeline.
 *
 * @Global() on purpose: NotificationsService is consumed from many
 * feature modules (approvals, agents, referrals, retention, auth,
 * organizations, budgets, ee/sso). Making it global means consumers
 * inject it `@Optional()` without adding a module import edge — the
 * exact pattern that keeps the approvals/auth/budgets DI graph
 * cycle-free (this module imports NOTHING beyond TypeORM feature repos
 * and relies on the also-global MailModule, so it can never complete a
 * require cycle).
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Notification,
      NotificationPreference,
      User,
      UserOrganization,
      UserTeam,
    ]),
  ],
  providers: [NotificationsService],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
