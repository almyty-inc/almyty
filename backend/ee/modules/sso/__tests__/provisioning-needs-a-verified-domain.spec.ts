import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { OrgDomain } from '../../../../src/entities/org-domain.entity';
import { OrganizationRole } from '../../../../src/entities/user-organization.entity';
import { fakeRepository, FakeRepository } from '../../../../src/test/fake-repository';
import { FakeRedis } from '../../../../src/test/fake-redis';
import { OrgDomainService } from '../org-domain.service';
import { SsoService } from '../sso.service';
import { ScimService } from '../scim.service';
import { SamlReplayCache } from '../saml-replay-cache';

/**
 * SSO creates an account only for an address on a domain the organization
 * has proven it controls with a DNS TXT record.
 *
 * The org owner configures the IdP, and an IdP can assert any address. JIT
 * (and SCIM) used to create a user for whatever it asserted, so an owner
 * could mint an account for someone else's mailbox, which their IdP then
 * signs into, and which the address's real owner can no longer register.
 */
describe('SSO provisioning needs a verified domain', () => {
  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';
  const TOKEN = 'a'.repeat(48);
  const RECORD = `almyty-domain-verification=${TOKEN}`;

  let domains: FakeRepository<OrgDomain>;
  let txt: Record<string, string[][] | Error>;
  let service: OrgDomainService;

  const domainRow = (over: Partial<OrgDomain> = {}) => ({
    id: 'd-1',
    organizationId: ORG,
    domain: 'acme.test',
    verificationToken: TOKEN,
    status: 'pending' as const,
    verifiedAt: null,
    lastCheckedAt: null,
    lastError: null,
    createdAt: new Date(),
    ...over,
  });

  function build(rows: any[] = []) {
    domains = fakeRepository<OrgDomain>({ seed: rows, idPrefix: 'd' });
    txt = {};
    const resolveTxt = async (name: string) => {
      const answer = txt[name];
      if (!answer) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      if (answer instanceof Error) throw answer;
      return answer;
    };
    service = new OrgDomainService(domains as any, resolveTxt);
  }

  describe('verifying a domain', () => {
    it('gives the TXT record to publish, and verifies once it resolves', async () => {
      build();
      const added = await service.add(ORG, ' Acme.TEST ');
      expect(added).toMatchObject({ domain: 'acme.test', status: 'pending' });
      expect(added.record.name).toBe('_almyty-verify.acme.test');
      expect(added.record.value).toMatch(/^almyty-domain-verification=[0-9a-f]{48}$/);

      const stored = domains.rows()[0];
      expect(await service.verify(ORG, stored.id)).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/No TXT record/) });

      txt['_almyty-verify.acme.test'] = [[added.record.value]];
      expect(await service.verify(ORG, stored.id)).toMatchObject({ status: 'verified', lastError: null });
      expect(domains.row(stored.id)!.status).toBe('verified');
    });

    it('does not verify on a record that does not match', async () => {
      build([domainRow()]);
      txt['_almyty-verify.acme.test'] = [['almyty-domain-verification=someone-else']];
      expect(await service.verify(ORG, 'd-1')).toMatchObject({ status: 'failed' });
    });

    it('leaves the status alone when DNS could not be read', async () => {
      build([domainRow({ status: 'verified', verifiedAt: new Date() })]);
      txt['_almyty-verify.acme.test'] = Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      expect(await service.verify(ORG, 'd-1')).toMatchObject({ status: 'verified' });
    });

    it("will not verify another organization's domain row", async () => {
      build([domainRow({ organizationId: OTHER_ORG })]);
      txt['_almyty-verify.acme.test'] = [[RECORD]];
      await expect(service.verify(ORG, 'd-1')).rejects.toThrow('Domain not found');
    });

    it('refuses a domain another organization has already verified', async () => {
      build([domainRow()]);
      txt['_almyty-verify.acme.test'] = [[RECORD]];
      // The partial unique index on verified domains, as Postgres raises it.
      domains.update.mockImplementationOnce(async () => {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      });
      await expect(service.verify(ORG, 'd-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('covers the domain and its subdomains, verified only', async () => {
      build([
        domainRow({ status: 'verified' }),
        domainRow({ id: 'd-2', domain: 'pending.test' }),
        domainRow({ id: 'd-3', organizationId: OTHER_ORG, domain: 'other.test', status: 'verified' }),
      ]);
      expect(await service.coversEmail(ORG, 'ada@acme.test')).toBe(true);
      expect(await service.coversEmail(ORG, 'ada@eng.acme.test')).toBe(true);
      expect(await service.coversEmail(ORG, 'ada@evilacme.test')).toBe(false);
      expect(await service.coversEmail(ORG, 'ada@acme.test.evil.test')).toBe(false);
      expect(await service.coversEmail(ORG, 'ada@pending.test')).toBe(false);
      expect(await service.coversEmail(ORG, 'ada@other.test')).toBe(false);
      expect(await service.coversEmail(ORG, 'not-an-address')).toBe(false);
    });
  });

  describe('JIT provisioning', () => {
    const JIT_ON = { enabled: true, protocol: 'saml', jitProvisioning: true, defaultRole: OrganizationRole.MEMBER } as any;

    function sso() {
      const users = fakeRepository<any>({ idPrefix: 'u' });
      const memberships = fakeRepository<any>({ idPrefix: 'm' });
      const svc = new SsoService(
        users as any,
        memberships as any,
        {} as any,
        new SamlReplayCache(new FakeRedis()),
        undefined,
        undefined,
        service,
      );
      return { svc, users, memberships };
    }

    it('creates no account for an address outside the verified domains', async () => {
      build([domainRow({ status: 'verified' })]);
      const { svc, users, memberships } = sso();

      await expect(svc.resolveUser(ORG, { email: 'victim@gmail.test' }, JIT_ON)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(users.rows()).toEqual([]);
      expect(memberships.rows()).toEqual([]);
    });

    it('creates no account on a domain that is only pending', async () => {
      build([domainRow()]);
      const { svc, users } = sso();

      await expect(svc.resolveUser(ORG, { email: 'ada@acme.test' }, JIT_ON)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(users.rows()).toEqual([]);
    });

    it('creates the account and membership on a verified domain', async () => {
      build([domainRow({ status: 'verified' })]);
      const { svc, users, memberships } = sso();

      const user = await svc.resolveUser(ORG, { email: 'Ada@Acme.test' }, JIT_ON);

      expect(user.email).toBe('ada@acme.test');
      expect(users.rows()).toHaveLength(1);
      expect(memberships.rows()[0]).toMatchObject({ organizationId: ORG, role: OrganizationRole.MEMBER });
    });
  });

  describe('SCIM', () => {
    function scim() {
      const users = fakeRepository<any>({ idPrefix: 'u' });
      const memberships = fakeRepository<any>({ idPrefix: 'm' });
      const svc = new ScimService(
        users as any,
        memberships as any,
        fakeRepository<any>() as any,
        fakeRepository<any>() as any,
        { get: async () => ({ defaultRole: 'member' }) } as any,
        undefined,
        undefined,
        service,
      );
      return { svc, users };
    }

    it('creates no account outside the verified domains', async () => {
      build([domainRow({ status: 'verified' })]);
      const { svc, users } = scim();

      await expect(svc.createUser(ORG, { userName: 'victim@gmail.test' } as any)).rejects.toBeInstanceOf(ForbiddenException);
      expect(users.rows()).toEqual([]);
    });

    it('creates the account on a verified domain', async () => {
      build([domainRow({ status: 'verified' })]);
      const { svc, users } = scim();

      await svc.createUser(ORG, { userName: 'ada@acme.test' } as any);
      expect(users.rows().map((u) => u.email)).toEqual(['ada@acme.test']);
    });
  });
});
