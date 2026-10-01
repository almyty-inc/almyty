import { ChannelType, VisitorAuthMode } from '../../../entities/agent-channel.entity';
import {
  CHANNEL_REFUSALS,
  DEFAULT_PUBLIC_DAILY_SPEND_CAP_CENTS,
  RESERVED_CHANNEL_SLUGS,
  CHANNEL_DEFAULT_NAMES,
  carriesDisclosure,
  channelNameError,
  channelSlugError,
  channelSlugFromName,
  checkChannel,
  defaultChannelName,
  defaultBundleId,
  effectiveBranding,
  effectiveVisitorRules,
  grantsLocalAccess,
  isOpenToAnyone,
  normalizeBranding,
  normalizeVisitorRules,
  type ChannelShape,
} from '../channel-rules';

/** An open channel with every guard satisfied, for isolating one failure. */
const SAFE_LIMITS = { costCapCents: 500, perUserRateLimit: 20, perIpRateLimit: 60 };

const channel = (overrides: Partial<ChannelShape> & { authMode?: VisitorAuthMode; limits?: any } = {}): ChannelShape => {
  const { authMode, limits, ...rest } = overrides;
  return {
    type: ChannelType.WEB,
    slug: 'acme-support',
    configuration: null,
    branding: { aiDisclosure: null, whiteLabel: false },
    rules: { authMode: authMode ?? VisitorAuthMode.PUBLIC_LINK, limits: limits ?? SAFE_LIMITS },
    ...rest,
  };
};

const codes = (result: ReturnType<typeof checkChannel>) => result.refusals.map((r) => r.code);

describe('channel names', () => {
  it('starts a channel at its type\'s label, numbered when the agent has one of that name', () => {
    expect(defaultChannelName(ChannelType.SLACK, () => false)).toBe('Slack');
    const taken = new Set(['Slack', 'Slack 2']);
    expect(defaultChannelName(ChannelType.SLACK, (n) => taken.has(n))).toBe('Slack 3');
    for (const type of Object.values(ChannelType)) expect(CHANNEL_DEFAULT_NAMES[type]).toBeTruthy();
  });

  it('wants a name, and not a long one', () => {
    expect(channelNameError('Slack for sales')).toBeNull();
    expect(channelNameError('   ')).toBe('Give the channel a name.');
    expect(channelNameError('x'.repeat(121))).toBe('Keep the name to 120 characters.');
  });
});

describe('channelSlugError', () => {
  it('accepts a usable address', () => {
    expect(channelSlugError('acme-support')).toBeNull();
  });

  it('explains each way an address is unusable', () => {
    expect(channelSlugError('')).toMatch(/Pick an address/);
    expect(channelSlugError('ab')).toMatch(/at least 3/);
    expect(channelSlugError('a'.repeat(64))).toMatch(/63 characters/);
    expect(channelSlugError('-acme')).toMatch(/cannot start or end/);
    expect(channelSlugError('Acme Support')).toMatch(/lowercase/);
  });

  it('refuses addresses we route ourselves', () => {
    for (const reserved of RESERVED_CHANNEL_SLUGS) expect(channelSlugError(reserved)).toMatch(/reserved/);
  });
});

describe('channelSlugFromName', () => {
  it('makes an address from the agent name and steps past taken ones', () => {
    expect(channelSlugFromName('Support Agent', () => false)).toBe('support-agent');
    expect(channelSlugFromName('Support Agent', (s) => s === 'support-agent')).toBe('support-agent-2');
    expect(channelSlugFromName('é', () => false)).not.toBe('');
    expect(channelSlugError(channelSlugFromName('api', () => false))).toBeNull();
  });
});

describe('grantsLocalAccess', () => {
  it('is false for no capabilities at all', () => {
    expect(grantsLocalAccess(null)).toBe(false);
    expect(grantsLocalAccess({})).toBe(false);
  });

  it('is true for shell, or for any filesystem grant, and not for network', () => {
    expect(grantsLocalAccess({ shell: true })).toBe(true);
    expect(grantsLocalAccess({ filesystemRead: ['~/notes'] })).toBe(true);
    expect(grantsLocalAccess({ filesystemWrite: ['/tmp'] })).toBe(true);
    expect(grantsLocalAccess({ network: true })).toBe(false);
  });
});

