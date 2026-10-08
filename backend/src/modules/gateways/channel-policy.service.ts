import { HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import { Repository } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { AgentChannel, VisitorPrivacy } from '../../entities/agent-channel.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import type { Gateway } from '../../entities/gateway.entity';
import { OrganizationRole } from '../../entities/user-organization.entity';
import { SpendCaps, effectiveVisitorRules } from '../agent-channels/channel-rules';
import { NotificationsService } from '../notifications/notifications.service';
import { ChannelLinkService, LinkedChannel } from './channel-link.service';

/** Which period's cap was reached. */
export type SpendPeriod = 'day' | 'month';

/** What a visitor is told when the spend allowance is used up. Plain words, no numbers. */
export const SPEND_CAP_MESSAGES: Readonly<Record<SpendPeriod, string>> = Object.freeze({
  day: 'This chat has reached its limit for today.',
  month: 'This chat has reached its limit for this month.',
});

export interface SpendStatus {
  caps: SpendCaps;
  /** Cents spent in the current UTC day and month. */
  todayCents: number;
  monthCents: number;
  /** The cap that is currently reached, or null while it answers. */
  reached: SpendPeriod | null;
  /** When the reached cap lifts (start of the next UTC day or month). */
  resetsAt: string | null;
}

/** Whose allowance a spend is counted against: the agent's shared one, or one channel's own. */
export type SpendScope =
  | { kind: 'agent'; agent: Pick<Agent, 'id' | 'organizationId' | 'name' | 'visitorRules'> }
  | { kind: 'channel'; channel: Pick<AgentChannel, 'id' | 'organizationId' | 'agentId' | 'visitorRules'>; agent: Pick<Agent, 'id' | 'name' | 'visitorRules'> };

/**
 * The run options every channel starts a run with.
 *
 * `channelId` stamps the run for the spend caps, `gatewayId` files a new
 * conversation under the channel's gateway (what retention and visitor
 * erasure look it up by), `maxCostCents` is the per-run cap, and the
 * metadata marks the run as a visitor's, so shared memory stays out of
 * reach unless the agent (or channel) opted its visitors in.
 */
export interface ChannelRunOptions {
  channelId: string | null;
  gatewayId: string;
  maxCostCents?: number;
  metadata: {
    appVisitor: true;
    visitorMemory: boolean;
    channelId?: string;
    /** On an A2A channel: its gateway and the caller's credential (withA2ACaller). */
    gatewayId?: string;
    a2aCaller?: string;
  };
}

export interface ChannelPolicy {
  channel: LinkedChannel | null;
  privacy: Required<VisitorPrivacy>;
  runOptions: ChannelRunOptions;
}

/**
 * Merge a channel's run options into the options a caller already builds.
 * Metadata is merged, not replaced: messaging channels carry their thread
 * and sender facts on the same object.
 */
export function withChannelPolicy<T extends object>(
  policy: ChannelPolicy | null | undefined,
  options: T,
): T & Partial<ChannelRunOptions> {
  if (!policy) return options as T & Partial<ChannelRunOptions>;
  const { metadata, ...rest } = policy.runOptions;
  const own = (options as { metadata?: Record<string, any> }).metadata ?? {};
  return { ...options, ...rest, metadata: { ...own, ...metadata } } as T & Partial<ChannelRunOptions>;
}

/**
 * The channel's run options with the A2A caller stamped on them. A2A
 * callers have no visitor row, so the gateway and the caller's credential
 * on each run are how an owner answering that caller's data request finds
 * the runs it started (VisitorDataService.forA2ACaller). A caller with no
 * credential of its own is filed under the gateway alone.
 */
export function withA2ACaller(policy: ChannelPolicy, gatewayId: string, callerId: string | null): ChannelPolicy {
  return {
    ...policy,
    runOptions: {
      ...policy.runOptions,
      metadata: { ...policy.runOptions.metadata, gatewayId, ...(callerId ? { a2aCaller: callerId } : {}) },
    },
  };
}

/** Raised when the spend allowance is used up. 429 with a stable code and the visitor's sentence. */
export class SpendCapReachedException extends HttpException {
  constructor(readonly period: SpendPeriod, readonly resetsAt: string | null) {
    super(
      { code: 'CHANNEL_SPEND_CAP_REACHED', message: SPEND_CAP_MESSAGES[period], period, resetsAt },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Start of the UTC day and month containing `now`, and the next of each. */
export function spendPeriods(now: Date): { dayStart: Date; nextDay: Date; monthStart: Date; nextMonth: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  return {
    dayStart: new Date(Date.UTC(y, m, d)),
    nextDay: new Date(Date.UTC(y, m, d + 1)),
    monthStart: new Date(Date.UTC(y, m, 1)),
    nextMonth: new Date(Date.UTC(y, m + 1, 1)),
  };
}

/**
 * Who an A2A caller is, for their own rate-limit share.
 *
 * A2A callers are machines holding a credential, so the credential is the
 * identity: the API key id, the OAuth client, or the signed-in user behind
 * a JWT. A caller with none of those gets no share of its own and is
 * bounded by the address and channel limits alone.
 */
export function a2aCallerId(auth: { userId?: string; metadata?: Record<string, any> } | null | undefined): string | null {
  const meta = auth?.metadata ?? {};
  if (typeof meta.keyId === 'string' && meta.keyId) return `key:${meta.keyId}`;
  if (typeof meta.clientId === 'string' && meta.clientId) return `oauth:${meta.clientId}`;
  const sub = meta.jwtPayload?.sub;
  if (typeof sub === 'string' && sub) return `jwt:${sub}`;
  if (typeof auth?.userId === 'string' && auth.userId) return `user:${auth.userId}`;
  return null;
}

/**
 * The limits and privacy an agent (and each of its channels) puts on
 * every visitor message.
 *
 * Every channel that answers visitors -- web chat, website widget,
 * messaging platform, A2A -- asks here before it starts a run, so they
 * cannot drift apart: the per-run cost cap, the spend caps, and whether
 * visitor conversations may reach shared memory, all resolved from the
 * agent with the channel's overrides on every message. Per-visitor and
 * per-IP rate limits stay in GatewayRateLimitService; this is what those
 * could never bound, the total.
 *
 * A spend cap is scoped to where it is set. Channels that inherit the
 * agent's share one allowance (every visitor run of the agent on such a
 * channel); a channel that sets its own spend cap has an allowance of its
 * own. The cap is checked before a run starts, against the cost runs have
 * already recorded, so the overshoot is at most one per-run cap per
 * conversation running when it is crossed.
 */
@Injectable()
export class ChannelPolicyService {
  private readonly logger = new Logger(ChannelPolicyService.name);
  /** Periods already notified in this process, when there is no Redis to share the mark. */
  private readonly notifiedLocally = new Set<string>();

  constructor(
    private readonly channelLink: ChannelLinkService,
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    @InjectRepository(AgentChannel)
    private readonly channelRepository: Repository<AgentChannel>,
    // Global pipeline; optional so positional unit specs can construct this.
    @Optional() private readonly notifications?: NotificationsService,
    // Shares the notified-once mark across replicas. Optional: without it
    // each replica notifies once per period.
    @Optional() @InjectRedis() private readonly redis?: Redis.Redis,
  ) {}

  /** The channel a gateway answers for, and the run options it imposes. */
  async forGateway(gateway: Gateway): Promise<ChannelPolicy> {
    const channel = await this.channelLink.channelFor(gateway.organizationId, gateway.id);
    const rules = channel ? effectiveVisitorRules(channel.agent, channel) : null;
    const privacy = rules?.privacy ?? effectiveVisitorRules({ name: '' }).privacy;
    const costCap = rules?.limits.costCapCents;
    return {
      channel,
      privacy,
      runOptions: {
        channelId: channel?.id ?? null,
        gatewayId: gateway.id,
        ...(typeof costCap === 'number' && costCap > 0 ? { maxCostCents: Math.floor(costCap) } : {}),
        metadata: {
          appVisitor: true,
          visitorMemory: privacy.visitorMemory,
          ...(channel ? { channelId: channel.id } : {}),
        },
      },
    };
  }

  /**
   * Resolve the policy and refuse when the spend allowance is used up.
   * Throws SpendCapReachedException (429, CHANNEL_SPEND_CAP_REACHED, the code the hosted chat and widget clients read) with the
   * sentence a visitor is shown.
   */
  async admit(gateway: Gateway): Promise<ChannelPolicy> {
    const policy = await this.forGateway(gateway);
    const reached = await this.reachedFor(policy);
    if (reached) throw new SpendCapReachedException(reached.reached, reached.resetsAt);
    return policy;
  }

  /** The reached cap for a resolved policy, or null while it may answer. Notifies the owner once per period. */
  async reachedFor(policy: ChannelPolicy): Promise<{ reached: SpendPeriod; resetsAt: string | null } | null> {
    const channel = policy.channel;
    if (!channel) return null;
    const scope = this.scopeOf(channel);
    const status = await this.spendStatus(scope);
    if (!status.reached) return null;
    void this.notifyOwner(scope, status);
    return { reached: status.reached, resetsAt: status.resetsAt };
  }

  /** Whose allowance a channel spends from: its own when it sets a spend cap, else its agent's. */
  scopeOf(channel: LinkedChannel): SpendScope {
    return effectiveVisitorRules(channel.agent, channel).ownSpend
      ? { kind: 'channel', channel, agent: channel.agent }
      : { kind: 'agent', agent: channel.agent };
  }

  /** What an allowance has spent this UTC day and month, against its caps. */
  async spendStatus(scope: SpendScope, now = new Date()): Promise<SpendStatus> {
    const caps =
      scope.kind === 'channel'
        ? effectiveVisitorRules(scope.agent, scope.channel).caps
        : effectiveVisitorRules(scope.agent).caps;
    const { dayStart, nextDay, monthStart, nextMonth } = spendPeriods(now);
    const [todayCents, monthCents] = await Promise.all([this.spentSince(scope, dayStart), this.spentSince(scope, monthStart)]);
    let reached: SpendPeriod | null = null;
    let resetsAt: string | null = null;
    // The month is checked first: a month cap reached lifts later, so it is
    // the one worth naming when both are.
    if (caps.monthlyCents != null && monthCents >= caps.monthlyCents) {
      reached = 'month';
      resetsAt = nextMonth.toISOString();
    } else if (caps.dailyCents != null && todayCents >= caps.dailyCents) {
      reached = 'day';
      resetsAt = nextDay.toISOString();
    }
    return { caps, todayCents, monthCents, reached, resetsAt };
  }

  /**
   * Cost of the allowance's runs active since `from`, in cents.
   *
   * Counted by updatedAt, not createdAt: a widget thread or a Slack thread
   * keeps one run open across days, and a cap counted by when the run
   * started would never see what it spends after midnight. Such a run
   * counts in full on each day it is active, which errs towards stopping
   * early rather than late.
   *
   * The agent's allowance counts every visitor run of the agent (every run
   * stamped with a channel) except those on channels that have an
   * allowance of their own.
   */
  private async spentSince(scope: SpendScope, from: Date): Promise<number> {
    const query = this.runRepository
      .createQueryBuilder('run')
      .select('COALESCE(SUM(run.totalCost), 0)', 'total');
    if (scope.kind === 'channel') {
      query
        .where('run.channelId = :channelId', { channelId: scope.channel.id })
        .andWhere('run.organizationId = :organizationId', { organizationId: scope.channel.organizationId });
    } else {
      const own = await this.channelsWithOwnSpend(scope.agent as Agent);
      query
        .where('run.agentId = :agentId', { agentId: scope.agent.id })
        .andWhere('run.organizationId = :organizationId', { organizationId: scope.agent.organizationId })
        .andWhere('run.channelId IS NOT NULL');
      if (own.length) query.andWhere('run.channelId NOT IN (:...own)', { own });
    }
    query.andWhere('run.updatedAt >= :from', { from });
    const row = await query.getRawOne<{ total: string | number | null }>();
    return Math.round(parseFloat(String(row?.total ?? '0')) * 100);
  }

  /** The agent's channels that set a spend cap of their own, and so spend outside its allowance. */
  private async channelsWithOwnSpend(agent: Pick<Agent, 'id' | 'organizationId' | 'name' | 'visitorRules'>): Promise<string[]> {
    const channels = await this.channelRepository.find({
      where: { agentId: agent.id, organizationId: agent.organizationId },
      select: { id: true, visitorRules: true },
    });
    return channels.filter((c) => effectiveVisitorRules(agent, c).ownSpend).map((c) => c.id);
  }

  /**
   * Tell the organization's owners and admins, once per allowance per
   * period. In-app, under the spend-alert type, so it respects the same
   * preferences a budget alert does and links to the agent's channels.
   */
  private async notifyOwner(scope: SpendScope, status: SpendStatus): Promise<void> {
    if (!this.notifications || !status.reached) return;
    const periodKey = status.reached === 'day' ? status.resetsAt?.slice(0, 10) : status.resetsAt?.slice(0, 7);
    const id = scope.kind === 'channel' ? `channel:${scope.channel.id}` : `agent:${scope.agent.id}`;
    const key = `spend_notified:${id}:${status.reached}:${periodKey}`;
    const organizationId = scope.kind === 'channel' ? scope.channel.organizationId : scope.agent.organizationId;
    const who = scope.kind === 'channel' ? `A channel of ${scope.agent.name}` : `${scope.agent.name}'s channels`;
    const link =
      scope.kind === 'channel'
        ? `/agents/${scope.agent.id}/channels/${scope.channel.id}`
        : `/agents/${scope.agent.id}?tab=channels`;
    try {
      if (!(await this.firstTime(key))) return;
      const cap = status.reached === 'day' ? status.caps.dailyCents : status.caps.monthlyCents;
      const spent = status.reached === 'day' ? status.todayCents : status.monthCents;
      await this.notifications.emit({
        type: 'budget.alert',
        organizationId,
        roleTarget: { orgRoles: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
        title: `${who} reached the spend limit for ${status.reached === 'day' ? 'today' : 'this month'}`,
        body:
          `They have spent $${(spent / 100).toFixed(2)} of the $${((cap ?? 0) / 100).toFixed(2)} limit, ` +
          'so visitors are told it has reached its limit until the limit resets or you raise it.',
        link,
      });
    } catch (err: any) {
      this.logger.warn(`Could not notify about ${id} spend limit: ${err?.message ?? err}`);
    }
  }

  /** True the first time `key` is seen in its period (shared through Redis when there is one). */
  private async firstTime(key: string): Promise<boolean> {
    if (this.redis) {
      try {
        const set = await this.redis.set(key, '1', 'EX', 32 * 24 * 3600, 'NX');
        return set === 'OK';
      } catch {
        // Fall through to the process-local mark.
      }
    }
    if (this.notifiedLocally.has(key)) return false;
    this.notifiedLocally.add(key);
    return true;
  }
}
