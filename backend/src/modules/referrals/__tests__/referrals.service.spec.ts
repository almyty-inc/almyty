import { ForbiddenException } from '@nestjs/common';

import { ReferralsService } from '../referrals.service';
import { ReferralAbuseFlag, ReferralStatus } from '../../../entities/referral.entity';
import { makeAudit, makeRepo } from './repo-mocks';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('ReferralsService', () => {
  let codeRepo: ReturnType<typeof makeRepo>;
  let referralRepo: ReturnType<typeof makeRepo>;
  let orgRepo: ReturnType<typeof makeRepo>;
  let userRepo: ReturnType<typeof makeRepo>;
  let audit: ReturnType<typeof makeAudit>;
  let service: ReferralsService;

  const referrerOrg = () => orgRepo.store.find((o) => o.id === 'org-referrer');
  const referredOrg = () => orgRepo.store.find((o) => o.id === 'org-referred');

  beforeEach(() => {
    codeRepo = makeRepo('code');
    referralRepo = makeRepo('ref');
    orgRepo = makeRepo('org', [
      { id: 'org-referrer', plan: 'free', planExpiresAt: null, billingInfo: null },
      { id: 'org-referred', plan: 'free', planExpiresAt: null, billingInfo: null },
    ]);
    // Referees are verified by default so the pre-existing reward
    // scenarios exercise their original paths; the verified-gating
    // tests below override per case.
    userRepo = makeRepo('user', [
      ...['user-new', 'user-old', 'user-ancient', 'u1', 'u2', 'u3', 'u4'].map((id) => ({
        id,
        verifiedAt: new Date(),
        isVerified: true,
      })),
    ]);
    audit = makeAudit();
    service = new ReferralsService(
      codeRepo as any,
      referralRepo as any,
      orgRepo as any,
      audit as any,
      userRepo as any,
    );
  });

  // ── Code generation ────────────────────────────────────────────────────

  describe('getOrCreateCode', () => {
    it('creates a code once and returns the same code afterwards', async () => {
      const first = await service.getOrCreateCode('user-1', 'org-referrer', '10.0.0.1');
      const second = await service.getOrCreateCode('user-1', 'org-referrer');

      expect(first.code).toMatch(/^[A-Z2-9]{8}$/);
      expect(second.code).toBe(first.code);
      expect(codeRepo.store).toHaveLength(1);
      expect(first.createdFromIp).toBe('10.0.0.1');
    });

    it('retries on code collision until unique', async () => {
      const taken = await service.getOrCreateCode('user-1', 'org-referrer');
      // Force the next generation attempts to collide with the taken code
      // twice before producing a fresh one.
      const spy = jest
        .spyOn(service, 'generateCode')
        .mockReturnValueOnce(taken.code)
        .mockReturnValueOnce(taken.code)
        .mockReturnValueOnce('FRESH234');

      const second = await service.getOrCreateCode('user-2', 'org-referrer');

      expect(second.code).toBe('FRESH234');
      expect(spy).toHaveBeenCalledTimes(3);
      const codes = codeRepo.store.map((c) => c.code);
      expect(new Set(codes).size).toBe(codes.length);
    });

    it('generates codes from the unambiguous alphabet', () => {
      for (let i = 0; i < 50; i++) {
        expect(service.generateCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      }
    });

    it('rejects enterprise organizations', async () => {
      referrerOrg().plan = 'enterprise';
      await expect(service.getOrCreateCode('user-1', 'org-referrer')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ── Attribution at registration ────────────────────────────────────────

  describe('attributeSignup', () => {
    let code: any;

    beforeEach(async () => {
      code = await service.getOrCreateCode('user-referrer', 'org-referrer', '198.51.100.1');
    });

    const attribute = (overrides: any = {}) =>
      service.attributeSignup({
        userId: 'user-new',
        organizationId: 'org-referred',
        email: 'new@example.com',
        referralCode: code.code,
        ipAddress: '203.0.113.7',
        ...overrides,
      });

    it('creates a pending referral row when the code is valid', async () => {
      const referral = await attribute();

      expect(referral).not.toBeNull();
      expect(referral!.status).toBe(ReferralStatus.PENDING);
      expect(referral!.referrerUserId).toBe('user-referrer');
      expect(referral!.referredUserId).toBe('user-new');
      expect(referral!.referredOrganizationId).toBe('org-referred');
      expect(referral!.abuseFlag).toBeNull();
      expect(referral!.ipAddress).toBe('203.0.113.7');
    });

    it('grants the referee one month of pro at signup', async () => {
      const before = Date.now();
      await attribute();

      const org = referredOrg();
      expect(org.plan).toBe('pro');
      const expiry = new Date(org.planExpiresAt).getTime();
      expect(expiry).toBeGreaterThanOrEqual(before + 29 * DAY_MS);
      expect(expiry).toBeLessThanOrEqual(before + 31 * DAY_MS);
    });

    it('does not touch a referred org that is not on free', async () => {
      referredOrg().plan = 'pro';
      referredOrg().planExpiresAt = new Date(Date.now() + 5 * DAY_MS);
      const referral = await attribute();

      expect(referral).not.toBeNull();
      const expiry = new Date(referredOrg().planExpiresAt).getTime();
      expect(expiry).toBeLessThanOrEqual(Date.now() + 5 * DAY_MS);
    });

    it('returns null for an unknown or inactive code', async () => {
      expect(await attribute({ referralCode: 'NOPE2345' })).toBeNull();

      code.active = false;
      await codeRepo.save(code);
      expect(await attribute()).toBeNull();
      expect(referralRepo.store).toHaveLength(0);
    });

    it('excludes enterprise referrer orgs from attribution', async () => {
      referrerOrg().plan = 'enterprise';
      expect(await attribute()).toBeNull();
      expect(referralRepo.store).toHaveLength(0);
      expect(referredOrg().plan).toBe('free');
    });

    it('excludes enterprise referred orgs from attribution', async () => {
      referredOrg().plan = 'enterprise';
      expect(await attribute()).toBeNull();
      expect(referralRepo.store).toHaveLength(0);
    });

    it('ignores self-referrals', async () => {
      expect(await attribute({ userId: 'user-referrer' })).toBeNull();
    });

    it('attributes a referred user at most once', async () => {
      await attribute();
      expect(await attribute({ organizationId: 'org-referred' })).toBeNull();
      expect(referralRepo.store).toHaveLength(1);
    });

    it('flags same-IP referrals (code IP) and withholds the referee reward', async () => {
      const referral = await attribute({ ipAddress: '198.51.100.1' });

      expect(referral!.abuseFlag).toBe(ReferralAbuseFlag.SAME_IP);
      expect(referredOrg().plan).toBe('free'); // no auto-reward
      expect(referredOrg().planExpiresAt).toBeNull();
    });

    it('flags same-IP referrals across sibling referrals of the same referrer', async () => {
      orgRepo.store.push({ id: 'org-referred-2', plan: 'free', planExpiresAt: null });
      await attribute(); // first referral from 203.0.113.7 — clean

      const second = await attribute({
        userId: 'user-other',
        organizationId: 'org-referred-2',
        email: 'other@example.com',
        ipAddress: '203.0.113.7', // same machine as the first referee
      });

      expect(second!.abuseFlag).toBe(ReferralAbuseFlag.SAME_IP);
    });

    it('flags disposable-email signups and withholds the referee reward', async () => {
      const referral = await attribute({ email: 'burner@mailinator.com' });

      expect(referral!.abuseFlag).toBe(ReferralAbuseFlag.DISPOSABLE_EMAIL);
      expect(referral!.status).toBe(ReferralStatus.PENDING);
      expect(referredOrg().plan).toBe('free');
    });
  });

  // ── Referrer reward math ───────────────────────────────────────────────

  describe('awardReferrerDays', () => {
    let code: any;
    let referral: any;

    beforeEach(async () => {
      code = await service.getOrCreateCode('user-referrer', 'org-referrer');
      referral = await referralRepo.save({
        referrerUserId: 'user-referrer',
        referredUserId: 'user-new',
        referredOrganizationId: 'org-referred',
        referralCodeId: code.id,
        status: ReferralStatus.QUALIFIED,
        qualifiedAt: new Date(),
        rewardDays: 0,
        abuseFlag: null,
      });
    });

    it('extends planExpiresAt for a pro referrer (tier 1)', async () => {
      referrerOrg().plan = 'pro';
      const expiry = new Date(Date.now() + 10 * DAY_MS);
      referrerOrg().planExpiresAt = expiry;

      const granted = await service.awardReferrerDays(referral, 14, 'tier1');

      expect(granted).toBe(14);
      expect(referral.rewardDays).toBe(14);
      expect(new Date(referrerOrg().planExpiresAt).getTime()).toBe(
        expiry.getTime() + 14 * DAY_MS,
      );
      expect(code.accruedRewardDays).toBe(0);
    });

    it('banks days for a free referrer instead of applying them', async () => {
      const granted = await service.awardReferrerDays(referral, 14, 'tier1');

      expect(granted).toBe(14);
      expect(referrerOrg().plan).toBe('free');
      expect(referrerOrg().planExpiresAt).toBeNull();
      expect(codeRepo.store[0].accruedRewardDays).toBe(14);
      expect(referral.rewardDays).toBe(14);
    });

    it('stacks tier-1 then tier-2 on the same referral', async () => {
      referrerOrg().plan = 'pro';
      referrerOrg().planExpiresAt = new Date(Date.now() + DAY_MS);

      await service.awardReferrerDays(referral, 14, 'tier1');
      await service.awardReferrerDays(referral, 30, 'tier2');

      expect(referral.rewardDays).toBe(44);
    });

    it('enforces the 365-day yearly cap across a referrer referrals', async () => {
      referrerOrg().plan = 'pro';
      // Bank 360 days across earlier referrals qualified within the year.
      await referralRepo.save({
        referrerUserId: 'user-referrer',
        referredUserId: 'user-old',
        referredOrganizationId: 'org-x',
        status: ReferralStatus.REWARDED,
        qualifiedAt: new Date(Date.now() - 30 * DAY_MS),
        rewardDays: 360,
        abuseFlag: null,
      });

      const granted = await service.awardReferrerDays(referral, 14, 'tier1');
      expect(granted).toBe(5); // 365 - 360

      const denied = await service.awardReferrerDays(referral, 30, 'tier2');
      expect(denied).toBe(0);
    });

    it('ignores grants older than a year for the cap window', async () => {
      referrerOrg().plan = 'pro';
      await referralRepo.save({
        referrerUserId: 'user-referrer',
        referredUserId: 'user-ancient',
        referredOrganizationId: 'org-y',
        status: ReferralStatus.REWARDED,
        qualifiedAt: new Date(Date.now() - 400 * DAY_MS),
        rewardDays: 365,
        abuseFlag: null,
      });

      expect(await service.awardReferrerDays(referral, 14, 'tier1')).toBe(14);
    });

    it('never rewards flagged referrals', async () => {
      referral.abuseFlag = ReferralAbuseFlag.SAME_IP;
      expect(await service.awardReferrerDays(referral, 14, 'tier1')).toBe(0);
      expect(referral.rewardDays).toBe(0);
    });

    it('never rewards enterprise referrer orgs', async () => {
      referrerOrg().plan = 'enterprise';
      expect(await service.awardReferrerDays(referral, 14, 'tier1')).toBe(0);
    });
  });

  describe('applyAccruedDays / extendPlan', () => {
    it('applies the bank once the referrer org is on pro, and zeroes it', async () => {
      const code = await service.getOrCreateCode('user-referrer', 'org-referrer');
      code.accruedRewardDays = 20;
      await codeRepo.save(code);
      referrerOrg().plan = 'pro';
      referrerOrg().planExpiresAt = null;

      const before = Date.now();
      const applied = await service.applyAccruedDays(code);

      expect(applied).toBe(20);
      expect(code.accruedRewardDays).toBe(0);
      const expiry = new Date(referrerOrg().planExpiresAt).getTime();
      expect(expiry).toBeGreaterThanOrEqual(before + 19 * DAY_MS);
    });

    it('does nothing while the org is still on free', async () => {
      const code = await service.getOrCreateCode('user-referrer', 'org-referrer');
      code.accruedRewardDays = 20;

      expect(await service.applyAccruedDays(code)).toBe(0);
      expect(code.accruedRewardDays).toBe(20);
    });

    it('extends from the current expiry when it is in the future, from now when lapsed', () => {
      const future = new Date(Date.now() + 10 * DAY_MS);
      const org: any = { plan: 'pro', planExpiresAt: future };
      service.extendPlan(org, 5);
      expect(new Date(org.planExpiresAt).getTime()).toBe(future.getTime() + 5 * DAY_MS);

      const lapsed: any = { plan: 'pro', planExpiresAt: new Date(Date.now() - 30 * DAY_MS) };
      const before = Date.now();
      service.extendPlan(lapsed, 5);
      expect(new Date(lapsed.planExpiresAt).getTime()).toBeGreaterThanOrEqual(before + 5 * DAY_MS - 1000);

      const free: any = { plan: 'free', planExpiresAt: null };
      service.extendPlan(free, 5);
      expect(free.plan).toBe('pro');
    });
  });

  // ── Read side scoping ──────────────────────────────────────────────────

  describe('stats and listing', () => {
    beforeEach(async () => {
      await referralRepo.save({ referrerUserId: 'user-a', referredUserId: 'u1', referredOrganizationId: 'o1', status: ReferralStatus.PENDING, rewardDays: 0, abuseFlag: null, createdAt: new Date(1) });
      await referralRepo.save({ referrerUserId: 'user-a', referredUserId: 'u2', referredOrganizationId: 'o2', status: ReferralStatus.QUALIFIED, rewardDays: 14, abuseFlag: null, createdAt: new Date(2) });
      await referralRepo.save({ referrerUserId: 'user-a', referredUserId: 'u3', referredOrganizationId: 'o3', status: ReferralStatus.PENDING, rewardDays: 0, abuseFlag: ReferralAbuseFlag.SAME_IP, createdAt: new Date(3) });
      await referralRepo.save({ referrerUserId: 'user-b', referredUserId: 'u4', referredOrganizationId: 'o4', status: ReferralStatus.REWARDED, rewardDays: 44, abuseFlag: null, createdAt: new Date(4) });
    });

    it('computes stats over the caller referrals only', async () => {
      const stats = await service.getStats('user-a');
      expect(stats).toEqual({
        invited: 3,
        qualified: 1,
        rewarded: 0,
        pendingReview: 1,
        totalRewardDays: 14,
        accruedRewardDays: 0,
      });
    });

    it('lists only the caller referrals and masks flagged rows as pending_review', async () => {
      const rows = await service.listReferrals('user-a');
      expect(rows).toHaveLength(3);
      expect(rows[0].status).toBe('pending_review'); // newest first, flagged
      expect(rows.map((r: any) => r.id)).not.toContain(
        referralRepo.store.find((r) => r.referrerUserId === 'user-b')!.id,
      );
      // No referred-user PII in the payload
      expect(Object.keys(rows[0])).toEqual(
        expect.not.arrayContaining(['referredUserId', 'ipAddress']),
      );
    });
  });
});

/**
 * Verified-referee reward gating + referrer notifications. Uses the
 * same in-memory repos with an explicit notifications fake (the
 * production wiring injects it @Optional()).
 */
describe('ReferralsService verified gating + notifications', () => {
  let codeRepo: ReturnType<typeof makeRepo>;
  let referralRepo: ReturnType<typeof makeRepo>;
  let orgRepo: ReturnType<typeof makeRepo>;
  let userRepo: ReturnType<typeof makeRepo>;
  let notifications: { emit: jest.Mock };
  let service: ReferralsService;

  beforeEach(() => {
    codeRepo = makeRepo('code');
    referralRepo = makeRepo('ref');
    orgRepo = makeRepo('org', [
      { id: 'org-referrer', plan: 'pro', planExpiresAt: new Date(Date.now() + DAY_MS), billingInfo: null },
      { id: 'org-referred', plan: 'free', planExpiresAt: null, billingInfo: null },
    ]);
    userRepo = makeRepo('user', [
      { id: 'user-verified', verifiedAt: new Date(), isVerified: true },
      { id: 'user-unverified', verifiedAt: null, isVerified: false },
    ]);
    notifications = { emit: jest.fn().mockResolvedValue(undefined) };
    service = new ReferralsService(
      codeRepo as any,
      referralRepo as any,
      orgRepo as any,
      makeAudit() as any,
      userRepo as any,
      notifications as any,
    );
  });

  async function seed(referredUserId: string) {
    const code = await service.getOrCreateCode('user-referrer', 'org-referrer');
    return referralRepo.save({
      referrerUserId: 'user-referrer',
      referredUserId,
      referredOrganizationId: 'org-referred',
      referralCodeId: code.id,
      status: ReferralStatus.QUALIFIED,
      qualifiedAt: new Date(),
      rewardDays: 0,
      abuseFlag: null,
    });
  }

  it('holds the reward for an unverified referee (returns 0, no rewardDays)', async () => {
    const referral = await seed('user-unverified');

    const granted = await service.awardReferrerDays(referral, 14, 'tier1');

    expect(granted).toBe(0);
    expect(referral.rewardDays).toBe(0);
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('awards once the referee is verified and notifies the referrer (referral.qualified)', async () => {
    const referral = await seed('user-verified');

    const granted = await service.awardReferrerDays(referral, 14, 'tier1');
    await new Promise((r) => setImmediate(r));

    expect(granted).toBe(14);
    expect(notifications.emit).toHaveBeenCalledTimes(1);
    const input = notifications.emit.mock.calls[0][0];
    expect(input).toMatchObject({
      type: 'referral.qualified',
      organizationId: 'org-referrer',
      userIds: ['user-referrer'],
    });
    expect(input.email.template).toBe('referral.qualified');
    expect(input.email.params.days).toBe(14);
  });

  it('tier 2 emits referral.rewarded', async () => {
    const referral = await seed('user-verified');

    await service.awardReferrerDays(referral, 30, 'tier2');
    await new Promise((r) => setImmediate(r));

    expect(notifications.emit.mock.calls[0][0].type).toBe('referral.rewarded');
  });

  it('isRefereeVerified accepts the legacy isVerified boolean too', async () => {
    userRepo.store.push({ id: 'user-legacy', verifiedAt: null, isVerified: true });
    const referral = await seed('user-legacy');
    expect(await service.isRefereeVerified(referral)).toBe(true);
  });
});