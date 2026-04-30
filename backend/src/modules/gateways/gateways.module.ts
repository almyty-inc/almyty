import { Module, forwardRef } from '@nestjs/common';
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
import { AgentRun } from '../../entities/agent-run.entity';

import { GatewaysService } from './gateways.service';
import { GatewayProtocolService } from './gateway-protocol.service';
import { GatewayAuthService } from './gateway-auth.service';
import { GatewayToolService } from './gateway-tool.service';
import { GatewaysController } from './gateways.controller';
import { GatewayAuthController } from './gateway-auth.controller';
// GatewayProtocolController removed — all protocol traffic goes through
// the unified endpoint controller at /:orgSlug/:resourceSlug

import { ToolsModule } from '../tools/tools.module';
import { AgentsModule } from '../agents/agents.module';

// Channel adapters (migrated from interfaces module)
import { ChatWidgetAdapter } from './channels/adapters/chat-widget.adapter';
import { SlackAdapter } from './channels/adapters/slack.adapter';
import { DiscordAdapter } from './channels/adapters/discord.adapter';
import { TelegramAdapter } from './channels/adapters/telegram.adapter';
import { WhatsAppAdapter } from './channels/adapters/whatsapp.adapter';
import { EmailAdapter } from './channels/adapters/email.adapter';
import { WebhookAdapter } from './channels/adapters/webhook.adapter';
import { GoogleChatAdapter } from './channels/adapters/google-chat.adapter';
import { MicrosoftTeamsAdapter } from './channels/adapters/microsoft-teams.adapter';
import { SignalAdapter } from './channels/adapters/signal.adapter';
import { MatrixAdapter } from './channels/adapters/matrix.adapter';
import { IrcAdapter } from './channels/adapters/irc.adapter';
import { ChannelGatewayService } from './channels/channel-gateway.service';

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
      AgentRun,
    ]),
    JwtModule,
    ToolsModule,
    forwardRef(() => AgentsModule),
  ],
  providers: [
    GatewaysService,
    GatewayProtocolService,
    GatewayAuthService,
    GatewayToolService,
    // Channel adapters
    ChannelGatewayService,
    ChatWidgetAdapter,
    SlackAdapter,
    DiscordAdapter,
    TelegramAdapter,
    WhatsAppAdapter,
    EmailAdapter,
    WebhookAdapter,
    GoogleChatAdapter,
    MicrosoftTeamsAdapter,
    SignalAdapter,
    MatrixAdapter,
    IrcAdapter,
  ],
  controllers: [
    GatewaysController,
    GatewayAuthController,
  ],
  exports: [
    GatewaysService,
    GatewayProtocolService,
    GatewayAuthService,
    GatewayToolService,
    ChannelGatewayService,
  ],
})
export class GatewaysModule {}