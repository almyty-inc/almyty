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
import {
  ClauseModel,
  ExecutedQuery,
  RecordingQueryBuilder,
  matchingRows,
} from '../../__tests__/recording-query-builder';

const RUN_CLAUSES: ClauseModel = {
  'run.agentId = :agentId': (row, p) => row.agentId === p.agentId,
  'run.status IN (:...activeStatuses)': (row, p) => p.activeStatuses.includes(row.status),
  "run.metadata->>'threadId' = :threadId": (row, p) => row.metadata?.threadId === p.threadId,
  "run.metadata->>'gatewayId' = :gatewayId": (row, p) => row.metadata?.gatewayId === p.gatewayId,
};

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
  /** Rows the pipeline and the adapters inserted. */
  savedEvents: any[];
  /** Outcome writes onto a row that already existed (the inbound claim). */
  eventUpdates: Array<{ where: any; patch: any }>;
  /** The inbound row as it stands after any outcome write. */
  inboundEvent: any;
  /** The outbound row the dispatch path filed for the reply. */
  outboundEvent: any;
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
  /**
   * Response the captured fetch should return to the adapter. Omitted,
   * the surface's own "the platform accepted it" answer is used — see
   * PLATFORM_ACCEPTED, which exists because half these platforms
   * confirm in the body rather than the status.
   */
  platformResponse?: Partial<{ ok: boolean; status: number; json: any; text: string }>;
}

/**
 * What each platform says when it took the message.
 *
 * Only the surfaces whose confirmation is NOT the HTTP status need an
 * entry: Slack and Telegram answer 200 either way and put the verdict
 * in `ok`, and the Teams reply needs a token issued first. The rest
 * are confirmed by the 200 the mock returns by default.
 */
const PLATFORM_ACCEPTED: Partial<Record<GatewayType, RoundTripOptions['platformResponse']>> = {
  [GatewayType.SLACK]: { json: { ok: true, channel: 'C42', ts: '1700000000.200' } },
  [GatewayType.TELEGRAM]: { json: { ok: true, result: { message_id: 7 } } },
  [GatewayType.MICROSOFT_TEAMS]: { json: { access_token: 'round-trip-token' } },
};

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
  const accepted = options.platformResponse ?? PLATFORM_ACCEPTED[options.type];
  if (accepted) fetchMock.setNextResponse(accepted);

  const savedEvents: any[] = [];
  const eventUpdates: Array<{ where: any; patch: any }> = [];
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
    // The thread-continuation lookup over an empty runs table: a round
    // trip is a first message. The builder still checks the SQL it is
    // handed -- a clause it does not model throws -- where the nested
    // chain that stood here accepted anything. Its predicates are
    // exercised against real rows in channel-gateway-installation-resolution.
    createQueryBuilder: (alias: string) =>
      new RecordingQueryBuilder(alias, {
        getMany: (query: ExecutedQuery) => matchingRows(query, [], RUN_CLAUSES),
      }),
    findOne: async () => run,
    save: async (row: any) => {
      Object.assign(run, row);
      return run;
    },
  };

  // The real table hands back a generated id, which is what the
  // pipeline addresses when it writes the delivery's outcome onto the
  // inbound row. A fake that returned no id would quietly skip that
  // write and the round trip would stop proving anything about it.
  let nextEventId = 1;
  const eventRepository = {
    create: (row: any) => row,
    save: async (row: any) => {
      const stored = { id: `evt-${nextEventId++}`, ...row };
      savedEvents.push(stored);
      return stored;
    },
    update: async (where: any, patch: any) => {
      eventUpdates.push({ where, patch });
      const target = savedEvents.find((e) =>
        where.id ? e.id === where.id : e.gatewayId === where.gatewayId && e.deliveryId === where.deliveryId,
      );
      if (target) Object.assign(target, patch);
      return { affected: target ? 1 : 0 };
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
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    return {
      calls: fetchMock.calls,
      reply: fetchMock.calls[0],
      savedEvents,
      eventUpdates,
      inboundEvent: savedEvents.find((e) => e.direction === 'inbound'),
      outboundEvent: savedEvents.find((e) => e.direction === 'outbound'),
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
