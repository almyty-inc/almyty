import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent } from '../../../entities/agent.entity';
import { AgentChannel, ChannelStatus } from '../../../entities/agent-channel.entity';
import { AgentExecution } from '../../../entities/agent-execution.entity';
import { AgentRun } from '../../../entities/agent-run.entity';
import { Gateway, GatewayStatus } from '../../../entities/gateway.entity';
import { GATEWAY_TYPE_FOR_CHANNEL } from '../../agent-channels/channel-publish';
import { resourceOwnerId } from '../../../common/authorization/access-policy.service';
import { NotificationsService } from '../../notifications/notifications.service';
import type {
  ChannelDelivery,
  ChannelDeliveryOutcome,
  PostChannelOption,
  PostDestination,
  ScheduledResult,
  ScheduledResultPoster,
} from '../../agents/scheduled-result-poster';
import { ChannelPolicyService } from '../channel-policy.service';
import { isPrivateGateway } from '../private-gateway';
import { ChannelGatewayService } from './channel-gateway.service';
import { SlackAdapter } from './adapters/slack.adapter';
import { PostTarget, postTargetFor, splitMessage } from './scheduled-post-targets';

/** The most known destinations a channel offers on the schedule page. */
const MAX_DESTINATIONS = 50;
const MAX_LABEL_CHARS = 120;

/**
 * The text of a finished run, as a person would read it: the output when
 * it is text, the usual text-bearing field of an object, else the object
 * as indented JSON.
 */