describe('checkChannel', () => {
  it('passes an open web chat with a cost cap and both rate limits', () => {
    expect(checkChannel(channel())).toEqual({ ok: true, refusals: [] });
  });

  it('refuses an open channel with no cost cap', () => {
    expect(codes(checkChannel(channel({ limits: { ...SAFE_LIMITS, costCapCents: null } })))).toContain('PUBLIC_NEEDS_COST_CAP');
  });

  it('requires both rate limits, not either', () => {
    expect(codes(checkChannel(channel({ limits: { ...SAFE_LIMITS, perIpRateLimit: 0 } })))).toContain('PUBLIC_NEEDS_RATE_LIMIT');
    expect(codes(checkChannel(channel({ limits: { ...SAFE_LIMITS, perUserRateLimit: 0 } })))).toContain('PUBLIC_NEEDS_RATE_LIMIT');
  });

  it('does not demand caps behind SSO', () => {
    expect(checkChannel(channel({ authMode: VisitorAuthMode.SSO, limits: {} }), { hasEnterpriseAuth: true }).ok).toBe(true);
  });

  it('reports every refusal at once, each with a sentence an operator can act on', () => {
    const result = checkChannel(channel({ slug: '', limits: {} }));
    expect(codes(result).sort()).toEqual(['PUBLIC_NEEDS_COST_CAP', 'PUBLIC_NEEDS_RATE_LIMIT', 'SLUG_INVALID']);
    for (const refusal of result.refusals) {
      expect(refusal.message).toBe(CHANNEL_REFUSALS[refusal.code]);
      expect(refusal.message.length).toBeGreaterThan(20);
    }
  });

  it('only asks the web chat and the downloads for an address', () => {
    expect(codes(checkChannel(channel({ type: ChannelType.A2A, slug: null })))).not.toContain('SLUG_INVALID');
    expect(codes(checkChannel(channel({ type: ChannelType.TUI, slug: null })))).toContain('SLUG_INVALID');
  });

  describe('entitlements', () => {
    it('gates SSO', () => {
      const sso = channel({ authMode: VisitorAuthMode.SSO });
      expect(codes(checkChannel(sso))).toContain('SSO_NOT_ENTITLED');
      expect(checkChannel(sso, { hasEnterpriseAuth: true }).ok).toBe(true);
    });

    it('gates white label', () => {
      const wl = channel({ branding: { whiteLabel: true, aiDisclosure: null } });
      expect(codes(checkChannel(wl))).toContain('WHITE_LABEL_NOT_ENTITLED');
      expect(checkChannel(wl, { hasWhiteLabel: true }).ok).toBe(true);
    });

    it('allows a custom disclosure but gates removing it', () => {
      expect(checkChannel(channel({ branding: { aiDisclosure: 'This is a bot.' } })).ok).toBe(true);
      expect(codes(checkChannel(channel({ branding: { aiDisclosure: '  ' } })))).toContain('DISCLOSURE_REMOVAL_NOT_ENTITLED');
    });

    it('treats the disclosure switch turned off as a removal, only on a channel people talk to', () => {
      const off = { aiDisclosure: false };
      expect(codes(checkChannel(channel({ configuration: off })))).toContain('DISCLOSURE_REMOVAL_NOT_ENTITLED');
      expect(codes(checkChannel(channel({ type: ChannelType.SLACK, slug: null, configuration: { ...off, credentialKeys: ['bot_token'] } })))).toContain(
        'DISCLOSURE_REMOVAL_NOT_ENTITLED',
      );
      expect(codes(checkChannel(channel({ configuration: off }), { hasWhiteLabel: true }))).not.toContain('DISCLOSURE_REMOVAL_NOT_ENTITLED');
      expect(codes(checkChannel(channel({ configuration: { aiDisclosure: true } })))).not.toContain('DISCLOSURE_REMOVAL_NOT_ENTITLED');
      expect(carriesDisclosure(ChannelType.A2A)).toBe(false);
      expect(carriesDisclosure(ChannelType.WIDGET)).toBe(true);
    });
  });

  describe('local access on a download', () => {
    const download = (capabilities: any, authMode = VisitorAuthMode.SSO) =>
      channel({ type: ChannelType.DESKTOP, authMode, configuration: { bundleId: 'com.acme.app', capabilities } });

    it('refuses local access on a download anyone can use', () => {
      expect(codes(checkChannel(download({ filesystemRead: ['~'] }, VisitorAuthMode.PUBLIC_LINK)))).toContain('LOCAL_ACCESS_ON_PUBLIC');
    });

    it('requires an approval gate before shell access, and allows it once there is one', () => {
      expect(codes(checkChannel(download({ shell: true }), { hasEnterpriseAuth: true }))).toContain('LOCAL_ACCESS_NEEDS_APPROVAL_GATE');
      expect(checkChannel(download({ shell: true, requireApprovalFor: ['shell'] }), { hasEnterpriseAuth: true }).ok).toBe(true);
    });

    it('never applies to a channel that is not a download', () => {
      const web = channel({ configuration: { capabilities: { shell: true } } });
      expect(codes(checkChannel(web))).not.toContain('LOCAL_ACCESS_NEEDS_APPROVAL_GATE');
    });
  });

  it('says up front that the website widget only goes on a channel anyone can use', () => {
    expect(codes(checkChannel(channel({ type: ChannelType.WIDGET, slug: null, authMode: VisitorAuthMode.EMAIL_OTP })))).toContain(
      'WIDGET_HAS_NO_SIGN_IN',
    );
    expect(codes(checkChannel(channel({ type: ChannelType.WIDGET, slug: null })))).not.toContain('WIDGET_HAS_NO_SIGN_IN');
    expect(codes(checkChannel(channel({ authMode: VisitorAuthMode.EMAIL_OTP })))).not.toContain('WIDGET_HAS_NO_SIGN_IN');
  });

  it('needs a reverse-domain bundle id for a desktop app', () => {
    expect(codes(checkChannel(channel({ type: ChannelType.DESKTOP, configuration: { bundleId: 'nope' } })))).toContain('BUNDLE_ID_INVALID');
    expect(checkChannel(channel({ type: ChannelType.DESKTOP, configuration: { bundleId: 'com.acme.assistant' } })).ok).toBe(true);
  });

  it('is not ready while a messaging channel is missing keys, and names them', () => {
    const empty = checkChannel(channel({ type: ChannelType.SLACK, slug: null }));
    expect(codes(empty)).toContain('MISSING_CREDENTIALS');
    const half = checkChannel(channel({ type: ChannelType.SLACK, slug: null, configuration: { bot_token: 'xoxb-1' } }));
    expect(half.refusals.find((r) => r.code === 'MISSING_CREDENTIALS')?.message).toContain('signing_secret');
    const kept = checkChannel(
      channel({ type: ChannelType.SLACK, slug: null, configuration: { credentialId: 'c-1', credentialKeys: ['bot_token', 'signing_secret'] } }),
    );
    expect(kept.ok).toBe(true);
  });

  // LoopMessage sends every reply from a sender name, set on the channel.
  // Without one the relay refuses every reply, so publishing is refused
  // first, in words that say what to enter.
  it('will not publish a LoopMessage channel without a sender name, and says so plainly', () => {
    const keys = { credentialId: 'c-loop', credentialKeys: ['api_key', 'inbound_token'] };
    const unnamed = checkChannel(channel({ type: ChannelType.IMESSAGE_LOOPMESSAGE, slug: null, configuration: keys }));
    expect(codes(unnamed)).toEqual(['SENDER_NAME_REQUIRED']);
    expect(unnamed.refusals[0].message).toBe(CHANNEL_REFUSALS.SENDER_NAME_REQUIRED);
    expect(unnamed.refusals[0].message).toMatch(/sender name/);

    const blank = checkChannel(channel({ type: ChannelType.IMESSAGE_LOOPMESSAGE, slug: null, configuration: { ...keys, sender_name: '   ' } }));
    expect(codes(blank)).toContain('SENDER_NAME_REQUIRED');

    const named = checkChannel(channel({ type: ChannelType.IMESSAGE_LOOPMESSAGE, slug: null, configuration: { ...keys, sender_name: 'northwind' } }));
    expect(named.ok).toBe(true);

    // Sendblue replies from its line, which the credential holds.
    const sendblue = checkChannel(
      channel({
        type: ChannelType.IMESSAGE_SENDBLUE,
        slug: null,
        configuration: { phone_number: '+15122164639', credentialId: 'c-sb', credentialKeys: ['api_key_id', 'api_secret_key', 'signing_secret'] },
      }),
    );
    expect(codes(sendblue)).not.toContain('SENDER_NAME_REQUIRED');
  });
});

