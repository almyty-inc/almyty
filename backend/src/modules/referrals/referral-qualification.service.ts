import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { Referral, ReferralStatus } from '../../entities/referral.entity';
import { ReferralCode } from '../../entities/referral-code.entity';
import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { ReferralsService } from './referrals.service';

/**
 * Periodic referral sweep — same interval pattern as AgentRunReaperService
 * (an in-process timer is plenty: the checks are cheap indexed queries and
 * a missed tick just delays a reward by one interval).
 *
 * Three passes, all skipping abuse-flagged rows (those wait for manual
 * review and never auto-reward):
 *
 * 1. pending -> qualified: the referred org ACTIVATED (created at least one
 *    gateway AND ran at least one agent). Grants the referrer tier 1.
 * 2. qualified -> rewarded: the referred org converted to a PAID plan
 *    (plan is pro/enterprise AND billingInfo carries a Stripe subscription —
 *    the subscription check matters because the referee signup bonus itself
 *    flips the org to pro without any payment). Grants tier 2.
 * 3. accrual application: referrers who banked days while on free get the
 *    bank applied once their org is on pro.
 */
const SWEEP_INTERVAL_MS = Number(process.env.REFERRAL_SWEEP_INTERVAL_MS) || 10 * 60_000; // 10 min
const SWEEP_BATCH = 200;

