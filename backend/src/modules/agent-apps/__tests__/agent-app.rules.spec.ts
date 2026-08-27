import { AppAuthMode } from '../../../entities/agent-app.entity';
import { DistributionTarget } from '../../../entities/agent-app-distribution.entity';
import {
  APP_REFUSALS,
  RESERVED_APP_SLUGS,
  checkDistribution,
  checkApp,
  grantsLocalAccess,
  appSlugError,
  isOpenToAnyone,
  type AppShape,
} from '../agent-app.rules';

const app = (overrides: Partial<AppShape> = {}): AppShape => ({
  slug: 'acme-support',
  agentIds: ['agent-1'],
  authMode: AppAuthMode.PUBLIC_LINK,
  branding: { aiDisclosure: null, whiteLabel: false },
  capabilities: null,
  ...overrides,
});

/** An open product with every guard satisfied, for isolating one failure. */
const SAFE_OPEN = { costCapCents: 500, perUserRateLimit: 20, perIpRateLimit: 60 };

const codes = (result: ReturnType<typeof checkApp>) => result.refusals.map((r) => r.code);

describe('appSlugError', () => {
  it('accepts a usable product name', () => {
    expect(appSlugError('acme-support')).toBeNull();
  });

  it('explains each way a name is unusable', () => {
    expect(appSlugError('')).toMatch(/Pick a name/);
    expect(appSlugError('ab')).toMatch(/at least 3/);
    expect(appSlugError('a'.repeat(64))).toMatch(/63 characters/);
    expect(appSlugError('-acme')).toMatch(/cannot start or end/);
    expect(appSlugError('Acme Support')).toMatch(/lowercase/);
  });

  it('refuses names we route ourselves', () => {
    for (const reserved of RESERVED_APP_SLUGS) {
      expect(appSlugError(reserved)).toMatch(/reserved/);
    }
  });
});

describe('grantsLocalAccess', () => {
  it('is false for no capabilities at all', () => {
    expect(grantsLocalAccess(null)).toBe(false);
    expect(grantsLocalAccess({})).toBe(false);
  });

  it('is true for shell, or for any filesystem grant', () => {
    expect(grantsLocalAccess({ shell: true })).toBe(true);
    expect(grantsLocalAccess({ filesystemRead: ['~/notes'] })).toBe(true);
    expect(grantsLocalAccess({ filesystemWrite: ['/tmp'] })).toBe(true);
  });

  it('does not count network access as local access', () => {
    // Reaching a host is not the same as touching the machine.
    expect(grantsLocalAccess({ network: true })).toBe(false);
  });
});

