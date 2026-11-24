import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Organization } from '../../../src/entities/organization.entity';
import { HOSTED_CAPACITY_PROVIDER } from '../../../src/modules/hosted-runners/hosted-capacity.provider';
import { PlanHostedCapacityProvider } from './plan-hosted-capacity.provider';

/**
 * Fills the hosted runners' capacity seam with per-plan numbers. Global
 * so HostedRunnersService's optional HOSTED_CAPACITY_PROVIDER resolves to
 * it; without `ee` that service falls back to the install's settings.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Organization])],
  providers: [PlanHostedCapacityProvider, { provide: HOSTED_CAPACITY_PROVIDER, useExisting: PlanHostedCapacityProvider }],
  exports: [HOSTED_CAPACITY_PROVIDER, PlanHostedCapacityProvider],
})
export class HostedCapacityModule {}
