import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AgentApp } from '../../entities/agent-app.entity';
import { AppDistribution } from '../../entities/agent-app-distribution.entity';
import { Agent } from '../../entities/agent.entity';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { AgentAppsController } from './agent-apps.controller';
import { AgentAppsService } from './agent-apps.service';

/**
 * The agent factory: turning agents into products a customer ships.
 *
 * Depends on Agent only to verify ownership when a app names one.
 * It deliberately does not depend on the agent runtime: a app
 * decides what a product is called and who may use it, never how an
 * agent thinks.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AgentApp, AppDistribution, Agent]), AuthorizationModule],
  controllers: [AgentAppsController],
  providers: [AgentAppsService],
  exports: [AgentAppsService],
})
export class AgentAppsModule {}
