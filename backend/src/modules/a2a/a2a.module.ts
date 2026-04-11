import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Organization } from '../../entities/organization.entity';

import { A2AServerService } from './a2a-server.service';
import { A2AAgentCardService } from './a2a-agent-card.service';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Gateway, Agent, Conversation, Message, AgentRun, Organization]),
    forwardRef(() => AgentsModule),
  ],
  providers: [A2AServerService, A2AAgentCardService],
  exports: [A2AServerService, A2AAgentCardService],
})
export class A2AModule {}
