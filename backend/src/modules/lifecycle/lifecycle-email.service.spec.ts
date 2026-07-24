import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';

import {
  LifecycleEmailService,
  STATE_NUDGE_DAY,
  SHOWCASE_DAY,
  LAST_TOUCH_DAY,
} from './lifecycle-email.service';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { MailService } from '../mail/mail.service';
import { OnboardingService } from '../onboarding/onboarding.service';

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

/** Steps object with everything false unless overridden. */
function steps(overrides: Partial<Record<string, boolean>> = {}) {
  return {
    provider: false,
    api: false,
    gateway: false,
    first_call: false,
    external_client: false,
    ...overrides,
  };
}

/** A user `days` days old, verified, with the given lifecycle prefs. */
function makeUser(days: number, lifecycle: Record<string, any> = {}, over: Partial<User> = {}): User {
  const created = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return {
    id: USER_ID,
    email: 'signup@example.com',
    firstName: 'Ada',
    verifiedAt: new Date(),
    createdAt: created,
    preferences: { lifecycle },
    ...over,
  } as unknown as User;
}

describe('LifecycleEmailService', () => {
  let service: LifecycleEmailService;
  let userRepo: any;
  let userOrgRepo: any;
  let mailService: any;
  let onboardingService: any;
  let saved: any[];

  const ORIGINAL_ENV = process.env.LIFECYCLE_EMAILS_ENABLED;

  beforeEach(async () => {
    process.env.LIFECYCLE_EMAILS_ENABLED = 'true';
    saved = [];

    userRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation((u: any) => {
        saved.push(JSON.parse(JSON.stringify(u.preferences)));
        return Promise.resolve(u);
      }),
    };
    userOrgRepo = {
      find: jest.fn().mockResolvedValue([
        { organizationId: ORG_ID, userId: USER_ID, role: OrganizationRole.OWNER, isActive: true },
      ]),
    };
    mailService = { sendTemplate: jest.fn().mockResolvedValue(true) };
    onboardingService = { getState: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LifecycleEmailService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(UserOrganization), useValue: userOrgRepo },
        { provide: MailService, useValue: mailService },
        { provide: OnboardingService, useValue: onboardingService },
        { provide: JwtService, useValue: { sign: jest.fn().mockReturnValue('tok'), verify: jest.fn() } },
      ],
    }).compile();

    service = module.get(LifecycleEmailService);
  });

  afterEach(() => {
    process.env.LIFECYCLE_EMAILS_ENABLED = ORIGINAL_ENV;
    jest.clearAllMocks();
  });

  /** Configure a single-candidate sweep with the given user + steps. */
  function primeSweep(user: User, stepState: ReturnType<typeof steps>) {
    userRepo.find.mockResolvedValue([user]);
    userRepo.findOne.mockResolvedValue(user); // for writeState
    onboardingService.getState.mockResolvedValue({ steps: stepState });
  }

  /** The template name of the (single) send this sweep, if any. */
  function sentTemplate(): string | undefined {
    return mailService.sendTemplate.mock.calls[0]?.[1];
  }

  // ── sendWelcome ────────────────────────────────────────────────────

  it('sends the welcome email once, then dedupes', async () => {
    const user = makeUser(0);
    userRepo.findOne.mockResolvedValue(user);

    await service.sendWelcome(USER_ID);

    expect(mailService.sendTemplate).toHaveBeenCalledTimes(1);
    expect(mailService.sendTemplate).toHaveBeenCalledWith(
      user.email,
      'lifecycle.welcome',
      expect.objectContaining({ firstName: 'Ada', unsubscribeUrl: expect.any(String) }),
    );
    const last = saved[saved.length - 1];
    expect(last.lifecycle.welcome).toEqual(expect.any(String));

    mailService.sendTemplate.mockClear();
    userRepo.findOne.mockResolvedValue(makeUser(0, { welcome: last.lifecycle.welcome }));
    await service.sendWelcome(USER_ID);
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
  });

  it('skips welcome when the user is unverified', async () => {
    userRepo.findOne.mockResolvedValue(makeUser(0, {}, { verifiedAt: null }));
    await service.sendWelcome(USER_ID);
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
  });

  it('skips welcome when the user opted out', async () => {
    userRepo.findOne.mockResolvedValue(makeUser(0, { optOut: true }));
    await service.sendWelcome(USER_ID);
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
  });

  it('no-ops sendWelcome when LIFECYCLE_EMAILS_ENABLED is unset (default off)', async () => {
    delete process.env.LIFECYCLE_EMAILS_ENABLED;
    userRepo.findOne.mockResolvedValue(makeUser(0));
    await service.sendWelcome(USER_ID);
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  // ── State-aware nudge (T+2) targeting ──────────────────────────────

  it('T+2 with no provider -> nudge-provider', async () => {
    primeSweep(makeUser(STATE_NUDGE_DAY, {}), steps());
    const res = await service.runNudgeSweep();
    expect(res.sent).toBe(1);
    expect(sentTemplate()).toBe('lifecycle.nudge-provider');
    expect(saved[saved.length - 1].lifecycle.stateNudge).toEqual(expect.any(String));
  });

  it('T+2 with provider but no api -> nudge-api', async () => {
    primeSweep(makeUser(STATE_NUDGE_DAY, {}), steps({ provider: true }));
    await service.runNudgeSweep();
    expect(sentTemplate()).toBe('lifecycle.nudge-api');
  });

  it('T+2 with api but no gateway -> nudge-gateway', async () => {
    primeSweep(makeUser(STATE_NUDGE_DAY, {}), steps({ provider: true, api: true }));
    await service.runNudgeSweep();
    expect(sentTemplate()).toBe('lifecycle.nudge-gateway');
  });

  it('T+2 with gateway but no first_call -> nudge-first-call', async () => {
    primeSweep(makeUser(STATE_NUDGE_DAY, {}), steps({ provider: true, api: true, gateway: true }));
    await service.runNudgeSweep();
    expect(sentTemplate()).toBe('lifecycle.nudge-first-call');
  });

  it('dedupes the state-aware nudge (stateNudge already sent)', async () => {
    primeSweep(makeUser(STATE_NUDGE_DAY, { stateNudge: '2020-01-01' }), steps());
    const res = await service.runNudgeSweep();
    expect(res.sent).toBe(0);
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
  });

  // ── Showcase (T+5) + last touch (T+10) ─────────────────────────────

  it('T+5 still not activated -> example-showcase', async () => {
    primeSweep(makeUser(SHOWCASE_DAY, { stateNudge: '2020-01-01' }), steps());
    await service.runNudgeSweep();
    expect(sentTemplate()).toBe('lifecycle.example-showcase');
    expect(saved[saved.length - 1].lifecycle.showcase).toEqual(expect.any(String));
  });

  it('T+10 still not activated -> last-touch', async () => {
    primeSweep(
      makeUser(LAST_TOUCH_DAY, { stateNudge: '2020-01-01', showcase: '2020-01-02' }),
      steps(),
    );
    await service.runNudgeSweep();
    expect(sentTemplate()).toBe('lifecycle.last-touch');
    expect(saved[saved.length - 1].lifecycle.lastTouch).toEqual(expect.any(String));
  });

  it('dedupes last-touch (already sent) and sends nothing else', async () => {
    primeSweep(
      makeUser(LAST_TOUCH_DAY, {
        stateNudge: '2020-01-01',
        showcase: '2020-01-02',
        lastTouch: '2020-01-03',
      }),
      steps(),
    );
    const res = await service.runNudgeSweep();
    expect(res.sent).toBe(0);
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
  });

  it('sends at most one email per sweep (day 10, nothing sent yet -> only last-touch)', async () => {
    primeSweep(makeUser(LAST_TOUCH_DAY, {}), steps());
    await service.runNudgeSweep();
    expect(mailService.sendTemplate).toHaveBeenCalledTimes(1);
    expect(sentTemplate()).toBe('lifecycle.last-touch');
  });

  // ── Activation congrats ────────────────────────────────────────────

  it('sends activated-congrats when first_call transitions to true', async () => {
    primeSweep(makeUser(SHOWCASE_DAY, { stateNudge: '2020-01-01' }), steps({ first_call: true }));
    const res = await service.runNudgeSweep();
    expect(res.sent).toBe(1);
    expect(sentTemplate()).toBe('lifecycle.activated-congrats');
    const last = saved[saved.length - 1];
    expect(last.lifecycle.activatedCongrats).toEqual(expect.any(String));
  });

  it('activated-congrats is the ONLY email that sends post-activation (dedupes after)', async () => {
    // Already-activated + congrats already sent: no further email, even
    // though the user is well past the last-touch day.
    primeSweep(
      makeUser(LAST_TOUCH_DAY, { activatedCongrats: '2020-01-05', activated: '2020-01-05' }),
      steps({ provider: true, api: true, gateway: true, first_call: true }),
    );
    const res = await service.runNudgeSweep();
    expect(res.sent).toBe(0);
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
  });

  it('never sends a nudge/showcase/last-touch to an activated user (only congrats)', async () => {
    // Day 10, activated, congrats not yet sent: the ONLY email is congrats,
    // never last-touch.
    primeSweep(makeUser(LAST_TOUCH_DAY, {}), steps({ first_call: true }));
    await service.runNudgeSweep();
    expect(mailService.sendTemplate).toHaveBeenCalledTimes(1);
    expect(sentTemplate()).toBe('lifecycle.activated-congrats');
  });

  it('skips opted-out users in the sweep', async () => {
    const user = makeUser(LAST_TOUCH_DAY, { optOut: true });
    userRepo.find.mockResolvedValue([user]);
    onboardingService.getState.mockResolvedValue({ steps: steps() });

    const res = await service.runNudgeSweep();

    expect(res.sent).toBe(0);
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
    expect(onboardingService.getState).not.toHaveBeenCalled();
  });

  it('no-ops runNudgeSweep when LIFECYCLE_EMAILS_ENABLED is unset (default off)', async () => {
    delete process.env.LIFECYCLE_EMAILS_ENABLED;
    userRepo.find.mockResolvedValue([makeUser(LAST_TOUCH_DAY, {})]);

    const res = await service.runNudgeSweep();

    expect(res).toEqual({ scanned: 0, sent: 0 });
    expect(userRepo.find).not.toHaveBeenCalled();
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
  });

  // ── opt-out + unsubscribe token ────────────────────────────────────

  it('setOptOut persists optOut on preferences.lifecycle', async () => {
    userRepo.findOne.mockResolvedValue(makeUser(0, { welcome: 'x' }));
    await service.setOptOut(USER_ID, true);
    const last = saved[saved.length - 1];
    expect(last.lifecycle.optOut).toBe(true);
    expect(last.lifecycle.welcome).toBe('x'); // other keys preserved
  });

  it('verifies a valid unsubscribe token and rejects a wrong-purpose one', async () => {
    const jwt = (service as any).jwtService as { verify: jest.Mock };
    jwt.verify.mockReturnValueOnce({ userId: USER_ID, purpose: 'lifecycle-unsub' });
    expect(service.verifyUnsubToken('good')).toBe(USER_ID);

    jwt.verify.mockReturnValueOnce({ userId: USER_ID, purpose: 'email_verify' });
    expect(service.verifyUnsubToken('wrong-purpose')).toBeNull();

    jwt.verify.mockImplementationOnce(() => {
      throw new Error('bad sig');
    });
    expect(service.verifyUnsubToken('garbage')).toBeNull();
  });
});