@Injectable()
export class ReferralQualificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReferralQualificationService.name);
  private timer?: NodeJS.Timeout;

  /** One sweep per window across every replica. */
  private static readonly LOCK_KEY = 'referrals:qualification:lock';

  constructor(
    @InjectRepository(Referral)
    private readonly referralRepository: Repository<Referral>,
    @InjectRepository(ReferralCode)
    private readonly referralCodeRepository: Repository<ReferralCode>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    @InjectRepository(AgentRun)
    private readonly agentRunRepository: Repository<AgentRun>,
    private readonly referralsService: ReferralsService,
    private readonly auditLogService: AuditLogService,
    // Optional so the unit specs can construct the sweeper without Redis;
    // its absence is logged, never silently treated as a held lock.
    @Optional() @InjectRedis() private readonly redis?: Redis.Redis,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.sweep().catch((err) =>
        this.logger.error(`referral sweep failed: ${err?.message || err}`),
      );
    }, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One full sweep — public so tests (and ops) can invoke it directly. */
  async sweep(): Promise<{ qualified: number; rewarded: number; accrualsApplied: number }> {
    // One replica sweeps per window. Rewards are money (free plan days)
    // and an in-process timer runs on every replica, so two sweeps used
    // to walk the same batch. The lease is half the fix -- it can expire
    // mid-sweep -- so every transition below is claimed as well.
    const lease = await this.acquireLease();
    if (!lease.acquired) {
      this.logger.debug('referral sweep skipped — lock held by another replica');
      return { qualified: 0, rewarded: 0, accrualsApplied: 0 };
    }
    try {
      const qualified = await this.sweepPending();
      const rewarded = await this.sweepQualified();
      const accrualsApplied = await this.sweepAccruals();
      if (qualified || rewarded || accrualsApplied) {
        this.logger.log(
          `referral sweep: qualified=${qualified} rewarded=${rewarded} accrualsApplied=${accrualsApplied}`,
        );
      }
      return { qualified, rewarded, accrualsApplied };
    } finally {
      await lease.release();
    }
  }

  /**
   * Redis NX lock, the same pattern MetricsRetentionService uses. A Redis
   * that is down or absent must not stop rewards: the sweep then runs
   * unleased and says so, and the per-row claims keep it correct.
   */
  private async acquireLease(): Promise<{ acquired: boolean; release: () => Promise<void> }> {
    const unleased = { acquired: true, release: async () => undefined };
    if (!this.redis) {
      this.logger.warn('referral sweep running unleased: no Redis client');
      return unleased;
    }
    const token = randomUUID();
    const ttlSeconds = Math.max(60, Math.ceil(SWEEP_INTERVAL_MS / 1000));
    try {
      const acquired = await this.redis.set(
        ReferralQualificationService.LOCK_KEY,
        token,
        'EX',
        ttlSeconds,
        'NX',
      );
      if (acquired !== 'OK') return { acquired: false, release: async () => undefined };
      return {
        acquired: true,
        release: async () => {
          // Only if we still hold it, so a later holder is never dropped.
          await this.redis!
            .eval(
              `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
              1,
              ReferralQualificationService.LOCK_KEY,
              token,
            )
            .catch(() => undefined);
        },
      };
    } catch (err: any) {
      this.logger.warn(`referral sweep lock unavailable, sweeping unleased: ${err?.message || err}`);
      return unleased;
    }
  }

  /** pending -> qualified when the referred org has a gateway AND an agent run. */
  private async sweepPending(): Promise<number> {
    const pending = await this.referralRepository.find({
      where: { status: ReferralStatus.PENDING, abuseFlag: IsNull() },
      take: SWEEP_BATCH,
    });
    let count = 0;
    for (const referral of pending) {
      const activated = await this.isActivated(referral.referredOrganizationId);
      if (!activated) continue;
      // Verified-referee gate: attribution + activation criteria are
      // unchanged, but the pending->qualified transition (and its
      // tier-1 reward) is held until the referee verifies their email —
      // exactly like the abuse path, the row is skipped and retried on
      // a later sweep tick.
      if (!(await this.referralsService.isRefereeVerified(referral))) continue;

      // Claim the transition, never assume it.
      //
      // The sweep runs on every replica and two of them read the same
      // PENDING batch (after a rolling deploy their timers sit near each
      // other). Replica B reaches this row seconds later still holding
      // the copy it loaded, so neither the status check above nor the
      // yearly-cap arithmetic inside awardReferrerDays -- which reads
      // that stale `rewardDays` -- stopped it, and the referrer's plan
      // was extended twice. Only the UPDATE that actually moved the row
      // out of PENDING may pay out. The abuseFlag guard is here for the
      // same reason: a row flagged since the batch was read must not
      // reward.
      const qualifiedAt = new Date();
      const claim = await this.referralRepository.update(
        { id: referral.id, status: ReferralStatus.PENDING, abuseFlag: IsNull() },
        { status: ReferralStatus.QUALIFIED, qualifiedAt },
      );
      if (!claim.affected) continue;
      referral.status = ReferralStatus.QUALIFIED;
      referral.qualifiedAt = qualifiedAt;
      await this.referralsService.awardReferrerDays(
        referral,
        this.referralsService.tier1Days(),
        'tier1',
      );
      this.auditLogService.log({
        organizationId: referral.referredOrganizationId,
        userId: referral.referrerUserId,
        action: AuditAction.REFERRAL_QUALIFIED,
        resourceType: AuditResource.REFERRAL,
        resourceId: referral.id,
      });
      count++;
    }
    return count;
  }

  /** qualified -> rewarded when the referred org holds a paid Stripe subscription. */
  private async sweepQualified(): Promise<number> {
    const qualified = await this.referralRepository.find({
      where: { status: ReferralStatus.QUALIFIED, abuseFlag: IsNull() },
      take: SWEEP_BATCH,
    });
    let count = 0;
    for (const referral of qualified) {
      const org = await this.organizationRepository.findOne({
        where: { id: referral.referredOrganizationId },
      });
      if (!org) continue;
      const paid =
        ['pro', 'enterprise'].includes(org.plan) &&
        !!(org.billingInfo as any)?.stripeSubscriptionId;
      if (!paid) continue;
      // Verified-referee gate (same as the pending sweep): hold the row
      // so the tier-2 reward isn't burned while the referee is
      // unverified; retried on a later tick.
      if (!(await this.referralsService.isRefereeVerified(referral))) continue;

      // Claim the transition (see sweepPending): the tier-2 grant is the
      // same double-award shape, one status further along.
      const rewardedAt = new Date();
      const claim = await this.referralRepository.update(
        { id: referral.id, status: ReferralStatus.QUALIFIED, abuseFlag: IsNull() },
        { status: ReferralStatus.REWARDED, rewardedAt },
      );
      if (!claim.affected) continue;
      referral.status = ReferralStatus.REWARDED;
      referral.rewardedAt = rewardedAt;
      await this.referralsService.awardReferrerDays(
        referral,
        this.referralsService.tier2Days(),
        'tier2',
      );
      count++;
    }
    return count;
  }

  /** Apply banked days for referrers whose org has since upgraded to pro. */
  private async sweepAccruals(): Promise<number> {
    const codes = await this.referralCodeRepository.find({
      where: { accruedRewardDays: MoreThan(0) },
      take: SWEEP_BATCH,
    });
    let count = 0;
    for (const code of codes) {
      const applied = await this.referralsService.applyAccruedDays(code);
      if (applied > 0) count++;
    }
    return count;
  }

  /** Activation = the org created at least one gateway AND ran at least one agent. */
  private async isActivated(organizationId: string): Promise<boolean> {
    const gateways = await this.gatewayRepository.count({ where: { organizationId } });
    if (gateways === 0) return false;
    const runs = await this.agentRunRepository.count({ where: { organizationId } });
    return runs > 0;
  }
}
