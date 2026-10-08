import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { AgentChannel, ChannelType, isMessagingChannel } from '../../entities/agent-channel.entity';
import { AuditAction, AuditLog } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  VisitorChannel,
  VisitorDataExport,
  VisitorDataService,
  VisitorDataSummary,
  VisitorErasure,
  VisitorFootprint,
  mergeFootprints,
} from '../gateways/visitor-data.service';
import { visitorDataAudit } from '../gateways/visitor-data-audit';
import { AgentChannelsService, Caller } from './agent-channels.service';

/** A person, as the owner knows them: what identifies them, and on which channel (all of them when left out). */
export interface DataRequestSubject {
  channelId?: string | null;
  id: string;
}

/** A channel the person was found on. */
export interface FoundOnChannel {
  id: string;
  name: string;
  type: ChannelType;
}

/** What a lookup answers: what is held, and on which channels. */
export interface DataRequestLookup extends VisitorDataSummary {
  channels: FoundOnChannel[];
}

/** Whether people talk to the agent on this kind of channel, so it can hold their data. */
export function holdsVisitorData(type: ChannelType | string): boolean {
  return type === ChannelType.WEB || type === ChannelType.WIDGET || type === ChannelType.A2A || isMessagingChannel(type);
}

/**
 * An owner or admin answering a data request for one person, across the
 * agent's channels.
 *
 * People on the web chat and the website widget can download and delete
 * their own data. People who reached the agent on a messaging channel or
 * over A2A cannot: there is no page to put a button on. They ask the
 * owner, who looks them up here by what they know about them (an email
 * address, a phone number, a Slack member id, a widget conversation id,
 * an A2A key), on one channel or all of them, and sends them their copy
 * or erases it. Same scope as the self-service paths, because it is the
 * same code (VisitorDataService).
 *
 * Only someone who may manage the agent, and only for that agent, by the
 * rule agent editing uses (AgentChannelsService.manageableAgent): an
 * admin or owner of the organization, or the member who owns the agent.
 * Another organization's agent, or one the caller cannot manage, answers
 * as it does everywhere else. Every export and erasure is written to the
 * audit log with counts and a hashed reference to the person, never the
 * identifier or any content.
 */
@Injectable()
export class VisitorDataRequestsService {
  constructor(
    @InjectRepository(AgentChannel)
    private readonly channelRepository: Repository<AgentChannel>,
    private readonly channels: AgentChannelsService,
    private readonly visitorData: VisitorDataService,
    // Required: an export or erasure that cannot be recorded does not happen.
    private readonly audit: AuditLogService,
  ) {}

  /** What is held for the person, in counts and dates, and the channels it was found on. */
  async lookup(organizationId: string, agentId: string, caller: Caller, subject: DataRequestSubject): Promise<DataRequestLookup> {
    const { footprint, found } = await this.resolve(organizationId, agentId, caller, subject);
    return { ...(await this.visitorData.summarize(footprint)), channels: found };
  }

  /**
   * Everything held for the person, for them to keep. Recorded before it
   * is handed over: if the audit row cannot be written, nothing is exported.
   */
  async export(
    organizationId: string,
    agentId: string,
    caller: Caller,
    subject: DataRequestSubject,
  ): Promise<VisitorDataExport & { agent: string; channels: FoundOnChannel[] }> {
    const { agent, footprint, found } = await this.resolve(organizationId, agentId, caller, subject);
    const data = await this.visitorData.export(footprint);
    const recorded = await this.audit.log(
      visitorDataAudit({
        action: AuditAction.VISITOR_DATA_EXPORT,
        organizationId,
        agentId: agent.id,
        agentName: agent.name,
        userId: caller.id,
        channel: subject.channelId || 'all',
        identifier: subject.id,
        counts: {
          conversations: data.conversations.length,
          messages: data.conversations.reduce((n, c) => n + c.messages.length, 0),
          memories: data.memories.length,
          files: data.files.length,
          storedReplies: data.storedReplies.length,
          unanswered: data.unanswered.length,
          runs: data.runs.length,
        },
      }),
    );
    if (!recorded) {
      throw new ServiceUnavailableException('This request could not be recorded, so nothing was exported. Try again.');
    }
    return { agent: agent.branding?.appName || agent.name, channels: found, ...data };
  }

  /**
   * Remove everything held for the person on the agent's channels. The
   * audit row is written in the erasure's own transaction: both happen,
   * or neither.
   */
  async erase(organizationId: string, agentId: string, caller: Caller, subject: DataRequestSubject): Promise<VisitorErasure> {
    const { agent, footprint } = await this.resolve(organizationId, agentId, caller, subject);
    const written: AuditLog[] = [];
    const removed = await this.visitorData.erase(footprint, async (tx, counts) => {
      written.push(
        await this.audit.logInTransaction(
          tx,
          visitorDataAudit({
            action: AuditAction.VISITOR_DATA_ERASE,
            organizationId,
            agentId: agent.id,
            agentName: agent.name,
            userId: caller.id,
            channel: subject.channelId || 'all',
            identifier: subject.id,
            counts: { ...counts },
          }),
        ),
      );
    });
    this.audit.publishCommitted(written);
    return removed;
  }

  /**
   * The person's footprint on the agent's channels: on the one named, or
   * on every channel people talk to the agent on, each reading the
   * identifier its own way.
   */
  private async resolve(
    organizationId: string,
    agentId: string,
    caller: Caller,
    subject: DataRequestSubject,
  ): Promise<{ agent: Agent; footprint: VisitorFootprint; found: FoundOnChannel[] }> {
    const agent = await this.channels.manageableAgent(organizationId, agentId, caller);
    const id = String(subject?.id ?? '').trim();
    if (!id) throw new BadRequestException('Say who to look up.');

    const all = await this.channelRepository.find({ where: { organizationId, agentId: agent.id }, order: { createdAt: 'ASC' } });
    const usable = all.filter((c) => holdsVisitorData(c.type) && !!c.gatewayId);
    let searched = usable;
    if (subject.channelId) {
      searched = usable.filter((c) => c.id === subject.channelId);
      if (!searched.length) throw new NotFoundException('This agent has no such channel that people talk to.');
    }

    const parts: VisitorFootprint[] = [];
    const found: FoundOnChannel[] = [];
    for (const channel of searched) {
      const footprint = await this.onChannel(channel, { id: channel.gatewayId!, organizationId }, id);
      parts.push(footprint);
      if (footprint.runIds.length || footprint.conversationIds.length || footprint.endUserIds.length || footprint.unansweredEventIds.length) {
        found.push({ id: channel.id, name: channel.name, type: channel.type });
      }
    }
    return { agent, footprint: mergeFootprints(organizationId, parts), found };
  }

  /** The person on one channel, found by what that channel knows them by. */
  private async onChannel(channel: AgentChannel, gateway: VisitorChannel, id: string): Promise<VisitorFootprint> {
    switch (channel.type) {
      case ChannelType.WEB:
        return this.visitorData.forWebVisitors(gateway, await this.visitorData.findWebVisitors(gateway, id));
      case ChannelType.WIDGET:
        return this.visitorData.forWidgetThread(gateway, id);
      case ChannelType.A2A:
        return this.visitorData.forA2ACaller(gateway, id);
      default:
        return this.visitorData.forChannelSender(gateway, channel.type, id);
    }
  }
}
