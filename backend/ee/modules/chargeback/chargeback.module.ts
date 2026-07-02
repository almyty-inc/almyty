import { Module } from '@nestjs/common';

import { BudgetsModule } from '../../../src/modules/budgets/budgets.module';

import { ChargebackService } from './chargeback.service';
import { ChargebackController } from './chargeback.controller';

/**
 * EE (chargeback): cost attribution + forecasting. Imports the OSS
 * BudgetsModule to reuse its exported `SpendService` rather than
 * re-implementing spend aggregation. Controller-gated by `EntitlementGuard`.
 */
@Module({
  imports: [BudgetsModule],
  providers: [ChargebackService],
  controllers: [ChargebackController],
  exports: [ChargebackService],
})
export class ChargebackModule {}
