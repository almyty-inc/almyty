import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { AppAuthMode } from '../../../entities/agent-app.entity';
import {
  GATED_AUTH_MODES,
  checkApp,
  defaultLimitsFor,
  isOpenToAnyone,
} from '../agent-app.rules';

/**
 * `AppAuthMode` declares four modes and the settings panel offers four.
 * Only SSO keeps a stranger out. `oauth` has no route that ever binds an
 * identity, and `email_otp` binds one anybody with an inbox can get --
 * but isOpenToAnyone() once asked "is this public_link?", so picking
 * either made an app count as GATED:
 *
 *   - PUBLIC_NEEDS_COST_CAP and PUBLIC_NEEDS_RATE_LIMIT stopped firing;
 *   - defaultLimitsFor() seeded perUserRateLimit / perIpRateLimit as null;
 *   - LOCAL_ACCESS_ON_PUBLIC stopped firing, so a desktop or binary build
 *     with `capabilities.shell` could ship to anyone who downloaded it.
 *
 * An unwired unit at its worst: the mode existed, compiled, appeared in a
 * dropdown, had a passing test asserting the gated behaviour, and gated
 * nothing.
 *
 * What it guards:
 *   1. GATED_AUTH_MODES lists only modes a route can actually satisfy --
 *      the arm that fails if someone adds one back without a sign-in flow;
 *   2. every unimplemented mode is treated as open by all three consumers;
 *   3. the caps and the local-access refusal really fire for them.
 */
const REPO = join(__dirname, '..', '..', '..', '..', '..');

/** Every mode some route hands to bindAuthenticatedVisitor. */
function modesWithASignInRoute(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === 'node_modules' || name === '__tests__') continue;
        walk(p);
        continue;
      }
      if (!name.endsWith('.ts') || name.includes('.spec.')) continue;
      const src = readFileSync(p, 'utf8');
            // A CALL, not the definition: hosted-chat.service.ts declares the
      // method and names all four modes in its parameter type, which is
      // exactly the sort of mention that must not count as a sign-in flow.
      if (!/\.\s*bindAuthenticatedVisitor\(/.test(src)) continue;
      for (const mode of Object.values(AppAuthMode)) {
        if (new RegExp(`['"\`]${mode}['"\`]`).test(src)) found.add(mode);
      }
    }
  };
  walk(join(REPO, 'backend', 'src'));
  walk(join(REPO, 'backend', 'ee'));
  return found;
}

describe('an auth mode only counts as a gate when something can satisfy it', () => {
  it('every gated mode has a route that binds an identity for it', () => {
    const implemented = modesWithASignInRoute();
    expect(implemented.size).toBeGreaterThan(0);
    for (const mode of GATED_AUTH_MODES) {
      expect([...implemented]).toContain(mode);
    }
  });

  it('modes with no such route are treated as open', () => {
    const implemented = modesWithASignInRoute();
    const unimplemented = Object.values(AppAuthMode).filter((m) => !implemented.has(m));
    // public_link is open by definition; the point is the others.
    expect(unimplemented).toContain(AppAuthMode.OAUTH);
    for (const mode of unimplemented) {
      expect(isOpenToAnyone(mode)).toBe(true);
    }
  });

  it('email codes have a sign-in route but stay open: anyone with an inbox passes', () => {
    expect(modesWithASignInRoute().has(AppAuthMode.EMAIL_OTP)).toBe(true);
    expect(GATED_AUTH_MODES).not.toContain(AppAuthMode.EMAIL_OTP);
    expect(isOpenToAnyone(AppAuthMode.EMAIL_OTP)).toBe(true);
  });
});

describe('the consequences of being open still apply to those modes', () => {
  const app = (over: any = {}) => ({
    slug: 'demo',
    agentIds: ['a1'],
    ...over,
  });
  const codes = (r: { refusals: Array<{ code: string }> }) => r.refusals.map((x) => x.code);

  it.each([AppAuthMode.EMAIL_OTP, AppAuthMode.OAUTH, AppAuthMode.PUBLIC_LINK])(
    '%s demands a cost cap and rate limits',
    (mode) => {
      expect(codes(checkApp(app({ authMode: mode }), {}))).toEqual(
        expect.arrayContaining(['PUBLIC_NEEDS_COST_CAP', 'PUBLIC_NEEDS_RATE_LIMIT']),
      );
    },
  );

  it.each([AppAuthMode.EMAIL_OTP, AppAuthMode.OAUTH])(
    '%s refuses an app that grants a shell on the installer machine',
    (mode) => {
      const risky = app({
        authMode: mode,
        capabilities: { shell: true, requireApprovalFor: ['shell'] },
      });
      const result = checkApp(risky, { costCapCents: 50, perUserRateLimit: 60, perIpRateLimit: 120 });
      expect(codes(result)).toContain('LOCAL_ACCESS_ON_PUBLIC');
    },
  );

  it.each([AppAuthMode.EMAIL_OTP, AppAuthMode.OAUTH])(
    '%s seeds real rate limits rather than null',
    (mode) => {
      const limits = defaultLimitsFor(mode);
      expect(limits.perUserRateLimit).toBeGreaterThan(0);
      expect(limits.perIpRateLimit).toBeGreaterThan(0);
    },
  );

  it('still exempts a mode that is genuinely gated', () => {
    expect(checkApp(app({ authMode: AppAuthMode.SSO }), { hasEnterpriseAuth: true }).ok).toBe(true);
    expect(defaultLimitsFor(AppAuthMode.SSO).perUserRateLimit).toBeNull();
  });
});
