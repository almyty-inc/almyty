import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import * as crypto from 'crypto';

import { ReferralCode } from '../../entities/referral-code.entity';
import { Referral, ReferralAbuseFlag, ReferralStatus } from '../../entities/referral.entity';
import { Organization } from '../../entities/organization.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import {
  isDisposableEmail,
  refereeRewardDays,
  tier1RewardDays,
  tier2RewardDays,
  yearlyCapDays,
} from './referrals.constants';

/**
 * Unambiguous code alphabet — no 0/O, 1/I/L to keep hand-typed codes sane.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_GENERATION_ATTEMPTS = 5;

export interface AttributeSignupParams {
  userId: string;
  organizationId: string;
  email: string;
  referralCode: string;
  ipAddress?: string;
}

export interface ReferralStats {
  invited: number;
  qualified: number;
  rewarded: number;
  pendingReview: number;
  totalRewardDays: number;
  accruedRewardDays: number;
}

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    @InjectRepository(ReferralCode)
    private readonly referralCodeRepository: Repository<ReferralCode>,
    @InjectRepository(Referral)
    private readonly referralRepository: Repository<Referral>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── Code lifecycle ─────────────────────────────────────────────────────

  /**
   * Create-or-get the caller's referral code. Enterprise orgs are excluded
   * from the program entirely.
   */
  async getOrCreateCode(userId: string, organizationId: string, ipAddress?: string): Promise<ReferralCode> {
    const existing = await this.referralCodeRepository.findOne({ where: { userId } });
    if (existing) return existing;

    const org = await this.organizationRepository.findOne({ where: { id: organizationId } });
    if (org?.plan === 'enterprise') {
      throw new ForbiddenException('Enterprise organizations are not part of the referral program');
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < CODE_GENERATION_ATTEMPTS; attempt++) {
      const code = this.generateCode();
      const collision = await this.referralCodeRepository.findOne({ where: { code } });
      if (collision) continue;
      try {
        return await this.referralCodeRepository.save(
          this.referralCodeRepository.create({
            userId,
            organizationId,
            code,
            active: true,
            accruedRewardDays: 0,
            createdFromIp: ipAddress || null,
          }),
        );
      } catch (err) {
        // Unique-violation race (another request or a hash collision between
        // the check and the insert) — retry with a fresh code.
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Failed to generate a unique referral code');
  }

  generateCode(): string {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return code;
  }

  buildShareLink(code: string): string {
    const base = (process.env.FRONTEND_URL || 'http://localhost:3002').replace(/\/+$/, '');
    return `${base}/r/${code}`;
  }

  async findActiveCode(code: string): Promise<ReferralCode | null> {
    if (!code) return null;
    return this.referralCodeRepository.findOne({ where: { code: code.toUpperCase(), active: true } });
  }

  // ── Signup attribution ─────────────────────────────────────────────────

  /**
   * Attribute a fresh registration to a referral code. Called from the auth
   * register path AFTER the user + org transaction committed. Never throws
   * into registration — callers swallow errors.
   *
   * Returns the created Referral, or null when attribution does not apply
   * (unknown/inactive code, self-referral, enterprise referrer, duplicate).
   */
  async attributeSignup(params: AttributeSignupParams): Promise<Referral | null> {
    const code = await this.findActiveCode(params.referralCode);
    if (!code) return null;
    if (code.userId === params.userId) return null; // self-referral

    // Enterprise orgs are excluded from the program — no attribution in
    // either direction.
    const referrerOrg = await this.organizationRepository.findOne({
      where: { id: code.organizationId },
    });
    if (!referrerOrg || referrerOrg.plan === 'enterprise') return null;

    const referredOrg = await this.organizationRepository.findOne({
      where: { id: params.organizationId },
    });
    if (!referredOrg || referredOrg.plan === 'enterprise') return null;

    // One referral per referred user, ever.
    const duplicate = await this.referralRepository.findOne({
      where: { referredUserId: params.userId },
    });
    if (duplicate) return null;

    // ── Abuse guardrails — flagged referrals never auto-reward ──────────
    let abuseFlag: ReferralAbuseFlag | null = null;
    let abuseReason: string | null = null;

    if (isDisposableEmail(params.email)) {
      abuseFlag = ReferralAbuseFlag.DISPOSABLE_EMAIL;
      abuseReason = `Referred email domain is on the disposable-email blocklist`;
    }

    if (!abuseFlag && params.ipAddress) {
      const sameIpAsReferrer = code.createdFromIp && code.createdFromIp === params.ipAddress;
      const sameIpAsSibling = await this.referralRepository.findOne({
        where: { referrerUserId: code.userId, ipAddress: params.ipAddress },
      });
      if (sameIpAsReferrer || sameIpAsSibling) {
        abuseFlag = ReferralAbuseFlag.SAME_IP;
        abuseReason = 'Referred registration IP matches the referrer';
      }
    }

    const referral = await this.referralRepository.save(
      this.referralRepository.create({
        referrerUserId: code.userId,
        referredUserId: params.userId,
        referredOrganizationId: params.organizationId,
        referralCodeId: code.id,
        status: ReferralStatus.PENDING,
        rewardDays: 0,
        abuseFlag,
        abuseReason,
        ipAddress: params.ipAddress || null,
      }),
    );

    this.auditLogService.log({
      organizationId: params.organizationId,
      userId: params.userId,
      action: AuditAction.REFERRAL_ATTRIBUTED,
      resourceType: AuditResource.REFERRAL,
      resourceId: referral.id,
      resourceName: code.code,
      details: { referrerUserId: code.userId, abuseFlag, abuseReason },
      ipAddress: params.ipAddress,
    });

    // Referee reward: 1 month of pro at signup — only for clean referrals
    // and only when the fresh org is on free (it always is at this point,
    // but stay defensive).
    if (!abuseFlag && referredOrg.plan === 'free') {
      const days = refereeRewardDays();
      referredOrg.plan = 'pro';
      referredOrg.planExpiresAt = this.addDays(new Date(), days);
      await this.organizationRepository.save(referredOrg);
      this.auditLogService.log({
        organizationId: referredOrg.id,
        userId: params.userId,
        action: AuditAction.REFERRAL_REWARDED,
        resourceType: AuditResource.REFERRAL,
        resourceId: referral.id,
        details: { kind: 'referee_signup', days },
      });
    }

    return referral;
  }

  // ── Referrer rewards ───────────────────────────────────────────────────

  /**
   * Grant reward days to the referrer for a referral, honouring:
   * - abuse flags (flagged referrals never auto-reward)
   * - enterprise exclusion (no rewards for enterprise referrer orgs)
   * - the yearly cap (max `yearlyCapDays()` banked per rolling 365 days)
   * - free-tier accrual (free referrers bank days; pro referrers get
   *   planExpiresAt extended immediately)
   *
   * Returns the number of days actually granted (banked or applied).
   */
  async awardReferrerDays(referral: Referral, days: number, trigger: 'tier1' | 'tier2'): Promise<number> {
    if (referral.abuseFlag) return 0;

    const code = referral.referralCodeId
      ? await this.referralCodeRepository.findOne({ where: { id: referral.referralCodeId } })
      : await this.referralCodeRepository.findOne({ where: { userId: referral.referrerUserId } });
    if (!code) return 0;

    const referrerOrg = await this.organizationRepository.findOne({
      where: { id: code.organizationId },
    });
    if (!referrerOrg || referrerOrg.plan === 'enterprise') return 0;

    // Yearly cap: sum of days already banked over the trailing 365 days.
    const windowStart = this.addDays(new Date(), -365);
    const recent = await this.referralRepository.find({
      where: { referrerUserId: referral.referrerUserId, qualifiedAt: MoreThanOrEqual(windowStart) },
    });
    const usedThisYear = recent
      .filter((r) => r.id !== referral.id)
      .reduce((sum, r) => sum + (r.rewardDays || 0), 0) + (referral.rewardDays || 0);
    const granted = Math.max(0, Math.min(days, yearlyCapDays() - usedThisYear));
    if (granted <= 0) return 0;

    referral.rewardDays = (referral.rewardDays || 0) + granted;
    await this.referralRepository.save(referral);

    if (referrerOrg.plan === 'pro') {
      this.extendPlan(referrerOrg, granted);
      await this.organizationRepository.save(referrerOrg);
    } else {
      // Free-tier referrer: bank the days; the qualification sweep applies
      // the bank once the org is on pro.
      code.accruedRewardDays = (code.accruedRewardDays || 0) + granted;
      await this.referralCodeRepository.save(code);
    }

    this.auditLogService.log({
      organizationId: referrerOrg.id,
      userId: referral.referrerUserId,
      action: AuditAction.REFERRAL_REWARDED,
      resourceType: AuditResource.REFERRAL,
      resourceId: referral.id,
      details: {
        kind: trigger,
        days: granted,
        applied: referrerOrg.plan === 'pro',
        banked: referrerOrg.plan !== 'pro',
      },
    });

    return granted;
  }

  tier1Days(): number {
    return tier1RewardDays();
  }

  tier2Days(): number {
    return tier2RewardDays();
  }

  /**
   * Apply banked reward days to a referrer org that is now on pro.
   * No-op for free (still banking) and enterprise (excluded) orgs.
   */
  async applyAccruedDays(code: ReferralCode): Promise<number> {
    if (!code.accruedRewardDays || code.accruedRewardDays <= 0) return 0;
    const org = await this.organizationRepository.findOne({ where: { id: code.organizationId } });
    if (!org || org.plan !== 'pro') return 0;

    const days = code.accruedRewardDays;
    this.extendPlan(org, days);
    await this.organizationRepository.save(org);
    code.accruedRewardDays = 0;
    await this.referralCodeRepository.save(code);

    this.auditLogService.log({
      organizationId: org.id,
      userId: code.userId,
      action: AuditAction.REFERRAL_REWARDED,
      resourceType: AuditResource.REFERRAL,
      resourceId: code.id,
      details: { kind: 'accrued_applied', days },
    });
    return days;
  }

  /** Extend planExpiresAt by `days` from max(now, current expiry); free orgs flip to pro. */
  extendPlan(org: Organization, days: number): void {
    const now = new Date();
    const current = org.planExpiresAt ? new Date(org.planExpiresAt) : null;
    const base = current && current.getTime() > now.getTime() ? current : now;
    org.planExpiresAt = this.addDays(base, days);
    if (org.plan === 'free') org.plan = 'pro';
  }

  // ── Read side ──────────────────────────────────────────────────────────

  async getStats(userId: string): Promise<ReferralStats> {
    const referrals = await this.referralRepository.find({ where: { referrerUserId: userId } });
    const code = await this.referralCodeRepository.findOne({ where: { userId } });
    return {
      invited: referrals.length,
      qualified: referrals.filter((r) => r.status === ReferralStatus.QUALIFIED).length,
      rewarded: referrals.filter((r) => r.status === ReferralStatus.REWARDED).length,
      pendingReview: referrals.filter((r) => !!r.abuseFlag).length,
      totalRewardDays: referrals.reduce((sum, r) => sum + (r.rewardDays || 0), 0),
      accruedRewardDays: code?.accruedRewardDays || 0,
    };
  }

  /** The caller's own referrals — no referred-user PII beyond org id. */
  async listReferrals(userId: string) {
    const referrals = await this.referralRepository.find({
      where: { referrerUserId: userId },
      order: { createdAt: 'DESC' },
    });
    return referrals.map((r) => ({
      id: r.id,
      status: r.abuseFlag ? 'pending_review' : r.status,
      rewardDays: r.rewardDays,
      qualifiedAt: r.qualifiedAt,
      rewardedAt: r.rewardedAt,
      createdAt: r.createdAt,
    }));
  }

  private addDays(from: Date, days: number): Date {
    return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  }
}
