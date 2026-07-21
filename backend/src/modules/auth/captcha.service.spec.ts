import { CaptchaService } from './captcha.service';

describe('CaptchaService', () => {
  let service: CaptchaService;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    service = new CaptchaService();
    delete process.env.TURNSTILE_SECRET;
    delete process.env.HCAPTCHA_SECRET;
    delete process.env.CAPTCHA_PROVIDER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe('when no secret is configured (ships dark)', () => {
    it('reports disabled', () => {
      expect(service.isEnabled()).toBe(false);
    });

    it('verify() is a no-op that always passes, even with no token', async () => {
      await expect(service.verify(undefined)).resolves.toBe(true);
      await expect(service.verify('anything')).resolves.toBe(true);
    });
  });

  describe('when TURNSTILE_SECRET is set', () => {
    beforeEach(() => {
      process.env.TURNSTILE_SECRET = 'secret-xyz';
    });

    it('reports enabled', () => {
      expect(service.isEnabled()).toBe(true);
    });

    it('rejects a missing token without calling the verifier', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch' as any);
      await expect(service.verify(undefined)).resolves.toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects when the verifier reports failure', async () => {
      jest.spyOn(global, 'fetch' as any).mockResolvedValue({
        ok: true,
        json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
      } as any);
      await expect(service.verify('bad-token')).resolves.toBe(false);
    });

    it('accepts when the verifier reports success', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as any);
      await expect(service.verify('good-token', '203.0.113.1')).resolves.toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('fails closed when the verifier is unreachable', async () => {
      jest.spyOn(global, 'fetch' as any).mockRejectedValue(new Error('network down'));
      await expect(service.verify('any-token')).resolves.toBe(false);
    });

    it('fails closed on a non-2xx verifier response', async () => {
      jest.spyOn(global, 'fetch' as any).mockResolvedValue({ ok: false, status: 500 } as any);
      await expect(service.verify('any-token')).resolves.toBe(false);
    });
  });

  describe('when HCAPTCHA_SECRET is set', () => {
    beforeEach(() => {
      process.env.HCAPTCHA_SECRET = 'hc-secret';
    });

    it('uses the hCaptcha siteverify endpoint', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as any);
      await expect(service.verify('tok')).resolves.toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://hcaptcha.com/siteverify',
        expect.anything(),
      );
    });
  });
});
