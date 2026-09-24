import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

import { SsoService } from '../sso.service';
import {
  SAML_REPLAY_SKEW_MS,
  SamlReplayCache,
  assertionReplayFacts,
} from '../saml-replay-cache';
import { FakeRedis } from '../../../../src/test/fake-redis';
import { fakeRepository } from '../../../../src/test/fake-repository';

/**
 * A captured SAML response must not sign anyone in twice.
 *
 * The signature and the timestamps are still checked by node-saml; what is
 * under test is the step after it: the assertion is claimed by (issuer, ID)
 * with one atomic SET NX, before any user is resolved, and a second
 * presentation -- concurrent or later -- is refused.
 */

const NOW = Date.parse('2026-09-24T10:00:00Z');

function assertion(opts: {
  id?: string | null;
  issuer?: string;
  conditionsNotOnOrAfter?: string | null;
  subjectNotOnOrAfter?: string | null;
  email?: string;
}) {
  const email = opts.email ?? 'alice@corp.com';
  const node: any = { $: opts.id === null ? {} : { ID: opts.id ?? '_assert-1' } };
  if (opts.conditionsNotOnOrAfter !== null) {
    node.Conditions = [{ $: { NotOnOrAfter: opts.conditionsNotOnOrAfter ?? '2026-09-24T10:05:00Z' } }];
  }
  if (opts.subjectNotOnOrAfter) {
    node.Subject = [
      { SubjectConfirmation: [{ SubjectConfirmationData: [{ $: { NotOnOrAfter: opts.subjectNotOnOrAfter } }] }] },
    ];
  }
  return {
    issuer: opts.issuer ?? 'https://idp.corp.com',
    nameID: email,
    email,
    getAssertion: () => ({ Assertion: node }),
  } as any;
}

const samlConfig = {
  organizationId: 'org-1',
  protocol: 'saml',
  enabled: true,
  jitProvisioning: false,
  defaultRole: 'member',
  samlEntryPoint: 'https://idp/sso',
  samlIssuer: 'almyty-sp',
  samlCert: 'CERT',
} as any;

function harness(profileFor: (response: string) => any, redis = new FakeRedis(() => NOW)) {
  const users = fakeRepository([{ id: 'u-1', email: 'alice@corp.com' }]);
  const memberships = fakeRepository([
    { id: 'm-1', userId: 'u-1', organizationId: 'org-1', isActive: true, inviteAccepted: true },
  ]);
  const service = new SsoService(
    users as any,
    memberships as any,
    { getDecrypted: jest.fn(async () => samlConfig) } as any,
    new SamlReplayCache(redis),
  );
  // Stands in for node-saml's signature + timestamp validation, which
  // passes for a captured response exactly as it did the first time.
  jest.spyOn(service, 'buildSaml').mockReturnValue({
    validatePostResponseAsync: jest.fn(async ({ SAMLResponse }: any) => ({
      profile: profileFor(SAMLResponse),
      loggedOut: false,
    })),
  } as any);
  const resolveUser = jest.spyOn(service, 'resolveUser');
  return { service, redis, resolveUser };
}

describe('SAML replay protection', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it('of two concurrent posts of the same response, exactly one signs in', async () => {
    const { service, resolveUser } = harness(() => assertion({}));

    const results = await Promise.allSettled([
      service.handleSamlCallback('org-1', 'CAPTURED', 'https://api'),
      service.handleSamlCallback('org-1', 'CAPTURED', 'https://api'),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(UnauthorizedException);
    expect(lost[0].reason.message).toMatch(/already been used/);
    // The loser never got as far as looking anyone up.
    expect(resolveUser).toHaveBeenCalledTimes(1);
  });

  it('refuses the same response presented again later', async () => {
    const { service } = harness(() => assertion({}));
    await expect(service.handleSamlCallback('org-1', 'R', 'https://api')).resolves.toMatchObject({ id: 'u-1' });
    await expect(service.handleSamlCallback('org-1', 'R', 'https://api')).rejects.toThrow(/already been used/);
  });

  it('accepts distinct assertions from the same IdP', async () => {
    const { service } = harness((r) => assertion({ id: `_assert-${r}` }));
    await expect(service.handleSamlCallback('org-1', 'one', 'https://api')).resolves.toBeTruthy();
    await expect(service.handleSamlCallback('org-1', 'two', 'https://api')).resolves.toBeTruthy();
  });

  it('keys on the issuer too, so one IdP cannot burn another IdP assertion ID', async () => {
    const { service } = harness((r) => assertion({ issuer: `https://${r}.example` }));
    await expect(service.handleSamlCallback('org-1', 'idp-a', 'https://api')).resolves.toBeTruthy();
    await expect(service.handleSamlCallback('org-1', 'idp-b', 'https://api')).resolves.toBeTruthy();
  });

  it('remembers the assertion until its latest NotOnOrAfter plus skew', async () => {
    const { service, redis } = harness(() =>
      assertion({ conditionsNotOnOrAfter: '2026-09-24T10:05:00Z', subjectNotOnOrAfter: '2026-09-24T10:10:00Z' }),
    );
    await service.handleSamlCallback('org-1', 'R', 'https://api');
    const [key] = redis.keys();
    expect(redis.pttlNow(key)).toBe(10 * 60 * 1000 + SAML_REPLAY_SKEW_MS);
  });

  it('refuses an assertion with no ID, and never resolves a user for it', async () => {
    const { service, resolveUser } = harness(() => assertion({ id: null }));
    await expect(service.handleSamlCallback('org-1', 'R', 'https://api')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it('refuses an assertion with no expiry, which could never safely be forgotten', async () => {
    const { service, resolveUser } = harness(() => assertion({ conditionsNotOnOrAfter: null }));
    await expect(service.handleSamlCallback('org-1', 'R', 'https://api')).rejects.toThrow(/no expiry/);
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it('fails closed when the claim cannot be recorded', async () => {
    const broken = new FakeRedis(() => NOW);
    jest.spyOn(broken, 'set').mockRejectedValue(new Error('ECONNREFUSED'));
    const { service, resolveUser } = harness(() => assertion({}), broken);
    await expect(service.handleSamlCallback('org-1', 'R', 'https://api')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it('uses the assertion ID, not a Response-level ID a replayer could re-wrap', () => {
    const profile = assertion({ id: '_inner' });
    profile.ID = '_outer-response';
    expect(assertionReplayFacts(profile).assertionId).toBe('_inner');
  });
});

describe('SamlReplayCache is what the SSO module wires', () => {
  const read = (name: string) => readFileSync(join(__dirname, '..', name), 'utf8');

  it('is a provider of SsoModule', () => {
    expect(read('sso.module.ts')).toMatch(/providers:\s*\[[^\]]*\bSamlReplayCache\b/);
  });

  it('is consumed on the SAML callback path before the user is resolved', () => {
    const src = read('sso.service.ts');
    const body = src.slice(src.indexOf('async handleSamlCallback('), src.indexOf('private profileFromSaml('));
    const consume = body.indexOf('this.samlReplay.consume(');
    expect(consume).toBeGreaterThan(-1);
    expect(consume).toBeLessThan(body.indexOf('this.resolveUser('));
  });
});
