import { EventEmitter } from 'events';

import { ChannelGatewayService } from '../channel-gateway.service';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';
import { ChatWidgetAdapter } from '../adapters/chat-widget.adapter';
import { SlackAdapter } from '../adapters/slack.adapter';
import { DiscordAdapter } from '../adapters/discord.adapter';
import { TelegramAdapter } from '../adapters/telegram.adapter';
import { WhatsAppAdapter } from '../adapters/whatsapp.adapter';
import { WhatsAppCloudAdapter } from '../adapters/whatsapp-cloud.adapter';
import { SmsAdapter } from '../adapters/sms.adapter';
import { EmailAdapter } from '../adapters/email.adapter';
import { WebhookAdapter } from '../adapters/webhook.adapter';
import { GoogleChatAdapter } from '../adapters/google-chat.adapter';
import { MicrosoftTeamsAdapter } from '../adapters/microsoft-teams.adapter';
import { SignalAdapter } from '../adapters/signal.adapter';
import { MatrixAdapter } from '../adapters/matrix.adapter';
import { IrcAdapter } from '../adapters/irc.adapter';
import { CapturedFetch, installFetchMock } from '../adapters/__tests__/test-helpers';

/**
 * Round-trip harness for the channel surfaces.
 *
 * The adapter unit specs check normalizeInbound, formatOutbound and
 * verifyWebhook in isolation. That leaves the interesting failures
 * uncovered: a surface can pass all three and still be broken end to
 * end because the reply goes to the wrong URL, carries the wrong auth
 * header, threads against the wrong id, or never fires the Art. 50
 * disclosure.
 *
 * This drives the real ChannelGatewayService pipeline: a correctly
 * signed inbound payload goes in, a run is started and completed, and
 * the outbound platform call is captured so a test can assert the exact
 * request the platform would receive.
 *
 * What it does NOT prove is that Slack, Meta or Twilio accept that
 * request. Proving that needs live credentials on a verified business
 * account. What it does prove is that we send what their documented API
 * specifies, which is the half that regresses.
 */

export interface RoundTripResult {
  /** Every outbound HTTP call the reply produced. */
  calls: CapturedFetch[];
  /** The first outbound call, which is the reply on all push surfaces. */
  reply: CapturedFetch;
  /** Rows the adapter persisted instead of pushing (chat widget). */
  savedEvents: any[];
  /** The run row as it stood when the reply was sent. */
  run: any;
}

export interface RoundTripOptions {
  type: GatewayType;
  configuration: Record<string, any>;
  /** The inbound payload exactly as the platform posts it. */
  inbound: any;
  /** Inbound headers, including whatever signature the surface requires. */
  headers?: Record<string, string>;
  /** Raw body, for surfaces that sign the exact bytes on the wire. */
  rawBody?: string;
  /** What the agent produced. */
  agentOutput?: string;
  /** Response the captured fetch should return to the adapter. */
  platformResponse?: Partial<{ ok: boolean; status: number; json: any; text: string }>;
}

const ORG_ID = 'org-round-trip';
const AGENT_ID = 'agent-round-trip';
const RUN_ID = 'run-round-trip';

/**
 * Run one inbound message all the way through to the outbound reply.
 * Throws if the pipeline dropped the message, which is what a rejected
 * signature or an inactive gateway looks like from the outside.
 */
export async function roundTrip(options: RoundTripOptions): Promise<RoundTripResult> {
  const fetchMock = installFetchMock();
  if (options.platformResponse) fetchMock.setNextResponse(options.platformResponse);

  const savedEvents: any[] = [];
  const run: any = {
    id: RUN_ID,
    organizationId: ORG_ID,
    agentId: AGENT_ID,
    status: 'completed',
    output: options.agentOutput ?? 'agent reply text',
    metadata: {},
  };

  const emitter = new EventEmitter();
  const runRepository = {
    createQueryBuilder: () => ({
      where: () => ({
        andWhere: () => ({
          andWhere: () => ({
            orderBy: () => ({ limit: () => ({ getMany: async () => [] }) }),
          }),
        }),
      }),
    }),
    findOne: async () => run,
    save: async (row: any) => {
      Object.assign(run, row);
      return run;
    },
  };

  const eventRepository = {
    create: (row: any) => row,
    save: async (row: any) => {
      savedEvents.push(row);
      return row;
    },
  };

  const gatewayRepository = { save: async (row: any) => row };

  const agentRuntimeService = {
    startRun: async () => run,
    sendInput: async () => undefined,
    getRunEmitter: () => emitter,
  };

  const service = new ChannelGatewayService(
    gatewayRepository as any,
    runRepository as any,
    eventRepository as any,
    agentRuntimeService as any,
    new ChatWidgetAdapter(eventRepository as any),
    new SlackAdapter(),
    new DiscordAdapter(),
    new TelegramAdapter(),
    new WhatsAppAdapter(),
    new WhatsAppCloudAdapter(),
    new SmsAdapter(),
    new EmailAdapter(),
    new WebhookAdapter(),
    new GoogleChatAdapter(),
    new MicrosoftTeamsAdapter(),
    new SignalAdapter(),
    new MatrixAdapter(),
    new IrcAdapter(),
  );

  const gateway = new Gateway();
  gateway.id = 'gw-round-trip';
  gateway.type = options.type;
  gateway.status = GatewayStatus.ACTIVE;
  gateway.agentId = AGENT_ID;
  gateway.organizationId = ORG_ID;
  gateway.configuration = options.configuration;
  gateway.totalRequests = 0;
  gateway.successfulRequests = 0;

  try {
    await service.handleInboundMessage(
      gateway,
      options.inbound,
      options.headers ?? {},
      options.rawBody,
    );

    // The reply is sent from a run-completion listener, so emit and let
    // the async handler settle before inspecting what went out.
    emitter.emit('event', { type: 'run.completed' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    return {
      calls: fetchMock.calls,
      reply: fetchMock.calls[0],
      savedEvents,
      run,
    };
  } finally {
    fetchMock.restore();
  }
}

/** True when the pipeline refused the message before starting a run. */
export function wasRefused(result: RoundTripResult): boolean {
  return result.calls.length === 0 && result.savedEvents.every((e) => e.direction !== 'outbound');
}
