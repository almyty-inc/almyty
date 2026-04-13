import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Organization } from '../../entities/organization.entity';

import { AcpServerService } from './acp-server.service';
import { AcpDiscoveryService } from './acp-discovery.service';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Gateway, Agent, Conversation, Message, AgentRun, Organization]),
    forwardRef(() => AgentsModule),
  ],
  providers: [AcpServerService, AcpDiscoveryService],
  exports: [AcpServerService, AcpDiscoveryService],
})
export class AcpModule {}
