import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Model } from '../../entities/model.entity';
import { PriceFeedService } from './pricing/price-feed.service';
import { MODEL_PRICE_FEED_QUEUE, PriceFeedProcessor } from './pricing/price-feed.processor';

/**
 * Model catalog: the cards the router reads. Phase A ships the automatic
 * price feed; CRUD, versions and deployments land in the same module.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Model]),
    BullModule.registerQueue({ name: MODEL_PRICE_FEED_QUEUE }),
  ],
  providers: [PriceFeedService, PriceFeedProcessor],
  exports: [PriceFeedService],
})
export class ModelCatalogModule {}
