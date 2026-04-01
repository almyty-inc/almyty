import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentInterface } from '../../entities/interface.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Agent } from '../../entities/agent.entity';
import { InterfacesService } from './interfaces.service';
import { InterfacesController } from './interfaces.controller';
import { BaseAdapter } from './adapters/base.adapter';
import { ChatWidgetAdapter } from './adapters/chat-widget.adapter';
import { SlackAdapter } from './adapters/slack.adapter';
import { DiscordAdapter } from './adapters/discord.adapter';
import { TelegramAdapter } from './adapters/telegram.adapter';
import { WhatsAppAdapter } from './adapters/whatsapp.adapter';
import { EmailAdapter } from './adapters/email.adapter';
import { WebhookAdapter } from './adapters/webhook.adapter';
import { GoogleChatAdapter } from './adapters/google-chat.adapter';
import { MicrosoftTeamsAdapter } from './adapters/microsoft-teams.adapter';
import { SignalAdapter } from './adapters/signal.adapter';
import { MatrixAdapter } from './adapters/matrix.adapter';
import { IrcAdapter } from './adapters/irc.adapter';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AgentInterface, AgentRun, Agent]),
    forwardRef(() => AgentsModule),
  ],
  providers: [
    InterfacesService,
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
  controllers: [InterfacesController],
  exports: [InterfacesService],
})
export class InterfacesModule {}
