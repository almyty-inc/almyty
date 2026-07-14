import { ReferralQualificationService } from '../referral-qualification.service';
import { ReferralsService } from '../referrals.service';
import { ReferralAbuseFlag, ReferralStatus } from '../../../entities/referral.entity';
import { makeAudit, makeRepo } from './repo-mocks';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('ReferralQualificationService', () => {
  let referralRepo: ReturnType<typeof makeRepo>;
  let codeRepo: ReturnType<typeof makeRepo>;
  let orgRepo: ReturnType<typeof makeRepo>;
  let gatewayRepo: ReturnType<typeof makeRepo>;
  let agentRunRepo: ReturnType<typeof makeRepo>;
  let userRepo: ReturnType<typeof makeRepo>;
  let referralsService: ReferralsService;
  let sweeper: ReferralQualificationService;

  const referrerOrg = () => orgRepo.store.find((o) => o.id === 'org-referrer');
  const referredOrg = () => orgRepo.store.find((o) => o.id === 'org-referred');

  beforeEach(async () => {
    referralRepo = makeRepo('ref');
    codeRepo = makeRepo('code');
    orgRepo = makeRepo('org', [
      { id: 'org-referrer', plan: 'pro', planExpiresAt: new Date(Date.now() + DAY_MS), billingInfo: null },
      { id: 'org-referred', plan: 'free', planExpiresAt: null, billingInfo: null },
    ]);
    gatewayRepo = makeRepo('gw');
    agentRunRepo = makeRepo('run');
    // Referee verified by default — verified-gating cases override.
    userRepo = makeRepo('user', [
      { id: 'user-new', verifiedAt: new Date(), isVerified: true },
    ]);
    referralsService = new ReferralsService(
      codeRepo as any,
      referralRepo as any,
      orgRepo as any,
      makeAudit() as any,
      userRepo as any,
    );
    sweeper = new ReferralQualificationService(
      referralRepo as any,
      codeRepo as any,
      orgRepo as any,
      gatewayRepo as any,
      agentRunRepo as any,
      referralsService,
      makeAudit() as any,
    );
  });
  async function seedReferral(overrides: any = {}) {
    const code = await codeRepo.save({
      userId: 'user-referrer',
      organizationId: 'org-referrer',
      code: 'CODE2345',
      active: true,
      accruedRewardDays: 0,
    });
    return referralRepo.save({
      referrerUserId: 'user-referrer',
      referredUserId: 'user-new',
      referredOrganizationId: 'org-referred',
      referralCodeId: code.id,
      status: ReferralStatus.PENDING,
      qualifiedAt: null,
      rewardedAt: null,
      rewardDays: 0,
      abuseFlag: null,
      ...overrides,
    });
  }

  function activateReferredOrg() {
    gatewayRepo.store.push({ id: 'gw-1', organizationId: 'org-referred' });
    agentRunRepo.store.push({ id: 'run-1', organizationId: 'org-referred' });
  }

  describe('pending -> qualified (activation)', () => {
    it('qualifies and grants tier 1 once the referred org has a gateway and a run', async () => {
      const referral = await seedReferral();
      activateReferredOrg();

      const result = await sweeper.sweep();

      expect(result.qualified).toBe(1);
      expect(referral.status).toBe(ReferralStatus.QUALIFIED);
      expect(referral.qualifiedAt).toBeInstanceOf(Date);
      expect(referral.rewardDays).toBe(14); // tier 1 default
    });

    it('does not qualify with a gateway but no agent run', async () => {
      const referral = await seedReferral();
      gatewayRepo.store.push({ id: 'gw-1', organizationId: 'org-referred' });

      const result = await sweeper.sweep();

      expect(result.qualified).toBe(0);
      expect(referral.status).toBe(ReferralStatus.PENDING);
    });

    it('does not qualify with a run but no gateway', async () => {
      const referral = await seedReferral();
      agentRunRepo.store.push({ id: 'run-1', organizationId: 'org-referred' });

      await sweeper.sweep();
      expect(referral.status).toBe(ReferralStatus.PENDING);
    });

    it('skips abuse-flagged referrals entirely', async () => {
      const referral = await seedReferral({ abuseFlag: ReferralAbuseFlag.SAME_IP });
      activateReferredOrg();

      const result = await sweeper.sweep();

      expect(result.qualified).toBe(0);
      expect(referral.status).toBe(ReferralStatus.PENDING);
      expect(referral.rewardDays).toBe(0);
    });

    it('tier-1 extends a pro referrer planExpiresAt by 14 days', async () => {
      await seedReferral();
      activateReferredOrg();
      const expiry = referrerOrg().planExpiresAt.getTime();

      await sweeper.sweep();

      expect(new Date(referrerOrg().planExpiresAt).getTime()).toBe(expiry + 14 * DAY_MS);
    });

    it('tier-1 accrues instead of applying when the referrer is on free', async () => {
      referrerOrg().plan = 'free';
      referrerOrg().planExpiresAt = null;
      await seedReferral();
      activateReferredOrg();

      await sweeper.sweep();

      expect(codeRepo.store[0].accruedRewardDays).toBe(14);
      expect(referrerOrg().plan).toBe('free');
      expect(referrerOrg().planExpiresAt).toBeNull();
    });
  });

  describe('qualified -> rewarded (paid conversion)', () => {
    it('grants tier 2 when the referred org holds a paid Stripe subscription', async () => {
      const referral = await seedReferral({
        status: ReferralStatus.QUALIFIED,
        qualifiedAt: new Date(),
        rewardDays: 14,
      });
      referredOrg().plan = 'pro';
      referredOrg().billingInfo = { stripeSubscriptionId: 'sub_123' };
      const expiry = referrerOrg().planExpiresAt.getTime();

      const result = await sweeper.sweep();

      expect(result.rewarded).toBe(1);
      expect(referral.status).toBe(ReferralStatus.REWARDED);
      expect(referral.rewardedAt).toBeInstanceOf(Date);
      expect(referral.rewardDays).toBe(44); // 14 + 30
      expect(new Date(referrerOrg().planExpiresAt).getTime()).toBe(expiry + 30 * DAY_MS);
    });

    it('does NOT treat the referee signup bonus (pro without a subscription) as conversion', async () => {
      const referral = await seedReferral({
        status: ReferralStatus.QUALIFIED,
        qualifiedAt: new Date(),
        rewardDays: 14,
      });
      referredOrg().plan = 'pro'; // signup bonus flipped the plan...
      referredOrg().billingInfo = null; // ...but there is no Stripe sub

      const result = await sweeper.sweep();

      expect(result.rewarded).toBe(0);
      expect(referral.status).toBe(ReferralStatus.QUALIFIED);
    });

    it('skips flagged referrals for tier 2 as well', async () => {
      const referral = await seedReferral({
        status: ReferralStatus.QUALIFIED,
        qualifiedAt: new Date(),
        abuseFlag: ReferralAbuseFlag.DISPOSABLE_EMAIL,
      });
      referredOrg().plan = 'pro';
      referredOrg().billingInfo = { stripeSubscriptionId: 'sub_123' };

      await sweeper.sweep();
      expect(referral.status).toBe(ReferralStatus.QUALIFIED);
      expect(referral.rewardDays).toBe(0);
    });
  });

  describe('accrual application', () => {
    it('applies banked days once the referrer org is on pro', async () => {
      await codeRepo.save({
        userId: 'user-referrer',
        organizationId: 'org-referrer',
        code: 'CODE2345',
        active: true,
        accruedRewardDays: 28,
      });
      const expiry = referrerOrg().planExpiresAt.getTime();

      const result = await sweeper.sweep();

      expect(result.accrualsApplied).toBe(1);
      expect(codeRepo.store[0].accruedRewardDays).toBe(0);
      expect(new Date(referrerOrg().planExpiresAt).getTime()).toBe(expiry + 28 * DAY_MS);
    });

    it('keeps banking while the referrer org stays on free', async () => {
      referrerOrg().plan = 'free';
      await codeRepo.save({
        userId: 'user-referrer',
        organizationId: 'org-referrer',
        code: 'CODE2345',
        active: true,
        accruedRewardDays: 28,
      });

      const result = await sweeper.sweep();

      expect(result.accrualsApplied).toBe(0);
      expect(codeRepo.store[0].accruedRewardDays).toBe(28);
    });
  });
});

