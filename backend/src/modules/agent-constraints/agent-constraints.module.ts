import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Agent } from '../../entities/agent.entity';
import { AgentConstraint } from '../../entities/agent-constraint.entity';
import { LlmProvidersModule } from '../llm-providers/llm-providers.module';
import { AgentConstraintsService } from './agent-constraints.service';
import { AgentConstraintsController } from './agent-constraints.controller';

@Module({
  imports: [TypeOrmModule.forFeature([AgentConstraint, Agent]), LlmProvidersModule],
  providers: [AgentConstraintsService],
  controllers: [AgentConstraintsController],
  exports: [AgentConstraintsService],
})
export class AgentConstraintsModule {}
