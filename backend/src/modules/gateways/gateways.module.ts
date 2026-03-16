import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';

import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { GatewayAuth } from '../../entities/gateway-auth.entity';
import { Tool } from '../../entities/tool.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { OAuthAccessToken } from '../../entities/oauth-access-token.entity';

import { GatewaysService } from './gateways.service';
import { GatewayProtocolService } from './gateway-protocol.service';
import { GatewayAuthService } from './gateway-auth.service';
import { GatewayToolService } from './gateway-tool.service';
import { GatewaysController } from './gateways.controller';
// GatewayProtocolController removed — all protocol traffic goes through org-scoped
// controllers in mcp.module.ts: /mcp/:orgId/, /a2a/:orgId/, /utcp/:orgId/

import { ToolsModule } from '../tools/tools.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Gateway,
      GatewayTool,
      GatewayAuth,
      Tool,
      User,
      Organization,
      ToolExecution,
      UsageMetric,
      ApiKey,
      OAuthAccessToken,
    ]),
    JwtModule,
    ToolsModule,
  ],
  providers: [
    GatewaysService,
    GatewayProtocolService,
    GatewayAuthService,
    GatewayToolService,
  ],
  controllers: [
    GatewaysController,
  ],
  exports: [
    GatewaysService,
    GatewayProtocolService,
    GatewayAuthService,
    GatewayToolService,
  ],
})
export class GatewaysModule {}