/**
 * Verified-referee gating in the sweep: an activated referral whose
 * referee has not verified their email is held as PENDING (like the
 * abuse path) and retried — it qualifies on a later tick once the
 * referee verifies.
 */
describe('ReferralQualificationService verified-referee gating', () => {
  let referralRepo: ReturnType<typeof makeRepo>;
  let codeRepo: ReturnType<typeof makeRepo>;
  let orgRepo: ReturnType<typeof makeRepo>;
  let gatewayRepo: ReturnType<typeof makeRepo>;
  let agentRunRepo: ReturnType<typeof makeRepo>;
  let userRepo: ReturnType<typeof makeRepo>;
  let sweeper: ReferralQualificationService;

  beforeEach(() => {
    referralRepo = makeRepo('ref');
    codeRepo = makeRepo('code');
    orgRepo = makeRepo('org', [
      { id: 'org-referrer', plan: 'pro', planExpiresAt: new Date(Date.now() + DAY_MS), billingInfo: null },
      { id: 'org-referred', plan: 'free', planExpiresAt: null, billingInfo: null },
    ]);
    gatewayRepo = makeRepo('gw');
    agentRunRepo = makeRepo('run');
    userRepo = makeRepo('user', [
      { id: 'user-new', verifiedAt: null, isVerified: false }, // unverified referee
    ]);
    const referralsService = new ReferralsService(
      codeRepo as any,
      referralRepo as any,
      orgRepo as any,
      makeAudit() as any,
      userRepo as any,
    );
    sweeper = new ReferralQualificationService(
      referralRepo as any,
      codeRepo as any,
      orgRepo as any,
      gatewayRepo as any,
      agentRunRepo as any,
      referralsService,
      makeAudit() as any,
    );
  });

  async function seedActivatedReferral() {
    const code = await codeRepo.save({
      userId: 'user-referrer',
      organizationId: 'org-referrer',
      code: 'CODE2345',
      active: true,
      accruedRewardDays: 0,
    });
    const referral = await referralRepo.save({
      referrerUserId: 'user-referrer',
      referredUserId: 'user-new',
      referredOrganizationId: 'org-referred',
      referralCodeId: code.id,
      status: ReferralStatus.PENDING,
      qualifiedAt: null,
      rewardedAt: null,
      rewardDays: 0,
      abuseFlag: null,
    });
    gatewayRepo.store.push({ id: 'gw-1', organizationId: 'org-referred' });
    agentRunRepo.store.push({ id: 'run-1', organizationId: 'org-referred' });
    return referral;
  }

  it('holds an activated referral as PENDING while the referee is unverified', async () => {
    const referral = await seedActivatedReferral();

    const result = await sweeper.sweep();

    expect(result.qualified).toBe(0);
    expect(referral.status).toBe(ReferralStatus.PENDING);
    expect(referral.rewardDays).toBe(0);
  });

  it('qualifies (and rewards tier 1) on a later sweep after the referee verifies', async () => {
    const referral = await seedActivatedReferral();

    await sweeper.sweep(); // held
    userRepo.store[0].verifiedAt = new Date(); // referee verifies
    const result = await sweeper.sweep();

    expect(result.qualified).toBe(1);
    expect(referral.status).toBe(ReferralStatus.QUALIFIED);
    expect(referral.rewardDays).toBeGreaterThan(0);
  });

  it('holds the qualified -> rewarded (tier 2) transition for unverified referees too', async () => {
    const referral = await seedActivatedReferral();
    referral.status = ReferralStatus.QUALIFIED;
    referral.qualifiedAt = new Date();
    referredOrgRow().plan = 'pro';
    referredOrgRow().billingInfo = { stripeSubscriptionId: 'sub_1' };

    const held = await sweeper.sweep();
    expect(held.rewarded).toBe(0);
    expect(referral.status).toBe(ReferralStatus.QUALIFIED);

    userRepo.store[0].verifiedAt = new Date();
    const after = await sweeper.sweep();
    expect(after.rewarded).toBe(1);
    expect(referral.status).toBe(ReferralStatus.REWARDED);
  });

  function referredOrgRow() {
    return orgRepo.store.find((o) => o.id === 'org-referred');
  }
});