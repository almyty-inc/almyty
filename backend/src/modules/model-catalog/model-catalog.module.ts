import { AgentExecution } from '../../entities/agent-execution.entity';
import { RoutingAnalyticsController } from './routing/routing-analytics.controller';
import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Model } from '../../entities/model.entity';
import { ModelVersion } from '../../entities/model-version.entity';
import { ModelDeployment } from '../../entities/model-deployment.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { KmsModule } from '../kms/kms.module';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { LlmProvidersModule } from '../llm-providers/llm-providers.module';
import { PriceFeedService } from './pricing/price-feed.service';
import { MODEL_PRICE_FEED_QUEUE, PriceFeedProcessor } from './pricing/price-feed.processor';
import { ModelRouterService } from './routing/model-router.service';
import { MODEL_CATALOG_SYNC_QUEUE, CatalogSyncProcessor } from './catalog-sync.processor';
import { CatalogWarmupService } from './catalog-warmup.service';
import { ModelCatalogService } from './model-catalog.service';
import { ModelCatalogController } from './model-catalog.controller';
import { ModelChangeEvent } from '../../entities/model-change-event.entity';
import { Agent } from '../../entities/agent.entity';
import { AgentRole } from '../../entities/agent-role.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { ModelChangeNoticesService } from './notices/model-change-notices.service';
import { ModelUsageService } from './notices/model-usage.service';
import { MODEL_CHANGE_LISTENER } from './notices/model-change';

/**
 * Model catalog: the cards the router reads, the router itself, the
 * automatic price feed and the boot-time backfill. The chat runner
 * (llm-providers) consumes the router; the validation run here consumes
 * the chat runner, hence the forwardRef on both sides.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Model, ModelVersion, ModelDeployment, LlmProvider, AgentExecution, ModelChangeEvent, Agent, AgentRole, User, UserOrganization]),
    BullModule.registerQueue({ name: MODEL_PRICE_FEED_QUEUE }),
    BullModule.registerQueue({ name: MODEL_CATALOG_SYNC_QUEUE }),
    AuditLogModule,
    KmsModule,
    AuthorizationModule,
    forwardRef(() => LlmProvidersModule),
  ],
  providers: [
    PriceFeedService,
    PriceFeedProcessor,
    CatalogSyncProcessor,
    CatalogWarmupService,
    ModelRouterService,
    ModelCatalogService,
    // New and gone models, told to the people they concern (notices/).
    ModelChangeNoticesService,
    ModelUsageService,
    { provide: MODEL_CHANGE_LISTENER, useExisting: ModelChangeNoticesService },
  ],
  controllers: [ModelCatalogController, RoutingAnalyticsController],
  exports: [PriceFeedService, ModelRouterService, ModelCatalogService, ModelChangeNoticesService, ModelUsageService],
})
export class ModelCatalogModule {}
