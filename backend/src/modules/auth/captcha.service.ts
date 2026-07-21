import { Injectable, Logger } from '@nestjs/common';

/**
 * Pluggable CAPTCHA verification for the registration path.
 *
 * Ships DARK: with no secret configured this is a no-op that always passes,
 * so the feature can be turned on in production by setting an env var alone —
 * no code change, no redeploy of application logic.
 *
 * Supports Cloudflare Turnstile and hCaptcha (both expose a compatible
 * `siteverify` POST endpoint). Provider is auto-detected from which secret is
 * set; `CAPTCHA_PROVIDER` can force one explicitly.
 *
 * Env:
 *   TURNSTILE_SECRET   - Cloudflare Turnstile secret key (enables Turnstile)
 *   HCAPTCHA_SECRET    - hCaptcha secret key (enables hCaptcha)
 *   CAPTCHA_PROVIDER   - optional: 'turnstile' | 'hcaptcha' (override)
 */
@Injectable()
export class CaptchaService {
  private readonly logger = new Logger(CaptchaService.name);

  private readonly endpoints: Record<string, string> = {
    turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    hcaptcha: 'https://hcaptcha.com/siteverify',
  };

  /** Which provider (if any) is configured. Recomputed each call so tests can toggle env. */
  private resolve(): { provider: 'turnstile' | 'hcaptcha'; secret: string } | null {
    const forced = (process.env.CAPTCHA_PROVIDER || '').toLowerCase();
    const turnstile = process.env.TURNSTILE_SECRET;
    const hcaptcha = process.env.HCAPTCHA_SECRET;

    if (forced === 'turnstile' && turnstile) return { provider: 'turnstile', secret: turnstile };
    if (forced === 'hcaptcha' && hcaptcha) return { provider: 'hcaptcha', secret: hcaptcha };

    if (turnstile) return { provider: 'turnstile', secret: turnstile };
    if (hcaptcha) return { provider: 'hcaptcha', secret: hcaptcha };
    return null;
  }

  /** True when a CAPTCHA secret is configured and verification is enforced. */
  isEnabled(): boolean {
    return this.resolve() !== null;
  }

  /**
   * Verify a client-supplied CAPTCHA token.
   *
   * - Returns `true` when no provider is configured (feature ships dark).
   * - Returns `false` when a provider IS configured but the token is
   *   missing, malformed, or rejected by the upstream siteverify endpoint.
   *   A network failure to the verifier also fails closed (returns false) so
   *   an attacker can't disable the check by knocking the verifier offline.
   */
  async verify(token: string | undefined, remoteIp?: string): Promise<boolean> {
    const cfg = this.resolve();
    if (!cfg) {
      // No secret set -> no-op, always allow.
      return true;
    }

    if (!token || typeof token !== 'string') {
      return false;
    }

    const body = new URLSearchParams();
    body.append('secret', cfg.secret);
    body.append('response', token);
    if (remoteIp) body.append('remoteip', remoteIp);

    try {
      const res = await fetch(this.endpoints[cfg.provider], {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!res.ok) {
        this.logger.warn(`CAPTCHA verify HTTP ${res.status} from ${cfg.provider}`);
        return false;
      }
      const data: any = await res.json();
      return data?.success === true;
    } catch (err) {
      // Fail closed: if the verifier is unreachable we do NOT let the signup
      // through, otherwise the protection is trivially bypassable.
      this.logger.warn(`CAPTCHA verify error (${cfg.provider}): ${(err as Error).message}`);
      return false;
    }
  }
}
