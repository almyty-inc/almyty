import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { PromotedSkillsModule } from './promoted-skills.module';
import { PromotedSkillReplayController } from '../agents/promoted-skill-replay.controller';

/**
 * Hosts the replay controller, which needs both AgentRuntimeService (agents) and
 * PromotedSkillsService (promoted-skills). Kept as its own LEAF module — nothing
 * imports it — so neither agents nor promoted-skills depends on the other.
 * Having AgentsModule import PromotedSkillsModule (or vice-versa) creates a
 * module-init cycle that leaves LlmProvidersService's ToolExecutorService
 * dependency undefined at boot. This one-way fan-in avoids that.
 */
@Module({
  imports: [AgentsModule, PromotedSkillsModule],
  controllers: [PromotedSkillReplayController],
})
export class PromotedSkillReplayModule {}
