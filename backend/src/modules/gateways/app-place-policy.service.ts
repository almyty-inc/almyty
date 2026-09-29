import { HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import { Repository } from 'typeorm';

import { AgentRun } from '../../entities/agent-run.entity';
import { AgentApp, AppPrivacySettings, appPrivacyFrom } from '../../entities/agent-app.entity';
import type { Gateway } from '../../entities/gateway.entity';
import { OrganizationRole } from '../../entities/user-organization.entity';
import { AppSpendCaps, appSpendCapsFrom } from '../agent-apps/agent-app.rules';
import { NotificationsService } from '../notifications/notifications.service';
import { GatewayAppLinkService } from './gateway-app-link.service';

/** Which period's cap was reached. */
export type AppSpendPeriod = 'day' | 'month';

/** What a visitor is told when the app has spent its allowance. Plain words, no numbers. */
export const APP_SPEND_CAP_MESSAGES: Readonly<Record<AppSpendPeriod, string>> = Object.freeze({
  day: 'This app has reached its limit for today.',
  month: 'This app has reached its limit for this month.',
});

export interface AppSpendStatus {
  caps: AppSpendCaps;
  /** Cents spent in the current UTC day and month. */
  todayCents: number;
  monthCents: number;
  /** The cap that is currently reached, or null while the app answers. */
  reached: AppSpendPeriod | null;
  /** When the reached cap lifts (start of the next UTC day or month). */
  resetsAt: string | null;
}

/**
 * The run options every app place starts a run with.
 *
 * `appId` stamps the run for the spend cap, `gatewayId` files a new
 * conversation under the place (what per-app retention and visitor
 * erasure look it up by), `maxCostCents` is the app's per-run cap, and
 * the metadata marks the run as a visitor's, so shared memory stays out
 * of reach unless the app opted its visitors in.
 */
export interface AppPlaceRunOptions {
  appId: string | null;
  gatewayId: string;
  maxCostCents?: number;
  metadata: { appVisitor: true; visitorMemory: boolean; appId?: string };
}

export interface AppPlace {
  app: AgentApp | null;
  privacy: Required<AppPrivacySettings>;
  runOptions: AppPlaceRunOptions;
}

/**
 * Merge a place's run options into the options a caller already builds.
 * Metadata is merged, not replaced: channels carry their thread and
 * sender facts on the same object.
 */
export function withPlace<T extends object>(
  place: AppPlace | null | undefined,
  options: T,
): T & Partial<AppPlaceRunOptions> {
  if (!place) return options as T & Partial<AppPlaceRunOptions>;
  const { metadata, ...rest } = place.runOptions;
  const own = (options as { metadata?: Record<string, any> }).metadata ?? {};
  return { ...options, ...rest, metadata: { ...own, ...metadata } } as T & Partial<AppPlaceRunOptions>;
}

/** Raised when an app has spent its allowance. 429 with a stable code and the visitor's sentence. */
export class AppSpendCapReachedException extends HttpException {
  constructor(readonly period: AppSpendPeriod, readonly resetsAt: string | null) {
    super(
      { code: 'APP_SPEND_CAP_REACHED', message: APP_SPEND_CAP_MESSAGES[period], period, resetsAt },
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
 * a JWT. A caller with none of those (a gateway with no auth configured,
 * which the auth layer refuses anyway) gets no share of its own and is
 * bounded by the address and surface limits alone.
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
 * The limits and privacy an app puts on each of its places.
 *
 * Every place an app answers on -- web chat, website widget, messaging
 * channel, A2A -- asks here before it starts a run, so the four of them
 * cannot drift apart: the app's per-run cost cap, its spend cap across all
 * places and visitors, and whether visitor conversations may reach shared
 * memory, all read from the app on every message. Per-visitor and per-IP
 * rate limits stay in GatewayRateLimitService; this is what the rate
 * limits could never bound, the product's total.
 *
 * The spend cap is checked before a run starts, against the cost runs
 * have already recorded. A run in flight when the cap is crossed finishes
 * under its own per-run cap, so the overshoot is at most one per-run cap
 * per conversation running at that moment.
 */
@Injectable()
export class AppPlacePolicyService {
  private readonly logger = new Logger(AppPlacePolicyService.name);
  /** Periods already notified in this process, when there is no Redis to share the mark. */
  private readonly notifiedLocally = new Set<string>();

  constructor(
    private readonly appLink: GatewayAppLinkService,
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    // Global pipeline; optional so positional unit specs can construct this.
    @Optional() private readonly notifications?: NotificationsService,
    // Shares the notified-once mark across replicas. Optional: without it
    // each replica notifies once per period.
    @Optional() @InjectRedis() private readonly redis?: Redis.Redis,
  ) {}

  /** The app a gateway is a place of, and the run options it imposes. */
  async forGateway(gateway: Gateway): Promise<AppPlace> {
    const found = await this.appLink.distributionFor(gateway.organizationId, gateway.id);
    const app = found?.app ?? null;
    const privacy = appPrivacyFrom(app?.privacy);
    const costCap = app?.limits?.costCapCents;
    return {
      app,
      privacy,
      runOptions: {
        appId: app?.id ?? null,
        gatewayId: gateway.id,
        ...(typeof costCap === 'number' && costCap > 0 ? { maxCostCents: Math.floor(costCap) } : {}),
        metadata: {
          appVisitor: true,
          visitorMemory: privacy.visitorMemory,
          ...(app ? { appId: app.id } : {}),
        },
      },
    };
  }

  /**
   * Resolve the place and refuse when the app has spent its allowance.
   * Throws AppSpendCapReachedException (429, APP_SPEND_CAP_REACHED) with
   * the sentence a visitor is shown.
   */
  async admit(gateway: Gateway): Promise<AppPlace> {
    const place = await this.forGateway(gateway);
    const reached = await this.reachedFor(place);
    if (reached) throw new AppSpendCapReachedException(reached.reached, reached.resetsAt);
    return place;
  }

  /** The reached cap for a resolved place, or null while it may answer. Notifies the owner once per period. */
  async reachedFor(place: AppPlace): Promise<{ reached: AppSpendPeriod; resetsAt: string | null } | null> {
    if (!place.app) return null;
    const status = await this.spendStatus(place.app);
    if (!status.reached) return null;
    void this.notifyOwner(place.app, status);
    return { reached: status.reached, resetsAt: status.resetsAt };
  }

  /** What the app has spent this UTC day and month, against its caps. */
  async spendStatus(app: Pick<AgentApp, 'id' | 'organizationId' | 'limits' | 'authMode'>, now = new Date()): Promise<AppSpendStatus> {
    const caps = appSpendCapsFrom(app);
    const { dayStart, nextDay, monthStart, nextMonth } = spendPeriods(now);
    const [todayCents, monthCents] = await Promise.all([
      this.spentSince(app, dayStart),
      this.spentSince(app, monthStart),
    ]);
    let reached: AppSpendPeriod | null = null;
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
   * Cost of the app's runs active since `from`, in cents.
   *
   * Counted by updatedAt, not createdAt: a widget thread or a Slack thread
   * keeps one run open across days, and a cap counted by when the run
   * started would never see what it spends after midnight. The price is
   * that such a run counts in full on each day it is active, which errs
   * towards stopping early rather than late.
   */
  private async spentSince(app: Pick<AgentApp, 'id' | 'organizationId'>, from: Date): Promise<number> {
    const row = await this.runRepository
      .createQueryBuilder('run')
      .select('COALESCE(SUM(run.totalCost), 0)', 'total')
      .where('run.appId = :appId', { appId: app.id })
      .andWhere('run.organizationId = :organizationId', { organizationId: app.organizationId })
      .andWhere('run.updatedAt >= :from', { from })
      .getRawOne<{ total: string | number | null }>();
    return Math.round(parseFloat(String(row?.total ?? '0')) * 100);
  }

  /**
   * Tell the organization's owners and admins, once per app per period.
   * In-app, under the spend-alert type, so it respects the same
   * preferences a budget alert does and links to the app's page.
   */
  private async notifyOwner(app: Pick<AgentApp, 'id' | 'organizationId' | 'name' | 'slug'>, status: AppSpendStatus): Promise<void> {
    if (!this.notifications || !status.reached) return;
    const periodKey = status.reached === 'day' ? status.resetsAt?.slice(0, 10) : status.resetsAt?.slice(0, 7);
    const key = `app_spend_notified:${app.id}:${status.reached}:${periodKey}`;
    try {
      if (!(await this.firstTime(key))) return;
      const cap = status.reached === 'day' ? status.caps.dailyCents : status.caps.monthlyCents;
      const spent = status.reached === 'day' ? status.todayCents : status.monthCents;
      await this.notifications.emit({
        type: 'budget.alert',
        organizationId: app.organizationId,
        roleTarget: { orgRoles: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
        title: `${app.name} reached its spend limit for ${status.reached === 'day' ? 'today' : 'this month'}`,
        body:
          `It has spent $${(spent / 100).toFixed(2)} of its $${((cap ?? 0) / 100).toFixed(2)} limit, ` +
          'so visitors are told it has reached its limit until the limit resets or you raise it.',
        link: `/apps/${app.slug}`,
      });
    } catch (err: any) {
      this.logger.warn(`Could not notify about app ${app.id} spend limit: ${err?.message ?? err}`);
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
