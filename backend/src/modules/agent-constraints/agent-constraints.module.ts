import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AgentConstraint } from '../../entities/agent-constraint.entity';
import { LlmProvidersModule } from '../llm-providers/llm-providers.module';
import { AgentConstraintsService } from './agent-constraints.service';
import { AgentConstraintsController } from './agent-constraints.controller';

@Module({
  imports: [TypeOrmModule.forFeature([AgentConstraint]), LlmProvidersModule],
  providers: [AgentConstraintsService],
  controllers: [AgentConstraintsController],
  exports: [AgentConstraintsService],
})
export class AgentConstraintsModule {}
