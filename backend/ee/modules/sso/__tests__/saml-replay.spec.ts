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
 * with one atomic SET NX, before the identity is used, and a second
 * presentation -- concurrent or later -- is refused.
 */

const NOW = Date.parse('2026-09-24T10:00:00Z');
const ACS = 'https://api/sso/org-1/saml/callback';
const REQUEST_ID = '_req-1';

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
  node.Subject = [
    {
      SubjectConfirmation: [
        {
          SubjectConfirmationData: [
            { $: { Recipient: ACS, ...(opts.subjectNotOnOrAfter ? { NotOnOrAfter: opts.subjectNotOnOrAfter } : {}) } },
          ],
        },
      ],
    },
  ];
  return {
    issuer: opts.issuer ?? 'https://idp.corp.com',
    nameID: email,
    email,
    inResponseTo: REQUEST_ID,
    getAssertion: () => ({ Assertion: node }),
    getSamlResponseXml: () =>
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" Destination="${ACS}" InResponseTo="${REQUEST_ID}"/>`,
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
  // How far a response got: the identity is read only after the claim.
  const resolveUser = jest.spyOn(service as any, 'profileFromSaml');
  const login = (response: string) => service.resolveSamlLogin('org-1', response, ACS, REQUEST_ID);
  return { service, redis, resolveUser, login };
}

describe('SAML replay protection', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it('of two concurrent posts of the same response, exactly one signs in', async () => {
    const { login, resolveUser } = harness(() => assertion({}));

    const results = await Promise.allSettled([
      login('CAPTURED'),
      login('CAPTURED'),
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
    const { login } = harness(() => assertion({}));
    await expect(login('R')).resolves.toMatchObject({ email: 'alice@corp.com' });
    await expect(login('R')).rejects.toThrow(/already been used/);
  });

  it('accepts distinct assertions from the same IdP', async () => {
    const { login } = harness((r) => assertion({ id: `_assert-${r}` }));
    await expect(login('one')).resolves.toBeTruthy();
    await expect(login('two')).resolves.toBeTruthy();
  });

  it('keys on the issuer too, so one IdP cannot burn another IdP assertion ID', async () => {
    const { login } = harness((r) => assertion({ issuer: `https://${r}.example` }));
    await expect(login('idp-a')).resolves.toBeTruthy();
    await expect(login('idp-b')).resolves.toBeTruthy();
  });

  it('remembers the assertion until its latest NotOnOrAfter plus skew', async () => {
    const { login, redis } = harness(() =>
      assertion({ conditionsNotOnOrAfter: '2026-09-24T10:05:00Z', subjectNotOnOrAfter: '2026-09-24T10:10:00Z' }),
    );
    await login('R');
    const [key] = redis.keys();
    expect(redis.pttlNow(key)).toBe(10 * 60 * 1000 + SAML_REPLAY_SKEW_MS);
  });

  it('refuses an assertion with no ID, and never resolves a user for it', async () => {
    const { login, resolveUser } = harness(() => assertion({ id: null }));
    await expect(login('R')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it('refuses an assertion with no expiry, which could never safely be forgotten', async () => {
    const { login, resolveUser } = harness(() => assertion({ conditionsNotOnOrAfter: null }));
    await expect(login('R')).rejects.toThrow(/no expiry/);
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it('fails closed when the claim cannot be recorded', async () => {
    const broken = new FakeRedis(() => NOW);
    jest.spyOn(broken, 'set').mockRejectedValue(new Error('ECONNREFUSED'));
    const { login, resolveUser } = harness(() => assertion({}), broken);
    await expect(login('R')).rejects.toBeInstanceOf(
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

  it('is consumed in the one validator every SAML path goes through, before it returns the identity', () => {
    const src = read('sso.service.ts');
    const body = src.slice(src.indexOf('private async validateSolicitedSamlResponse('), src.indexOf('async resolveSamlLogin('));
    const consume = body.indexOf('this.samlReplay.consume(');
    expect(consume).toBeGreaterThan(-1);
    expect(consume).toBeLessThan(body.indexOf('return { profile, facts }'));
    for (const path of ['async resolveSamlLogin(', 'async resolveHostedChatSamlVisitor(']) {
      const start = src.indexOf(path);
      expect(src.slice(start, start + 600)).toMatch(/this\.validateSolicitedSamlResponse\(/);
    }
  });
});