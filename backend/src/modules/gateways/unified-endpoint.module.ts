import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { ApiKey } from '../../entities/api-key.entity';

import { UnifiedEndpointController } from './unified-endpoint.controller';
import { GatewaysModule } from './gateways.module';
import { McpModule } from '../mcp/mcp.module';
import { AgentsModule } from '../agents/agents.module';
import { A2AModule } from '../a2a/a2a.module';

/**
 * Unified endpoint module — MUST be imported LAST in AppModule
 * so that its wildcard routes (:orgSlug/:resourceSlug) don't
 * shadow specific routes like /auth, /apis, /health, etc.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Organization, Gateway, Agent, ApiKey]),
    forwardRef(() => McpModule),
    forwardRef(() => AgentsModule),
    forwardRef(() => A2AModule),
    GatewaysModule,
  ],
  controllers: [UnifiedEndpointController],
})
export class UnifiedEndpointModule {}
