import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';

import { AuthService, PERSONAL_KEY_PREFIX_LENGTH } from '../auth.service';
import { CaptchaService } from '../captcha.service';
import { ApiKey } from '../../../entities/api-key.entity';
import { Organization } from '../../../entities/organization.entity';
import { User } from '../../../entities/user.entity';
import { AuthSessionService } from '../auth-session.service';
import { UserOrganization } from '../../../entities/user-organization.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { MailService } from '../../mail/mail.service';
import { ReferralsService } from '../../referrals/referrals.service';
import { fakeRepository, FakeRepository } from '../../../test/fake-repository';

/**
 * Settings > API keys lists and revokes the caller's PERSONAL keys: the
 * ones minted by POST /auth/api-keys (and the CLI login). The api_keys
 * table also holds gateway keys, agent keys and the organization's
 * `almyty_sk_` access keys, all with a userId; those are managed on the
 * gateway's or agent's page and must not show up, or be revocable, here.
 * A revoked key is gone from the list.
 */
describe('personal API keys (Settings > API keys)', () => {
  const ME = 'user-me';
  const SOMEONE = 'user-other';

  let service: AuthService;
  let apiKeys: FakeRepository<any>;

  const key = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: id,
    userId: ME,
    organizationId: 'org-1',
    keyPrefix: 'almyty_ab12c',
    gatewayId: null,
    agentId: null,
    scopes: null,
    isActive: true,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  });

  async function build(seed: any[]): Promise<void> {
    apiKeys = fakeRepository<any>({ seed, idPrefix: 'key' });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: fakeRepository<any>({ seed: [{ id: ME }] }) },
        { provide: getRepositoryToken(ApiKey), useValue: apiKeys },
        { provide: getRepositoryToken(Organization), useValue: fakeRepository<any>() },
        { provide: getRepositoryToken(UserOrganization), useValue: fakeRepository<any>() },
        { provide: JwtService, useValue: { sign: jest.fn(), verify: jest.fn() } },
        {
          provide: AuditLogService,
          useValue: { log: jest.fn(), logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn() },
        },
        { provide: MailService, useValue: { send: jest.fn() } },
        { provide: ReferralsService, useValue: { attributeSignup: jest.fn() } },
        { provide: AuthSessionService, useValue: { start: jest.fn() } },
        { provide: CaptchaService, useValue: { isEnabled: jest.fn().mockReturnValue(false), verify: jest.fn() } },
      ],
    }).compile();
    service = module.get(AuthService);
  }

  it('lists only my own active personal keys', async () => {
    await build([
      key('mine'),
      key('revoked', { isActive: false }),
      key('gateway', { gatewayId: 'gw-1' }),
      key('agent', { agentId: 'agent-1' }),
      key('org-access', { keyPrefix: 'almyty_sk_1234abcd' }),
      key('theirs', { userId: SOMEONE }),
    ]);

    const listed = await service.getUserApiKeys(ME);

    expect(listed.map((k) => k.id)).toEqual(['mine']);
  });

  it('revokes a personal key, and it leaves the list', async () => {
    await build([key('mine')]);

    await service.revokeApiKey('mine', ME);

    expect(apiKeys.row('mine').isActive).toBe(false);
    expect(await service.getUserApiKeys(ME)).toEqual([]);
  });

  it.each([
    ['a gateway key', { gatewayId: 'gw-1' }],
    ['an agent key', { agentId: 'agent-1' }],
    ['an organization access key', { keyPrefix: 'almyty_sk_1234abcd' }],
  ])('will not revoke %s from here, and leaves it working', async (_label, overrides) => {
    await build([key('other-kind', overrides)]);

    await expect(service.revokeApiKey('other-kind', ME)).rejects.toThrow(BadRequestException);

    expect(apiKeys.row('other-kind').isActive).toBe(true);
  });

  it('keeps enough of a new key in the clear to tell keys apart, and never the whole key', async () => {
    await build([]);

    const { apiKey, keyData } = await service.createApiKey(ME, { name: 'laptop' } as any);

    expect(PERSONAL_KEY_PREFIX_LENGTH).toBeGreaterThan('almyty_'.length + 3);
    expect(keyData.keyPrefix).toBe(apiKey.slice(0, PERSONAL_KEY_PREFIX_LENGTH));
    expect(keyData.keyPrefix.length).toBeLessThan(apiKey.length);
    expect(apiKeys.row(keyData.id).keyHash).not.toContain(apiKey);
  });
});
