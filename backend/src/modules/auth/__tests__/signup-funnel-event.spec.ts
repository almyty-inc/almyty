import { AuthService } from '../auth.service';
import { User } from '../../../entities/user.entity';

/**
 * Sign-up's side of the funnel: `signup_completed` is asked for exactly
 * where an account becomes verified (opening the link, or creation on an
 * AUTO_VERIFY_EMAIL_DOMAIN address), and the sign-up link's attribution is
 * whitelisted before it is stored on the user.
 */
function makeService() {
  const created: any[] = [];
  const tx = {
    create: (_cls: any, data: any) => {
      if (_cls === User) created.push(data);
      return data;
    },
    save: async (_cls: any, entity: any) => ({ ...entity, id: _cls === User ? 'user-123' : 'org-123' }),
  };
  const userRepo: any = {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(async (u: any) => u),
    manager: { transaction: jest.fn(async (cb: any) => cb(tx)) },
  };
  const orgRepo: any = { findOne: jest.fn().mockResolvedValue(null) };
  const jwt: any = { sign: jest.fn().mockReturnValue('signed-token'), verify: jest.fn() };
  const mail: any = { sendEmailVerification: jest.fn().mockResolvedValue(true) };
  const analytics = { signupCompleted: jest.fn().mockResolvedValue(undefined) };
  const svc = new AuthService(
    userRepo,
    {} as any,
    orgRepo,
    {} as any,
    jwt,
    { log: jest.fn() } as any,
    mail,
    { attributeSignup: jest.fn() } as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    analytics as any,
  );
  return { svc, userRepo, jwt, analytics, created };
}

const dto = {
  email: 'dana@example.com',
  password: 'Secret123',
  firstName: 'Dana',
  lastName: 'Lind',
  organizationName: 'Lind Labs',
};

describe('sign-up funnel event', () => {
  const saved = process.env.AUTO_VERIFY_EMAIL_DOMAIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTO_VERIFY_EMAIL_DOMAIN;
    else process.env.AUTO_VERIFY_EMAIL_DOMAIN = saved;
  });

  it('is asked for when the verification link is opened', async () => {
    const { svc, userRepo, jwt, analytics } = makeService();
    jwt.verify.mockReturnValue({ sub: 'u1', email: 'dana@example.com', purpose: 'email_verify' });
    userRepo.findOne.mockResolvedValue({ id: 'u1', email: 'dana@example.com', isVerified: false, verifiedAt: null });

    await svc.verifyEmail('signed-token');

    expect(analytics.signupCompleted).toHaveBeenCalledWith('u1');
    // After the verified row is written, so the claim's WHERE can match it.
    expect(userRepo.save.mock.invocationCallOrder[0]).toBeLessThan(analytics.signupCompleted.mock.invocationCallOrder[0]);
  });

  it('is asked for at creation for an auto-verified address (test stacks)', async () => {
    process.env.AUTO_VERIFY_EMAIL_DOMAIN = 'test.almyty.com';
    const { svc, analytics } = makeService();

    await svc.register({ ...dto, email: 'journey@test.almyty.com' });

    expect(analytics.signupCompleted).toHaveBeenCalledWith('user-123');
  });

  it('is not asked for when the account still has to confirm its address', async () => {
    delete process.env.AUTO_VERIFY_EMAIL_DOMAIN;
    const { svc, analytics } = makeService();

    await svc.register(dto);

    expect(analytics.signupCompleted).not.toHaveBeenCalled();
  });

  it('stores only the whitelisted, capped attribution on the new user', async () => {
    const { svc, created } = makeService();

    await svc.register({
      ...dto,
      attribution: {
        utm_source: 'almyty.com',
        utm_campaign: 'x'.repeat(250),
        utm_content: 'dana@example.com',
        cta: 'hero',
        utm_term: 'not on the list',
        gclid: 'abc',
      } as any,
    });

    expect(created[0].signupAttribution).toEqual({
      utm_source: 'almyty.com',
      utm_campaign: 'x'.repeat(100),
      cta: 'hero',
    });
  });

  it('stores null when the link carried no attribution', async () => {
    const { svc, created } = makeService();
    await svc.register(dto);
    expect(created[0].signupAttribution).toBeNull();
  });
});
