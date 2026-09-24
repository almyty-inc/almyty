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

  // Reads of the table as it stands, never of an object the service held.
  const referrerOrg = () => orgRepo.row('org-referrer');
  const referredOrg = () => orgRepo.row('org-referred');
  const stored = (id: string) => referralRepo.row(id);

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
    gatewayRepo.seed({ id: 'gw-1', organizationId: 'org-referred' });
    agentRunRepo.seed({ id: 'run-1', organizationId: 'org-referred' });
  }

  describe('pending -> qualified (activation)', () => {
    it('qualifies and grants tier 1 once the referred org has a gateway and a run', async () => {
      const referral = await seedReferral();
      activateReferredOrg();

      const result = await sweeper.sweep();

      expect(result.qualified).toBe(1);
      expect(stored(referral.id)!.status).toBe(ReferralStatus.QUALIFIED);
      expect(stored(referral.id)!.qualifiedAt).toBeInstanceOf(Date);
      expect(stored(referral.id)!.rewardDays).toBe(14); // tier 1 default
    });

    it('does not qualify with a gateway but no agent run', async () => {
      const referral = await seedReferral();
      gatewayRepo.seed({ id: 'gw-1', organizationId: 'org-referred' });

      const result = await sweeper.sweep();

      expect(result.qualified).toBe(0);
      expect(stored(referral.id)!.status).toBe(ReferralStatus.PENDING);
    });

    it('does not qualify with a run but no gateway', async () => {
      const referral = await seedReferral();
      agentRunRepo.seed({ id: 'run-1', organizationId: 'org-referred' });

      await sweeper.sweep();
      expect(stored(referral.id)!.status).toBe(ReferralStatus.PENDING);
    });

    it('skips abuse-flagged referrals entirely', async () => {
      const referral = await seedReferral({ abuseFlag: ReferralAbuseFlag.SAME_IP });
      activateReferredOrg();

      const result = await sweeper.sweep();

      expect(result.qualified).toBe(0);
      expect(stored(referral.id)!.status).toBe(ReferralStatus.PENDING);
      expect(stored(referral.id)!.rewardDays).toBe(0);
    });

    it('tier-1 extends a pro referrer planExpiresAt by 14 days', async () => {
      await seedReferral();
      activateReferredOrg();
      const expiry = referrerOrg().planExpiresAt.getTime();

      await sweeper.sweep();

      expect(new Date(referrerOrg().planExpiresAt).getTime()).toBe(expiry + 14 * DAY_MS);
    });

    it('tier-1 accrues instead of applying when the referrer is on free', async () => {
      orgRepo.patch('org-referrer', { plan: 'free', planExpiresAt: null });
      await seedReferral();
      activateReferredOrg();

      await sweeper.sweep();

      expect(codeRepo.rows()[0].accruedRewardDays).toBe(14);
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
      orgRepo.patch('org-referred', { plan: 'pro', billingInfo: { stripeSubscriptionId: 'sub_123' } });
      const expiry = referrerOrg().planExpiresAt.getTime();

      const result = await sweeper.sweep();

      expect(result.rewarded).toBe(1);
      expect(stored(referral.id)!.status).toBe(ReferralStatus.REWARDED);
      expect(stored(referral.id)!.rewardedAt).toBeInstanceOf(Date);
      expect(stored(referral.id)!.rewardDays).toBe(44); // 14 + 30
      expect(new Date(referrerOrg().planExpiresAt).getTime()).toBe(expiry + 30 * DAY_MS);
    });

    it('does NOT treat the referee signup bonus (pro without a subscription) as conversion', async () => {
      const referral = await seedReferral({
        status: ReferralStatus.QUALIFIED,
        qualifiedAt: new Date(),
        rewardDays: 14,
      });
      // The signup bonus flipped the plan, but there is no Stripe sub.
      orgRepo.patch('org-referred', { plan: 'pro', billingInfo: null });

      const result = await sweeper.sweep();

      expect(result.rewarded).toBe(0);
      expect(stored(referral.id)!.status).toBe(ReferralStatus.QUALIFIED);
    });

    it('skips flagged referrals for tier 2 as well', async () => {
      const referral = await seedReferral({
        status: ReferralStatus.QUALIFIED,
        qualifiedAt: new Date(),
        abuseFlag: ReferralAbuseFlag.DISPOSABLE_EMAIL,
      });
      orgRepo.patch('org-referred', { plan: 'pro', billingInfo: { stripeSubscriptionId: 'sub_123' } });

      await sweeper.sweep();
      expect(stored(referral.id)!.status).toBe(ReferralStatus.QUALIFIED);
      expect(stored(referral.id)!.rewardDays).toBe(0);
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
      expect(codeRepo.rows()[0].accruedRewardDays).toBe(0);
      expect(new Date(referrerOrg().planExpiresAt).getTime()).toBe(expiry + 28 * DAY_MS);
    });

    it('keeps banking while the referrer org stays on free', async () => {
      orgRepo.patch('org-referrer', { plan: 'free' });
      await codeRepo.save({
        userId: 'user-referrer',
        organizationId: 'org-referrer',
        code: 'CODE2345',
        active: true,
        accruedRewardDays: 28,
      });

      const result = await sweeper.sweep();

      expect(result.accrualsApplied).toBe(0);
      expect(codeRepo.rows()[0].accruedRewardDays).toBe(28);
    });
  });

  /**
   * Two replicas, one batch.
   *
   * The sweep is an in-process timer, so it runs on every replica, and
   * after a rolling deploy the timers sit near each other: both read the
   * same batch. Replica B then holds the copy it loaded across A's whole
   * sweep -- several DB round trips per row -- so neither B's own status
   * check nor the yearly-cap arithmetic in awardReferrerDays (which
   * reads that copy's `rewardDays`) saw A's payout, and the referrer's
   * plan was extended twice for one referral. A lease alone would not
   * settle it: a lease can expire mid-sweep, so each transition is
   * claimed with a status-guarded UPDATE and only the claim pays out.
   */
  describe('two replicas on the same batch', () => {
    const otherReplica = (redis?: any) =>
      new ReferralQualificationService(
        referralRepo as any,
        codeRepo as any,
        orgRepo as any,
        gatewayRepo as any,
        agentRunRepo as any,
        referralsService,
        makeAudit() as any,
        redis,
      );

    it('cannot award tier 1 twice for one referral', async () => {
      const referral = await seedReferral();
      activateReferredOrg();
      const before = referrerOrg().planExpiresAt.getTime();

      expect((await sweeper.sweep()).qualified).toBe(1);
      const afterOne = new Date(referrerOrg().planExpiresAt).getTime();
      expect(afterOne).toBe(before + 14 * DAY_MS);

      // The copy the second replica loaded before any of that happened.
      const stale = { ...referral, status: ReferralStatus.PENDING, qualifiedAt: null, rewardDays: 0 };
      referralRepo.find.mockResolvedValueOnce([stale]);

      const second = await otherReplica().sweep();

      expect(second.qualified).toBe(0);
      expect(new Date(referrerOrg().planExpiresAt).getTime()).toBe(afterOne);
      expect(stored(referral.id)!.rewardDays).toBe(14);
    });

    // A row flagged for abuse after the batch was read must not pay out:
    // the claim carries `abuseFlag IS NULL` for exactly this.
    it('does not qualify a referral flagged after the batch was read', async () => {
      const referral = await seedReferral();
      activateReferredOrg();
      const unflagged = stored(referral.id)!;
      referralRepo.patch(referral.id, { abuseFlag: ReferralAbuseFlag.SAME_IP });
      referralRepo.find.mockResolvedValueOnce([unflagged]);
      const before = referrerOrg().planExpiresAt.getTime();

      expect((await sweeper.sweep()).qualified).toBe(0);
      expect(stored(referral.id)).toMatchObject({ status: ReferralStatus.PENDING, rewardDays: 0 });
      expect(new Date(referrerOrg().planExpiresAt).getTime()).toBe(before);
    });

    it('cannot award tier 2 twice for one referral', async () => {
      const referral = await seedReferral({
        status: ReferralStatus.QUALIFIED,
        qualifiedAt: new Date(),
        rewardDays: 14,
      });
      orgRepo.patch('org-referred', { plan: 'pro', billingInfo: { stripeSubscriptionId: 'sub_123' } });

      expect((await sweeper.sweep()).rewarded).toBe(1);
      const afterOne = new Date(referrerOrg().planExpiresAt).getTime();

      const stale = { ...referral, status: ReferralStatus.QUALIFIED, rewardedAt: null, rewardDays: 14 };
      // The pending pass finds nothing; the qualified pass gets the copy.
      referralRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([stale]);

      const second = await otherReplica().sweep();

      expect(second.rewarded).toBe(0);
      expect(new Date(referrerOrg().planExpiresAt).getTime()).toBe(afterOne);
    });

    it('cannot apply the same banked days twice', async () => {
      const code = await codeRepo.save({
        userId: 'user-referrer',
        organizationId: 'org-referrer',
        code: 'CODE2345',
        active: true,
        accruedRewardDays: 28,
      });
      const before = referrerOrg().planExpiresAt.getTime();

      expect((await sweeper.sweep()).accrualsApplied).toBe(1);
      const afterOne = new Date(referrerOrg().planExpiresAt).getTime();
      expect(afterOne).toBe(before + 28 * DAY_MS);

      codeRepo.find.mockResolvedValueOnce([{ ...code, accruedRewardDays: 28 }]);
      const second = await otherReplica().sweep();

      expect(second.accrualsApplied).toBe(0);
      expect(new Date(referrerOrg().planExpiresAt).getTime()).toBe(afterOne);
    });

    it('a replica that cannot take the lease does not read a single row', async () => {
      const redis = { set: jest.fn(async () => null), eval: jest.fn(async () => 1) };
      await seedReferral();
      activateReferredOrg();
      referralRepo.find.mockClear();

      const result = await otherReplica(redis).sweep();

      expect(result).toEqual({ qualified: 0, rewarded: 0, accrualsApplied: 0 });
      expect(referralRepo.find).not.toHaveBeenCalled();
      expect(redis.set).toHaveBeenCalledWith(
        'referrals:qualification:lock',
        expect.any(String),
        'EX',
        expect.any(Number),
        'NX',
      );
    });

    it('releases the lease it took, so the next window is not blocked', async () => {
      const redis = { set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) };

      await otherReplica(redis).sweep();

      expect(redis.eval).toHaveBeenCalled();
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
  const stored = (id: string) => referralRepo.row(id);

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
    gatewayRepo.seed({ id: 'gw-1', organizationId: 'org-referred' });
    agentRunRepo.seed({ id: 'run-1', organizationId: 'org-referred' });
    return referral;
  }

  it('holds an activated referral as PENDING while the referee is unverified', async () => {
    const referral = await seedActivatedReferral();

    const result = await sweeper.sweep();

    expect(result.qualified).toBe(0);
    expect(stored(referral.id)!.status).toBe(ReferralStatus.PENDING);
    expect(stored(referral.id)!.rewardDays).toBe(0);
  });

  it('qualifies (and rewards tier 1) on a later sweep after the referee verifies', async () => {
    const referral = await seedActivatedReferral();

    await sweeper.sweep(); // held
    userRepo.patch('user-new', { verifiedAt: new Date() }); // referee verifies
    const result = await sweeper.sweep();

    expect(result.qualified).toBe(1);
    expect(stored(referral.id)!.status).toBe(ReferralStatus.QUALIFIED);
    expect(stored(referral.id)!.rewardDays).toBeGreaterThan(0);
  });

  it('holds the qualified -> rewarded (tier 2) transition for unverified referees too', async () => {
    const referral = await seedActivatedReferral();
    referralRepo.patch(referral.id, { status: ReferralStatus.QUALIFIED, qualifiedAt: new Date() });
    orgRepo.patch('org-referred', { plan: 'pro', billingInfo: { stripeSubscriptionId: 'sub_1' } });

    const held = await sweeper.sweep();
    expect(held.rewarded).toBe(0);
    expect(stored(referral.id)!.status).toBe(ReferralStatus.QUALIFIED);

    userRepo.patch('user-new', { verifiedAt: new Date() });
    const after = await sweeper.sweep();
    expect(after.rewarded).toBe(1);
    expect(stored(referral.id)!.status).toBe(ReferralStatus.REWARDED);
  });
});
