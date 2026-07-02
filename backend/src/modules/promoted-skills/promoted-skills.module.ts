import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PromotedSkill } from '../../entities/promoted-skill.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { LlmProvidersModule } from '../llm-providers/llm-providers.module';
import { PromotedSkillsService } from './promoted-skills.service';
import { PromotedSkillsController } from './promoted-skills.controller';
import { PromotedSkillRenderer } from './promoted-skill-renderer';

@Module({
  imports: [TypeOrmModule.forFeature([PromotedSkill, AgentRun]), forwardRef(() => LlmProvidersModule)],
  providers: [PromotedSkillsService, PromotedSkillRenderer],
  controllers: [PromotedSkillsController],
  exports: [PromotedSkillsService],
})
export class PromotedSkillsModule {}