describe('checkApp', () => {
  it('passes an open product with a cost cap and both rate limits', () => {
    expect(checkApp(app(), SAFE_OPEN)).toEqual({ ok: true, refusals: [] });
  });

  it('refuses a product with no agents', () => {
    // Nothing for a user to talk to.
    expect(codes(checkApp(app({ agentIds: [] }), SAFE_OPEN))).toContain('NO_AGENTS');
  });

  it('refuses an open product with no cost cap', () => {
    const result = checkApp(app(), { ...SAFE_OPEN, costCapCents: null });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('PUBLIC_NEEDS_COST_CAP');
  });

  it('requires both rate limits, not either', () => {
    expect(codes(checkApp(app(), { ...SAFE_OPEN, perIpRateLimit: 0 }))).toContain(
      'PUBLIC_NEEDS_RATE_LIMIT',
    );
    expect(codes(checkApp(app(), { ...SAFE_OPEN, perUserRateLimit: 0 }))).toContain(
      'PUBLIC_NEEDS_RATE_LIMIT',
    );
  });

  it('does not demand caps for a gated product', () => {
    // An internal product behind a login has a gate between a stranger
    // and the spend.
    const internal = app({ authMode: AppAuthMode.EMAIL_OTP });
    expect(checkApp(internal, {}).ok).toBe(true);
  });

  it('reports every refusal at once rather than one at a time', () => {
    const result = checkApp(app({ slug: '', agentIds: [] }), {});
    expect(codes(result).sort()).toEqual([
      'NO_AGENTS',
      'PUBLIC_NEEDS_COST_CAP',
      'PUBLIC_NEEDS_RATE_LIMIT',
      'SLUG_INVALID',
    ]);
  });

  it('pairs every refusal with a sentence an operator can act on', () => {
    for (const refusal of checkApp(app({ slug: '' }), {}).refusals) {
      expect(refusal.message).toBe(APP_REFUSALS[refusal.code]);
      expect(refusal.message.length).toBeGreaterThan(20);
    }
  });

  describe('entitlements', () => {
    it('gates SSO', () => {
      const sso = app({ authMode: AppAuthMode.SSO });
      expect(codes(checkApp(sso, {}))).toContain('SSO_NOT_ENTITLED');
      expect(checkApp(sso, { hasEnterpriseAuth: true }).ok).toBe(true);
    });

    it('gates white label', () => {
      const wl = app({ branding: { whiteLabel: true, aiDisclosure: null } });
      expect(codes(checkApp(wl, SAFE_OPEN))).toContain('WHITE_LABEL_NOT_ENTITLED');
      expect(checkApp(wl, { ...SAFE_OPEN, hasWhiteLabel: true }).ok).toBe(true);
    });

    it('allows a custom disclosure but gates removing it', () => {
      const custom = app({ branding: { aiDisclosure: 'This is a bot.', whiteLabel: false } });
      expect(checkApp(custom, SAFE_OPEN).ok).toBe(true);

      const removed = app({ branding: { aiDisclosure: '  ', whiteLabel: false } });
      expect(codes(checkApp(removed, SAFE_OPEN))).toContain(
        'DISCLOSURE_REMOVAL_NOT_ENTITLED',
      );
    });
  });

  describe('local access', () => {
    const internal = (capabilities: AppShape['capabilities']) =>
      app({ authMode: AppAuthMode.SSO, capabilities });

    it('refuses local access on a product anyone can download', () => {
      // The artifact runs on someone else's machine: "anyone may use
      // it" and "it may read your disk" must never both be true.
      const result = checkApp(app({ capabilities: { filesystemRead: ['~'] } }), SAFE_OPEN);
      expect(codes(result)).toContain('LOCAL_ACCESS_ON_PUBLIC');
    });

    it('requires an approval gate before shell access', () => {
      const result = checkApp(internal({ shell: true }), { hasEnterpriseAuth: true });
      expect(codes(result)).toContain('LOCAL_ACCESS_NEEDS_APPROVAL_GATE');
    });

    it('allows shell access once approvals are required', () => {
      const result = checkApp(
        internal({ shell: true, requireApprovalFor: ['shell'] }),
        { hasEnterpriseAuth: true },
      );
      expect(result.ok).toBe(true);
    });

    it('allows read-only filesystem access on a gated product without an approval gate', () => {
      const result = checkApp(internal({ filesystemRead: ['~/docs'] }), {
        hasEnterpriseAuth: true,
      });
      expect(result.ok).toBe(true);
    });
  });
});

describe('checkDistribution', () => {
  it('carries the app refusals through', () => {
    const result = checkDistribution(DistributionTarget.WEB, app({ agentIds: [] }), null, SAFE_OPEN);
    expect(codes(result)).toContain('NO_AGENTS');
  });

  it('needs a bundle id for anything someone installs', () => {
    for (const target of [DistributionTarget.DESKTOP, DistributionTarget.BINARY]) {
      const result = checkDistribution(target, app(), { bundleId: 'nope' }, SAFE_OPEN);
      expect(codes(result)).toContain('BUNDLE_ID_INVALID');
    }
  });

  it('accepts a reverse-domain bundle id', () => {
    const result = checkDistribution(
      DistributionTarget.DESKTOP,
      app(),
      { bundleId: 'com.acme.assistant' },
      SAFE_OPEN,
    );
    expect(result.ok).toBe(true);
  });

  it('does not ask a web or terminal distribution for a bundle id', () => {
    for (const target of [DistributionTarget.WEB, DistributionTarget.TUI, DistributionTarget.SLACK]) {
      expect(checkDistribution(target, app(), null, SAFE_OPEN).ok).toBe(true);
    }
  });
});

describe('isOpenToAnyone', () => {
  it('treats an unset auth mode as open, which is the safe reading', () => {
    // Defaulting to "gated" would let an unconfigured product skip the
    // cost cap and rate limit checks.
    expect(isOpenToAnyone(undefined)).toBe(true);
    expect(isOpenToAnyone(AppAuthMode.PUBLIC_LINK)).toBe(true);
    expect(isOpenToAnyone(AppAuthMode.SSO)).toBe(false);
  });
});
