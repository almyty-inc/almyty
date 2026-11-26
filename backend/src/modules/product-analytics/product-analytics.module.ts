import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../../entities/user.entity';
import { Agent } from '../../entities/agent.entity';
import { Organization } from '../../entities/organization.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { ProductAnalyticsService } from './product-analytics.service';

/**
 * Server-side funnel analytics (PostHog). Global and dependency-light, like
 * NotificationsModule: auth and the agent engines inject the service
 * `@Optional()` without a module import edge, so it can never close a DI
 * cycle, and a build without it simply sends nothing.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([User, Agent, Organization, UserOrganization])],
  providers: [ProductAnalyticsService],
  exports: [ProductAnalyticsService],
})
export class ProductAnalyticsModule {}