export function resultText(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>;
    for (const key of ['text', 'output', 'answer', 'content', 'message', 'response']) {
      if (typeof o[key] === 'string' && (o[key] as string).trim()) return o[key] as string;
    }
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/** A day as the schedule's zone reads it, for an email subject: "Thu 1 Oct 2026". */
function dayIn(zone: string | undefined, at: Date): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone || 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(at).replace(/,/g, '');
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * Posts a scheduled run's result into one of its agent's channels.
 *
 * It goes out the way a reply does: the channel's own adapter, its
 * credentials, its AI disclosure line, an outbound event row per message
 * on the channel's activity. The channel's spend limit is asked before
 * the run starts (admit), so a channel that is out of allowance is not
 * sent a result it would refuse. A post that fails is written onto the
 * run (metadata.channelDelivery) and the owner is told, like a failed
 * scheduled run.
 */
@Injectable()
export class ScheduledPostService implements ScheduledResultPoster {
  private readonly logger = new Logger(ScheduledPostService.name);

  constructor(
    @InjectRepository(AgentChannel)
    private readonly channels: Repository<AgentChannel>,
    @InjectRepository(Gateway)
    private readonly gateways: Repository<Gateway>,
    @InjectRepository(AgentExecution)
    private readonly executions: Repository<AgentExecution>,
    private readonly channelGateway: ChannelGatewayService,
    private readonly slack: SlackAdapter,
    @Optional() private readonly policies?: ChannelPolicyService,
    @Optional() private readonly notifications?: NotificationsService,
    // An autonomous agent's scheduled result is a run, not an execution.
    @Optional()
    @InjectRepository(AgentRun)
    private readonly runs?: Repository<AgentRun>,
  ) {}

  /** A channel of this agent, with its gateway and what a post there needs. */
  private async resolve(
    agent: Pick<Agent, 'id' | 'organizationId'>,
    channelId: string,
  ): Promise<{ channel: AgentChannel; gateway: Gateway | null; target: PostTarget | null }> {
    const channel = channelId
      ? await this.channels.findOne({ where: { id: channelId, agentId: agent.id, organizationId: agent.organizationId } })
      : null;
    if (!channel) throw new BadRequestException("That channel is not one of this agent's channels.");
    const gatewayType = GATEWAY_TYPE_FOR_CHANNEL[channel.type] ?? null;
    const target = gatewayType ? postTargetFor(gatewayType) : null;
    const gateway = channel.gatewayId
      ? await this.gateways.findOne({ where: { id: channel.gatewayId, organizationId: agent.organizationId } })
      : null;
    return { channel, gateway, target };
  }

  /** Why a channel cannot take a post now, or null when it can. */
  private unavailable(channel: AgentChannel, gateway: Gateway | null): string | null {
    if (channel.status !== ChannelStatus.LIVE || !gateway) return `the ${channel.name} channel is not published`;
    if (gateway.status !== GatewayStatus.ACTIVE) return `the ${channel.name} channel is switched off`;
    if (isPrivateGateway(gateway)) return `the ${channel.name} channel is private, so it has nobody to post to`;
    return null;
  }

  async destinations(agent: Agent): Promise<PostChannelOption[]> {
    const rows = await this.channels.find({
      where: { agentId: agent.id, organizationId: agent.organizationId },
      order: { createdAt: 'ASC' } as any,
    });
    const out: PostChannelOption[] = [];
    for (const channel of rows) {
      const gatewayType = GATEWAY_TYPE_FOR_CHANNEL[channel.type] ?? null;
      const target = gatewayType ? postTargetFor(gatewayType) : null;
      if (!target) continue;
      const gateway = channel.gatewayId
        ? await this.gateways.findOne({ where: { id: channel.gatewayId, organizationId: agent.organizationId } })
        : null;
      const reason = this.unavailable(channel, gateway);
      let destinations: PostDestination[] = [];
      if (!reason && gateway && target.choose !== 'fixed' && target.choose !== 'enter') {
        destinations = await this.knownDestinations(gateway).catch((err: any) => {
          this.logger.warn(`Could not list destinations for channel ${channel.id}: ${err?.message ?? err}`);
          return [];
        });
      }
      out.push({
        channelId: channel.id,
        name: channel.name,
        type: channel.type,
        available: !reason,
        ...(reason ? { reason: reason.charAt(0).toUpperCase() + reason.slice(1) + '.' } : {}),
        noun: target.noun,
        choose: target.choose,
        ...(target.placeholder ? { placeholder: target.placeholder } : {}),
        ...(target.hint ? { hint: target.hint } : {}),
        destinations,
      });
    }
    return out;
  }

  /**
   * Where a channel can post: for Slack, the channels the bot is in; for
   * every platform, the conversations people have written to it in.
   */
  async knownDestinations(gateway: Gateway): Promise<PostDestination[]> {
    const found = new Map<string, PostDestination>();
    const add = (to: string | undefined | null, label: string | undefined, context?: Record<string, string>) => {
      const key = typeof to === 'string' ? to.trim() : '';
      if (!key || found.has(key) || found.size >= MAX_DESTINATIONS) return;
      found.set(key, { to: key, label: (label || key).slice(0, MAX_LABEL_CHARS), ...(context ? { context } : {}) });
    };
    const slackNames = new Map<string, string>();
    if (gateway.type === 'slack') {
      const config = await this.channelGateway.channelConfig(gateway, 'channel_outbound');
      for (const c of await this.slack.listChannels(config)) {
        slackNames.set(c.id, c.name);
        add(c.id, `#${c.name}`);
      }
    }
    for (const { message, raw } of await this.channelGateway.recentConversations(gateway)) {
      const meta = message.metadata ?? {};
      const who = message.sender?.name;
      switch (gateway.type) {
        case 'slack':
          add(meta.channel, slackNames.has(meta.channel) ? `#${slackNames.get(meta.channel)}` : meta.channel);
          break;
        case 'microsoft_teams': {
          const conv = raw?.conversation ?? {};
          const label =
            conv.name ||
            (conv.conversationType === 'personal' ? `Chat with ${raw?.from?.name ?? 'someone'}` : 'Teams conversation');
          if (meta.serviceUrl) add(meta.conversationId, label, { serviceUrl: String(meta.serviceUrl) });
          break;
        }
        case 'telegram': {
          const chat = raw?.message?.chat ?? {};
          add(message.threadId, chat.title || (chat.username ? `@${chat.username}` : chat.first_name) || message.threadId);
          break;
        }
        case 'discord':
          add(meta.channelId, `Channel ${meta.channelId}`);
          break;
        case 'whatsapp': {
          const number = String(message.threadId ?? message.userId ?? '').replace(/^whatsapp:/i, '');
          add(number, raw?.ProfileName ? `${raw.ProfileName} (${number})` : number);
          break;
        }
        case 'whatsapp_cloud': {
          const number = /^\d+$/.test(message.userId) ? `+${message.userId}` : message.userId;
          add(number, who ? `${who} (${number})` : number);
          break;
        }
        case 'signal':
          if (meta.groupId) add(`group.${String(meta.groupId).replace(/^group\./, '')}`, 'Signal group');
          else add(message.userId, who ? `${who} (${message.userId})` : message.userId);
          break;
        case 'matrix':
        case 'irc':
          add(message.threadId, message.threadId);
          break;
        default: {
          // SMS and the iMessage relays: the sender's number or address.
          const address = String(message.threadId ?? message.userId ?? '');
          add(address, who ? `${who} (${address})` : address);
        }
      }
    }
    return [...found.values()];
  }

  async checkDestination(agent: Agent, delivery: ChannelDelivery): Promise<ChannelDelivery> {
    const { channel, gateway, target } = await this.resolve(agent, delivery?.channelId);
    if (!target) throw new BadRequestException(`The ${channel.name} channel cannot post messages on its own.`);
    const reason = this.unavailable(channel, gateway);
    if (reason) throw new BadRequestException(`${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`);
    if (target.choose === 'fixed') {
      return { kind: 'channel', channelId: channel.id, label: channel.name };
    }
    const to = target.normalize(String(delivery.to ?? ''));
    let context: Record<string, string> | undefined;
    let label = typeof delivery.label === 'string' && delivery.label.trim() ? delivery.label.trim().slice(0, MAX_LABEL_CHARS) : to;
    if (target.choose === 'pick') {
      // Only a place the channel has talked in: Teams needs the service
      // address that came with that conversation.
      const known = (await this.knownDestinations(gateway!)).find((d) => d.to === to);
      if (!known) throw new BadRequestException(`Choose a ${target.noun.toLowerCase()} from the list.`);
      context = known.context;
      label = known.label;
    } else if (target.choose === 'pick_or_enter' && label === to) {
      // A typed ID the channel knows by name reads as that name (#sales), not the ID.
      const known = await this.knownDestinations(gateway!).catch(() => [] as PostDestination[]);
      label = known.find((d) => d.to === to)?.label ?? label;
    }
    return { kind: 'channel', channelId: channel.id, to, label, ...(context ? { context } : {}) };
  }

  async admit(agent: Agent, delivery: ChannelDelivery): Promise<{ ok: true } | { ok: false; reason: string }> {
    let resolved: Awaited<ReturnType<ScheduledPostService['resolve']>>;
    try {
      resolved = await this.resolve(agent, delivery.channelId);
    } catch {
      return { ok: false, reason: 'the channel the result goes to no longer exists' };
    }
    const { channel, gateway, target } = resolved;
    if (!target) return { ok: false, reason: `the ${channel.name} channel cannot post messages on its own` };
    const reason = this.unavailable(channel, gateway);
    if (reason) return { ok: false, reason };
    if (this.policies && gateway) {
      const reached = await this.policies.reachedFor(await this.policies.forGateway(gateway));
      if (reached) {
        return {
          ok: false,
          reason: `the ${channel.name} channel has reached its spend limit for ${reached.reached === 'day' ? 'today' : 'this month'}`,
        };
      }
    }
    return { ok: true };
  }

  async post(
    agent: Agent,
    execution: ScheduledResult,
    delivery: ChannelDelivery,
    when: { timezone?: string } = {},
  ): Promise<ChannelDeliveryOutcome> {
    const base = {
      channelId: delivery.channelId,
      destination: delivery.label || delivery.to || undefined,
      at: new Date().toISOString(),
    };
    let outcome: ChannelDeliveryOutcome;
    let resolved: Awaited<ReturnType<ScheduledPostService['resolve']>> | null = null;
    try {
      resolved = await this.resolve(agent, delivery.channelId);
    } catch {
      resolved = null;
    }
    const channel = resolved?.channel;
    const gateway = resolved?.gateway ?? null;
    const target = resolved?.target ?? null;
    const named = { ...base, ...(channel ? { channelName: channel.name, channelType: channel.type } : {}) };

    if (execution.status !== 'completed') {
      // The failed run is reported on its own (run.failed); a channel is
      // not told about it.
      outcome = { ...named, status: 'skipped', error: 'the run did not finish, so there was nothing to post' };
      await this.record(execution, outcome);
      return outcome;
    }
    const text = resultText(execution.output).trim();
    const refusal = !channel
      ? 'the channel the result goes to no longer exists'
      : !target
        ? `the ${channel.name} channel cannot post messages on its own`
        : this.unavailable(channel, gateway) ?? (text ? null : 'the run finished without any output');
    if (refusal) {
      outcome = { ...named, status: 'skipped', error: refusal };
      await this.record(execution, outcome);
      await this.notify(agent, execution, outcome);
      return outcome;
    }

    // EU AI Act Art. 50: people are told they are talking to an AI once per
    // conversation, as replies are (applyAiDisclosure). A Slack channel, a
    // chat or a number is one ongoing conversation, told on the first post
    // there; an email is a conversation of its own, told every time.
    const destination = String(delivery.to ?? '');
    const line = ChannelGatewayService.disclosureLine(gateway!);
    const disclose =
      !!line && (target!.eachPostIsNewConversation || !(await this.channelGateway.disclosedTo(gateway!, destination)));
    const full = disclose ? `${line}\n\n${text}` : text;
    const { parts, truncated } = splitMessage(full, target!.maxChars, target!.maxParts);
    const context = {
      ...target!.threadContext(delivery),
      newThread: true,
      subject: `${agent.name}, ${dayIn(when.timezone, new Date())}`,
    };
    try {
      await this.channelGateway.postMessage(gateway!, parts, context, { destination, disclosed: disclose });
      outcome = { ...named, status: 'delivered', parts: parts.length, ...(truncated ? { truncated: true } : {}) };
    } catch (err: any) {
      outcome = { ...named, status: 'failed', error: String(err?.message ?? err).slice(0, 500) };
      this.logger.warn(`Scheduled result for execution ${execution.id} not posted: ${outcome.error}`);
    }
    await this.record(execution, outcome);
    if (outcome.status !== 'delivered') await this.notify(agent, execution, outcome);
    return outcome;
  }

  /** Written onto the run, beside the webhook's outcome. Recording must not become its own failure. */
  private async record(execution: ScheduledResult, outcome: ChannelDeliveryOutcome): Promise<void> {
    execution.metadata = { ...(execution.metadata ?? {}), channelDelivery: outcome };
    // A daily summary is no row of its own.
    if (execution.kind === 'digest') return;
    try {
      if (execution.kind === 'run') await this.runs?.update(execution.id, { metadata: execution.metadata });
      else await this.executions.update(execution.id, { metadata: execution.metadata });
    } catch (err: any) {
      this.logger.warn(`Could not record the channel post for ${execution.id}: ${err?.message ?? err}`);
    }
  }

  /**
   * Tell the owner a result did not reach its channel. The run.failed
   * type, so it follows the same preferences (in the app; email off by
   * default) and a private agent's note goes to its owner alone.
   */
  private async notify(agent: Agent, execution: ScheduledResult, outcome: ChannelDeliveryOutcome): Promise<void> {
    if (!this.notifications) return;
    const recipient = agent.visibility === 'private' ? resourceOwnerId(agent) : execution.userId;
    if (!recipient) return;
    const where = [outcome.channelName, outcome.destination].filter(Boolean).join(', ');
    await this.notifications
      .emit({
        type: 'run.failed',
        organizationId: agent.organizationId,
        userIds: [recipient],
        title: `Result not posted: ${agent.name}`,
        body: `The scheduled result was not posted${where ? ` to ${where}` : ''}: ${outcome.error ?? 'unknown reason'}`,
        link: `/agents/${agent.id}`,
      })
      .catch(() => undefined);
  }
}
