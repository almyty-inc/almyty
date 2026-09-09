import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Model } from '../../entities/model.entity';
import { ModelVersion } from '../../entities/model-version.entity';
import { ModelDeployment } from '../../entities/model-deployment.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { KmsModule } from '../kms/kms.module';
import { LlmProvidersModule } from '../llm-providers/llm-providers.module';
import { PriceFeedService } from './pricing/price-feed.service';
import { MODEL_PRICE_FEED_QUEUE, PriceFeedProcessor } from './pricing/price-feed.processor';
import { ModelRouterService } from './routing/model-router.service';
import { MODEL_CATALOG_SYNC_QUEUE, CatalogSyncProcessor } from './catalog-sync.processor';
import { ModelCatalogService } from './model-catalog.service';
import { ModelCatalogController } from './model-catalog.controller';

/**
 * Model catalog: the cards the router reads, the router itself, the
 * automatic price feed and the boot-time backfill. The chat runner
 * (llm-providers) consumes the router; the validation run here consumes
 * the chat runner, hence the forwardRef on both sides.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Model, ModelVersion, ModelDeployment, LlmProvider]),
    BullModule.registerQueue({ name: MODEL_PRICE_FEED_QUEUE }),
    BullModule.registerQueue({ name: MODEL_CATALOG_SYNC_QUEUE }),
    AuditLogModule,
    KmsModule,
    forwardRef(() => LlmProvidersModule),
  ],
  providers: [PriceFeedService, PriceFeedProcessor, CatalogSyncProcessor, ModelRouterService, ModelCatalogService],
  controllers: [ModelCatalogController],
  exports: [PriceFeedService, ModelRouterService, ModelCatalogService],
})
export class ModelCatalogModule {}