describe('isOpenToAnyone', () => {
  it('treats an unset auth mode as open, which is the safe reading', () => {
    expect(isOpenToAnyone(undefined)).toBe(true);
    expect(isOpenToAnyone(VisitorAuthMode.PUBLIC_LINK)).toBe(true);
    expect(isOpenToAnyone(VisitorAuthMode.SSO)).toBe(false);
  });
});

describe('defaultBundleId', () => {
  it('makes an id the check accepts from any address', () => {
    expect(defaultBundleId('support-bot', 'app.almyty')).toBe('app.almyty.supportbot');
    const refusals = checkChannel(channel({ type: ChannelType.DESKTOP, configuration: { bundleId: defaultBundleId('acme-support') } })).refusals;
    expect(refusals.map((r) => r.code)).not.toContain('BUNDLE_ID_INVALID');
  });
});

describe('what a channel resolves to on its agent', () => {
  const agent = {
    name: 'Support agent',
    branding: { appName: 'Acme', primaryColor: '#0f766e', greeting: 'Hi' },
    visitorRules: { authMode: VisitorAuthMode.EMAIL_OTP, limits: { perUserRateLimit: 30 }, privacy: { visitorCanExport: false } },
  };

  it("inherits the agent's branding and names itself after the agent when nothing names it", () => {
    expect(effectiveBranding(agent)).toMatchObject({ appName: 'Acme', primaryColor: '#0f766e', greeting: 'Hi' });
    expect(effectiveBranding({ name: 'Support agent', branding: null }).appName).toBe('Support agent');
    expect(effectiveBranding({ name: 'Support agent', branding: { appName: '  ' } }).appName).toBe('Support agent');
  });

  it("overrides the agent's branding field by field", () => {
    const branding = effectiveBranding(agent, { branding: { greeting: 'Hello from Slack' } });
    expect(branding).toMatchObject({ appName: 'Acme', primaryColor: '#0f766e', greeting: 'Hello from Slack' });
  });

  it("inherits the agent's visitor rules, filling what neither sets with the defaults for the mode", () => {
    const rules = effectiveVisitorRules(agent);
    expect(rules.authMode).toBe(VisitorAuthMode.EMAIL_OTP);
    expect(rules.limits).toEqual({ costCapCents: 50, perUserRateLimit: 30, perIpRateLimit: 120 });
    expect(rules.privacy).toMatchObject({ visitorCanExport: false, visitorCanDelete: true, visitorMemory: false });
    expect(rules.caps).toEqual({ dailyCents: DEFAULT_PUBLIC_DAILY_SPEND_CAP_CENTS, monthlyCents: 5000 });
    expect(rules.ownSpend).toBe(false);
  });

  it('caps an agent nobody configured', () => {
    const rules = effectiveVisitorRules({ name: 'New agent' });
    expect(rules.authMode).toBe(VisitorAuthMode.PUBLIC_LINK);
    expect(checkChannel({ type: ChannelType.WEB, slug: 'new-agent', branding: {}, rules }).ok).toBe(true);
  });

  it('keeps a limit the owner cleared on purpose cleared', () => {
    const rules = effectiveVisitorRules({ name: 'a', visitorRules: { limits: { costCapCents: null } } });
    expect(rules.limits.costCapCents).toBeNull();
  });

  it("lets a channel override the agent's rules field by field", () => {
    const rules = effectiveVisitorRules(agent, {
      visitorRules: { authMode: VisitorAuthMode.PUBLIC_LINK, limits: { perIpRateLimit: 10 }, privacy: { visitorMemory: true } },
    });
    expect(rules.authMode).toBe(VisitorAuthMode.PUBLIC_LINK);
    expect(rules.limits).toMatchObject({ perUserRateLimit: 30, perIpRateLimit: 10 });
    expect(rules.privacy).toMatchObject({ visitorCanExport: false, visitorMemory: true });
  });

  it('gives a channel a spend allowance of its own only when it sets a spend cap', () => {
    expect(effectiveVisitorRules(agent, { visitorRules: { limits: { perIpRateLimit: 10 } } }).ownSpend).toBe(false);
    const own = effectiveVisitorRules(agent, { visitorRules: { limits: { dailySpendCapCents: 100 } } });
    expect(own.ownSpend).toBe(true);
    expect(own.caps).toEqual({ dailyCents: 100, monthlyCents: 5000 });
  });

  it('keeps the agent allowance on the agent mode, not on a channel override of it', () => {
    const gated = { name: 'a', visitorRules: { authMode: VisitorAuthMode.SSO } };
    // A public channel of an SSO agent that sets no spend cap draws on the
    // agent's allowance, which SSO leaves uncapped by default.
    const rules = effectiveVisitorRules(gated, { visitorRules: { authMode: VisitorAuthMode.PUBLIC_LINK } });
    expect(rules.caps).toEqual({ dailyCents: null, monthlyCents: null });
  });
});

describe('normalizing what is stored', () => {
  it('keeps known branding fields only', () => {
    expect(normalizeBranding({ appName: 'Acme', evil: '<script>' })).toEqual({ appName: 'Acme' });
    expect(normalizeBranding(null)).toBeNull();
    expect(() => normalizeBranding('x')).toThrow();
  });

  it('checks the auth mode and the limits', () => {
    expect(normalizeVisitorRules({ authMode: 'sso', limits: { costCapCents: 12.7, junk: 1 } })).toEqual({
      authMode: 'sso',
      limits: { costCapCents: 12 },
    });
    expect(() => normalizeVisitorRules({ authMode: 'anyone' })).toThrow(/Who can use it/);
    expect(() => normalizeVisitorRules({ limits: { costCapCents: -1 } })).toThrow(/whole numbers/);
    expect(normalizeVisitorRules(null)).toBeNull();
  });
});
