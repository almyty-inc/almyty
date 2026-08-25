import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Harness } from '../../entities/harness.entity';
import { HarnessDistribution } from '../../entities/harness-distribution.entity';
import { Agent } from '../../entities/agent.entity';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { HarnessesController } from './harnesses.controller';
import { HarnessesService } from './harnesses.service';

/**
 * The agent factory: turning agents into products a customer ships.
 *
 * Depends on Agent only to verify ownership when a harness names one.
 * It deliberately does not depend on the agent runtime: a harness
 * decides what a product is called and who may use it, never how an
 * agent thinks.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Harness, HarnessDistribution, Agent]), AuthorizationModule],
  controllers: [HarnessesController],
  providers: [HarnessesService],
  exports: [HarnessesService],
})
export class HarnessesModule {}
