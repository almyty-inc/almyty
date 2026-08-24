import {
  CUSTOM_DOMAIN_REFUSALS,
  VERIFICATION_VALUE_PREFIX,
  customDomainError,
  isReservedDomain,
  isVerified,
  newCustomDomain,
  newVerificationToken,
  resourceNameFor,
  verificationRecord,
} from '../custom-domain';

describe('customDomainError', () => {
  it('accepts a normal hostname', () => {
    expect(customDomainError('chat.acme.com')).toBeNull();
    expect(customDomainError('CHAT.ACME.COM')).toBeNull();
    expect(customDomainError('acme.co.uk')).toBeNull();
  });

  it('asks for a hostname rather than a URL', () => {
    expect(customDomainError('https://chat.acme.com')).toMatch(/hostname only/);
    expect(customDomainError('chat.acme.com/path')).toMatch(/hostname only/);
  });

  it('refuses a wildcard', () => {
    // A wildcard here would mean issuing a wildcard cert for someone
    // else's zone.
    expect(customDomainError('*.acme.com')).toMatch(/Wildcard/);
  });

  it('refuses a bare single label', () => {
    expect(customDomainError('localhost')).toMatch(/full domain/);
  });

  it('refuses malformed labels', () => {
    expect(customDomainError('-chat.acme.com')).toMatch(/start or end with a hyphen/);
    expect(customDomainError('chat-.acme.com')).toMatch(/start or end with a hyphen/);
    expect(customDomainError('chat..acme.com')).toMatch(/1 to 63/);
    expect(customDomainError(`${'a'.repeat(64)}.acme.com`)).toMatch(/1 to 63/);
  });

  it('refuses an empty value and a trailing dot', () => {
    expect(customDomainError('')).toMatch(/Enter the domain/);
    expect(customDomainError('chat.acme.com.')).toMatch(/trailing dot/);
  });
});

describe('isReservedDomain', () => {
  it('refuses the base domain and anything under it', () => {
    // Those are Tier 1 subdomains, not customer domains.
    expect(isReservedDomain('almyty.app', 'almyty.app')).toBe(true);
    expect(isReservedDomain('acme.almyty.app', 'almyty.app')).toBe(true);
  });

  it('refuses our own organisation domain', () => {
    expect(isReservedDomain('almyty.com', 'almyty.app')).toBe(true);
    expect(isReservedDomain('app.almyty.com', 'almyty.app')).toBe(true);
  });

  it('allows a genuine customer domain', () => {
    expect(isReservedDomain('chat.acme.com', 'almyty.app')).toBe(false);
    expect(isReservedDomain('acme.com', 'almyty.app')).toBe(false);
  });
});

describe('verification', () => {
  const domain = newCustomDomain('chat.acme.com');

  it('starts unverified with a fresh token', () => {
    expect(domain.status).toBe('pending_verification');
    expect(domain.verifiedAt).toBeNull();
    expect(domain.verificationToken).toMatch(/^[0-9a-f]{48}$/);
  });

  it('mints a different token every time', () => {
    expect(newVerificationToken()).not.toBe(newVerificationToken());
  });

  it('publishes a self-describing TXT record', () => {
    const record = verificationRecord(domain);
    expect(record.type).toBe('TXT');
    expect(record.name).toBe('_almyty-verify.chat.acme.com');
    expect(record.value).toBe(`${VERIFICATION_VALUE_PREFIX}${domain.verificationToken}`);
  });

  it('verifies on an exact match', () => {
    expect(isVerified([`${VERIFICATION_VALUE_PREFIX}${domain.verificationToken}`], domain)).toBe(
      true,
    );
  });

  it('tolerates the quoting resolvers add', () => {
    expect(
      isVerified([`"${VERIFICATION_VALUE_PREFIX}${domain.verificationToken}"`], domain),
    ).toBe(true);
  });

  it('finds the record among the other TXT records a zone carries', () => {
    const records = [
      'v=spf1 include:_spf.google.com ~all',
      `${VERIFICATION_VALUE_PREFIX}${domain.verificationToken}`,
    ]
    expect(isVerified(records, domain)).toBe(true);
  });

  it('rejects a token that merely contains ours', () => {
    // A substring test would accept this and hand someone a
    // certificate for a domain they do not control.
    expect(
      isVerified([`${VERIFICATION_VALUE_PREFIX}${domain.verificationToken}extra`], domain),
    ).toBe(false);
  });

  it('rejects another domain token, an empty list and nothing at all', () => {
    expect(isVerified([`${VERIFICATION_VALUE_PREFIX}${newVerificationToken()}`], domain)).toBe(
      false,
    );
    expect(isVerified([], domain)).toBe(false);
    expect(isVerified(null, domain)).toBe(false);
    expect(isVerified(undefined, domain)).toBe(false);
  });
});

describe('resourceNameFor', () => {
  it('produces a DNS-safe name', () => {
    expect(resourceNameFor('chat.acme.com')).toMatch(/^chat-[a-z0-9-]+-[0-9a-f]{10}$/);
  });

  it('is stable for the same hostname', () => {
    expect(resourceNameFor('chat.acme.com')).toBe(resourceNameFor('CHAT.acme.com '));
  });

  it('never collides two hostnames that sanitise the same', () => {
    // chat-acme.com and chat.acme.com both sanitise to chat-acme-com;
    // the hash is what keeps their certificates apart.
    expect(resourceNameFor('chat-acme.com')).not.toBe(resourceNameFor('chat.acme.com'));
  });

  it('stays within a Kubernetes name length for a long hostname', () => {
    expect(resourceNameFor(`${'sub.'.repeat(20)}acme.com`).length).toBeLessThanOrEqual(63);
  });
});

describe('refusal codes', () => {
  it('pairs every code with a sentence a person can act on', () => {
    for (const [code, message] of Object.entries(CUSTOM_DOMAIN_REFUSALS)) {
      expect(message.length).toBeGreaterThan(20);
      expect(code).toMatch(/^[A-Z_]+$/);
    }
  });
});
