import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Organization } from '../../entities/organization.entity';
import { ExternalAgent } from '../../entities/external-agent.entity';

import { A2AServerService } from './a2a-server.service';
import { A2AAgentCardService } from './a2a-agent-card.service';
import { ExternalAgentsService } from './external-agents.service';
import { ExternalAgentsController } from './external-agents.controller';
import { A2AClientService } from './a2a-client.service';
import { AgentsModule } from '../agents/agents.module';
import { CredentialsModule } from '../credentials/credentials.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Gateway, Agent, Conversation, Message, AgentRun, Organization, ExternalAgent]),
    forwardRef(() => AgentsModule),
    forwardRef(() => CredentialsModule),
  ],
  controllers: [ExternalAgentsController],
  providers: [A2AServerService, A2AAgentCardService, ExternalAgentsService, A2AClientService],
  exports: [A2AServerService, A2AAgentCardService, ExternalAgentsService, A2AClientService],
})
export class A2AModule {}
