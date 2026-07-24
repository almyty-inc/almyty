import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';

import {
  LifecycleEmailService,
  NUDGE_PROVIDER_DAY,
  NUDGE_API_DAY,
  NUDGE_FINAL_DAY,
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

  // ── sendWelcome ────────────────────────────────────────────────────

  it('sends the welcome email once, then dedupes', async () => {
    const user = makeUser(0);
    // First call: no welcome recorded. writeState reloads the user, so
    // findOne is called twice (send-time load + writeState load).
    userRepo.findOne.mockResolvedValue(user);

    await service.sendWelcome(USER_ID);

    expect(mailService.sendTemplate).toHaveBeenCalledTimes(1);
    expect(mailService.sendTemplate).toHaveBeenCalledWith(
      user.email,
      'lifecycle.welcome',
      expect.objectContaining({ firstName: 'Ada', unsubscribeUrl: expect.any(String) }),
    );
    // welcome timestamp persisted
    const last = saved[saved.length - 1];
    expect(last.lifecycle.welcome).toEqual(expect.any(String));

    // Second run with the welcome already recorded: no send.
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

  // ── runNudgeSweep targeting ────────────────────────────────────────

  it('sends the provider nudge at day >= 1 when no provider connected', async () => {
    const user = makeUser(NUDGE_PROVIDER_DAY, {});
    userRepo.find.mockResolvedValue([user]);
    userRepo.findOne.mockResolvedValue(user); // for writeState
    onboardingService.getState.mockResolvedValue({ steps: steps() });

    const res = await service.runNudgeSweep();

    expect(res.sent).toBe(1);
    expect(mailService.sendTemplate).toHaveBeenCalledTimes(1);
    expect(mailService.sendTemplate).toHaveBeenCalledWith(
      user.email,
      'lifecycle.nudge-provider',
      expect.any(Object),
    );
    expect(saved[saved.length - 1].lifecycle.nudgeProvider).toEqual(expect.any(String));
  });

  it('sends the api nudge at day >= 3 when provider present but no gateway', async () => {
    const user = makeUser(NUDGE_API_DAY, { nudgeProvider: '2020-01-01' });
    userRepo.find.mockResolvedValue([user]);
    userRepo.findOne.mockResolvedValue(user);
    onboardingService.getState.mockResolvedValue({ steps: steps({ provider: true }) });

    await service.runNudgeSweep();

    expect(mailService.sendTemplate).toHaveBeenCalledWith(
      user.email,
      'lifecycle.nudge-api',
      expect.any(Object),
    );
  });

  it('sends the final nudge at day >= 7 when still not activated', async () => {
    const user = makeUser(NUDGE_FINAL_DAY, {
      nudgeProvider: '2020-01-01',
      nudgeApi: '2020-01-02',
    });
    userRepo.find.mockResolvedValue([user]);
    userRepo.findOne.mockResolvedValue(user);
    onboardingService.getState.mockResolvedValue({ steps: steps({ provider: true, api: true, gateway: true }) });

    await service.runNudgeSweep();

    expect(mailService.sendTemplate).toHaveBeenCalledWith(
      user.email,
      'lifecycle.nudge-final',
      expect.any(Object),
    );
  });

  it('sends at most one nudge per user per sweep', async () => {
    // Day 7, nothing done and nothing sent: multiple nudges are "due" but
    // only the most-progressed (final) one fires.
    const user = makeUser(NUDGE_FINAL_DAY, {});
    userRepo.find.mockResolvedValue([user]);
    userRepo.findOne.mockResolvedValue(user);
    onboardingService.getState.mockResolvedValue({ steps: steps() });

    await service.runNudgeSweep();

    expect(mailService.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('dedupes an already-sent nudge', async () => {
    const user = makeUser(NUDGE_PROVIDER_DAY, { nudgeProvider: '2020-01-01' });
    userRepo.find.mockResolvedValue([user]);
    userRepo.findOne.mockResolvedValue(user);
    onboardingService.getState.mockResolvedValue({ steps: steps() });

    const res = await service.runNudgeSweep();

    expect(res.sent).toBe(0);
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
  });

  it('never nudges an activated user (first_call true)', async () => {
    const user = makeUser(NUDGE_FINAL_DAY, {});
    userRepo.find.mockResolvedValue([user]);
    userRepo.findOne.mockResolvedValue(user);
    onboardingService.getState.mockResolvedValue({ steps: steps({ first_call: true }) });

    const res = await service.runNudgeSweep();

    expect(res.sent).toBe(0);
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
    // activated is marked
    expect(saved[saved.length - 1].lifecycle.activated).toEqual(expect.any(String));
  });

  it('skips opted-out users in the sweep', async () => {
    const user = makeUser(NUDGE_FINAL_DAY, { optOut: true });
    userRepo.find.mockResolvedValue([user]);
    onboardingService.getState.mockResolvedValue({ steps: steps() });

    const res = await service.runNudgeSweep();

    expect(res.sent).toBe(0);
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
    expect(onboardingService.getState).not.toHaveBeenCalled();
  });

  it('no-ops runNudgeSweep when LIFECYCLE_EMAILS_ENABLED is unset (default off)', async () => {
    delete process.env.LIFECYCLE_EMAILS_ENABLED;
    userRepo.find.mockResolvedValue([makeUser(NUDGE_FINAL_DAY, {})]);

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
