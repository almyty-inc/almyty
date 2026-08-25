import { HarnessAuthMode } from '../../../entities/harness.entity';
import { DistributionTarget } from '../../../entities/harness-distribution.entity';
import {
  HARNESS_REFUSALS,
  RESERVED_HARNESS_SLUGS,
  checkDistribution,
  checkHarness,
  grantsLocalAccess,
  harnessSlugError,
  isOpenToAnyone,
  type HarnessShape,
} from '../harness.rules';

const harness = (overrides: Partial<HarnessShape> = {}): HarnessShape => ({
  slug: 'acme-support',
  agentIds: ['agent-1'],
  authMode: HarnessAuthMode.PUBLIC_LINK,
  branding: { aiDisclosure: null, whiteLabel: false },
  capabilities: null,
  ...overrides,
});

/** An open product with every guard satisfied, for isolating one failure. */
const SAFE_OPEN = { costCapCents: 500, perUserRateLimit: 20, perIpRateLimit: 60 };

const codes = (result: ReturnType<typeof checkHarness>) => result.refusals.map((r) => r.code);

describe('harnessSlugError', () => {
  it('accepts a usable product name', () => {
    expect(harnessSlugError('acme-support')).toBeNull();
  });

  it('explains each way a name is unusable', () => {
    expect(harnessSlugError('')).toMatch(/Pick a name/);
    expect(harnessSlugError('ab')).toMatch(/at least 3/);
    expect(harnessSlugError('a'.repeat(64))).toMatch(/63 characters/);
    expect(harnessSlugError('-acme')).toMatch(/cannot start or end/);
    expect(harnessSlugError('Acme Support')).toMatch(/lowercase/);
  });

  it('refuses names we route ourselves', () => {
    for (const reserved of RESERVED_HARNESS_SLUGS) {
      expect(harnessSlugError(reserved)).toMatch(/reserved/);
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

describe('checkHarness', () => {
  it('passes an open product with a cost cap and both rate limits', () => {
    expect(checkHarness(harness(), SAFE_OPEN)).toEqual({ ok: true, refusals: [] });
  });

  it('refuses a product with no agents', () => {
    // Nothing for a user to talk to.
    expect(codes(checkHarness(harness({ agentIds: [] }), SAFE_OPEN))).toContain('NO_AGENTS');
  });

  it('refuses an open product with no cost cap', () => {
    const result = checkHarness(harness(), { ...SAFE_OPEN, costCapCents: null });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('PUBLIC_NEEDS_COST_CAP');
  });

  it('requires both rate limits, not either', () => {
    expect(codes(checkHarness(harness(), { ...SAFE_OPEN, perIpRateLimit: 0 }))).toContain(
      'PUBLIC_NEEDS_RATE_LIMIT',
    );
    expect(codes(checkHarness(harness(), { ...SAFE_OPEN, perUserRateLimit: 0 }))).toContain(
      'PUBLIC_NEEDS_RATE_LIMIT',
    );
  });

  it('does not demand caps for a gated product', () => {
    // An internal product behind a login has a gate between a stranger
    // and the spend.
    const internal = harness({ authMode: HarnessAuthMode.EMAIL_OTP });
    expect(checkHarness(internal, {}).ok).toBe(true);
  });

  it('reports every refusal at once rather than one at a time', () => {
    const result = checkHarness(harness({ slug: '', agentIds: [] }), {});
    expect(codes(result).sort()).toEqual([
      'NO_AGENTS',
      'PUBLIC_NEEDS_COST_CAP',
      'PUBLIC_NEEDS_RATE_LIMIT',
      'SLUG_INVALID',
    ]);
  });

  it('pairs every refusal with a sentence an operator can act on', () => {
    for (const refusal of checkHarness(harness({ slug: '' }), {}).refusals) {
      expect(refusal.message).toBe(HARNESS_REFUSALS[refusal.code]);
      expect(refusal.message.length).toBeGreaterThan(20);
    }
  });

  describe('entitlements', () => {
    it('gates SSO', () => {
      const sso = harness({ authMode: HarnessAuthMode.SSO });
      expect(codes(checkHarness(sso, {}))).toContain('SSO_NOT_ENTITLED');
      expect(checkHarness(sso, { hasEnterpriseAuth: true }).ok).toBe(true);
    });

    it('gates white label', () => {
      const wl = harness({ branding: { whiteLabel: true, aiDisclosure: null } });
      expect(codes(checkHarness(wl, SAFE_OPEN))).toContain('WHITE_LABEL_NOT_ENTITLED');
      expect(checkHarness(wl, { ...SAFE_OPEN, hasWhiteLabel: true }).ok).toBe(true);
    });

    it('allows a custom disclosure but gates removing it', () => {
      const custom = harness({ branding: { aiDisclosure: 'This is a bot.', whiteLabel: false } });
      expect(checkHarness(custom, SAFE_OPEN).ok).toBe(true);

      const removed = harness({ branding: { aiDisclosure: '  ', whiteLabel: false } });
      expect(codes(checkHarness(removed, SAFE_OPEN))).toContain(
        'DISCLOSURE_REMOVAL_NOT_ENTITLED',
      );
    });
  });

  describe('local access', () => {
    const internal = (capabilities: HarnessShape['capabilities']) =>
      harness({ authMode: HarnessAuthMode.SSO, capabilities });

    it('refuses local access on a product anyone can download', () => {
      // The artifact runs on someone else's machine: "anyone may use
      // it" and "it may read your disk" must never both be true.
      const result = checkHarness(harness({ capabilities: { filesystemRead: ['~'] } }), SAFE_OPEN);
      expect(codes(result)).toContain('LOCAL_ACCESS_ON_PUBLIC');
    });

    it('requires an approval gate before shell access', () => {
      const result = checkHarness(internal({ shell: true }), { hasEnterpriseAuth: true });
      expect(codes(result)).toContain('LOCAL_ACCESS_NEEDS_APPROVAL_GATE');
    });

    it('allows shell access once approvals are required', () => {
      const result = checkHarness(
        internal({ shell: true, requireApprovalFor: ['shell'] }),
        { hasEnterpriseAuth: true },
      );
      expect(result.ok).toBe(true);
    });

    it('allows read-only filesystem access on a gated product without an approval gate', () => {
      const result = checkHarness(internal({ filesystemRead: ['~/docs'] }), {
        hasEnterpriseAuth: true,
      });
      expect(result.ok).toBe(true);
    });
  });
});

describe('checkDistribution', () => {
  it('carries the harness refusals through', () => {
    const result = checkDistribution(DistributionTarget.WEB, harness({ agentIds: [] }), null, SAFE_OPEN);
    expect(codes(result)).toContain('NO_AGENTS');
  });

  it('needs a bundle id for anything someone installs', () => {
    for (const target of [DistributionTarget.DESKTOP, DistributionTarget.BINARY]) {
      const result = checkDistribution(target, harness(), { bundleId: 'nope' }, SAFE_OPEN);
      expect(codes(result)).toContain('BUNDLE_ID_INVALID');
    }
  });

  it('accepts a reverse-domain bundle id', () => {
    const result = checkDistribution(
      DistributionTarget.DESKTOP,
      harness(),
      { bundleId: 'com.acme.assistant' },
      SAFE_OPEN,
    );
    expect(result.ok).toBe(true);
  });

  it('does not ask a web or terminal distribution for a bundle id', () => {
    for (const target of [DistributionTarget.WEB, DistributionTarget.TUI, DistributionTarget.CHANNEL]) {
      expect(checkDistribution(target, harness(), null, SAFE_OPEN).ok).toBe(true);
    }
  });
});

describe('isOpenToAnyone', () => {
  it('treats an unset auth mode as open, which is the safe reading', () => {
    // Defaulting to "gated" would let an unconfigured product skip the
    // cost cap and rate limit checks.
    expect(isOpenToAnyone(undefined)).toBe(true);
    expect(isOpenToAnyone(HarnessAuthMode.PUBLIC_LINK)).toBe(true);
    expect(isOpenToAnyone(HarnessAuthMode.SSO)).toBe(false);
  });
});
