import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { EnvironmentsService, SHARED_ENVIRONMENTS_NOT_INCLUDED } from '../environments.service';
import { DEFAULT_HOSTED_RUNNER_SETTINGS, HostedRunnerSettingsService } from '../hosted-runner-settings';
import { EE_ENTITLEMENTS } from '../../licensing/license.constants';

/**
 * Pro keeps environments private; sharing one with a team or the whole
 * organization is Business (`hosted_shared_environments`, Frane's decision
 * 4). The gate sits on the visibility write and nowhere else: making a
 * private environment, editing an already-shared one, or narrowing one
 * never asks the plan.
 */
describe('environment visibility is plan-gated on the write', () => {
  const ORG = 'org-1';
  const USER = 'user-1';
  let licensed: boolean;
  let licenses: { hasForOrg: jest.Mock };
  let rows: Map<string, any>;
  let service: EnvironmentsService;
  let publisher: { publishEnvironment: jest.Mock; unpublishEnvironment: jest.Mock };

  const settings = new HostedRunnerSettingsService(DEFAULT_HOSTED_RUNNER_SETTINGS, { HOSTED_RUNNERS_ENABLED: 'true' });

  beforeEach(() => {
    licensed = false;
    rows = new Map();
    licenses = { hasForOrg: jest.fn(async (_org: string, key: string) => key === EE_ENTITLEMENTS.HOSTED_SHARED_ENVIRONMENTS && licensed) };
    const environments: any = {
      create: (x: any) => ({ ...x }),
      save: jest.fn(async (x: any) => {
        const row = { id: x.id ?? `env-${rows.size + 1}`, createdAt: new Date(), updatedAt: new Date(), deletedAt: null, ...x };
        rows.set(row.id, row);
        return { ...row };
      }),
      findOne: jest.fn(async ({ where }: any) => {
        const row = rows.get(where.id);
        return row && row.organizationId === where.organizationId ? { ...row } : null;
      }),
      delete: jest.fn(),
    };
    const accessPolicy: any = {
      assertCanScopeToTeam: jest.fn(async () => undefined),
      canAccess: jest.fn(async () => ({ allowed: true, reason: 'ok' })),
    };
    const hosted: any = {
      refuseWhenDisabled: () => undefined,
      capacityFor: async () => ({ maxConcurrentRunners: 2, maxWorkspaces: 10, resourceClasses: null }),
    };
    publisher = { publishEnvironment: jest.fn(async () => []), unpublishEnvironment: jest.fn(async () => 0) };
    service = new EnvironmentsService(environments, {} as any, accessPolicy, settings, hosted, publisher as any, licenses as any);
  });

  const create = (visibility?: 'private' | 'team' | 'org', teamId?: string) =>
    service.create({ name: 'app', image: { base: 'standard' }, ...(visibility ? { visibility } : {}), ...(teamId ? { teamId } : {}) } as any, USER, ORG);

  it('makes a private environment by default, without asking the plan', async () => {
    const env = await create();
    expect(env.visibility).toBe('private');
    expect(licenses.hasForOrg).not.toHaveBeenCalled();
    expect(publisher.publishEnvironment).toHaveBeenCalledWith(expect.objectContaining({ id: env.id, visibility: 'private' }));
  });

  it.each(['org', 'team'] as const)('refuses %s visibility without the Business entitlement, and allows it with', async (visibility) => {
    const err = await create(visibility, visibility === 'team' ? 'team-1' : undefined).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ code: 'ENTITLEMENT_REQUIRED', entitlement: 'hosted_shared_environments', message: SHARED_ENVIRONMENTS_NOT_INCLUDED });
    expect(rows.size).toBe(0);

    licensed = true;
    const env = await create(visibility, visibility === 'team' ? 'team-1' : undefined);
    expect(env.visibility).toBe(visibility);
  });

  it('gates widening on update, but not other edits of a shared environment after a downgrade, nor narrowing', async () => {
    const env = await create();
    await expect(service.update(env.id, { visibility: 'org' } as any, USER, ORG)).rejects.toBeInstanceOf(ForbiddenException);

    licensed = true;
    const shared = await service.update(env.id, { visibility: 'org' } as any, USER, ORG);
    expect(shared.visibility).toBe('org');

    // The plan lapses: what is shared stays editable, and may be narrowed.
    licensed = false;
    licenses.hasForOrg.mockClear();
    const edited = await service.update(env.id, { description: 'still shared' } as any, USER, ORG);
    expect(edited.visibility).toBe('org');
    const same = await service.update(env.id, { visibility: 'org' } as any, USER, ORG);
    expect(same.visibility).toBe('org');
    expect(licenses.hasForOrg).not.toHaveBeenCalled();
    const narrowed = await service.update(env.id, { visibility: 'private' } as any, USER, ORG);
    expect(narrowed.visibility).toBe('private');
  });

  it('takes the idle timeout bounds, image list and sizes from the settings', async () => {
    await expect(service.create({ name: 'a', image: { base: 'standard' }, idleTimeoutMinutes: 4 } as any, USER, ORG)).rejects.toThrow(/between 5 and 120/);
    await expect(service.create({ name: 'b', image: { base: 'standard' }, idleTimeoutMinutes: 121 } as any, USER, ORG)).rejects.toThrow(/between 5 and 120/);
    await expect(service.create({ name: 'c', image: { base: 'my-own-image' } } as any, USER, ORG)).rejects.toThrow(/image\.base must be one of: standard, standard-browser/);
    await expect(service.create({ name: 'd', image: { base: 'standard' }, resourceClass: 'xxl' } as any, USER, ORG)).rejects.toThrow(/small, medium, large/);
    const env = await service.create({ name: 'e', image: { base: 'standard' } } as any, USER, ORG);
    expect(env).toMatchObject({ idleTimeoutMinutes: 15, resourceClass: 'small', image: { base: 'standard', ref: DEFAULT_HOSTED_RUNNER_SETTINGS.images.standard }, version: 1 });
  });

  it('refuses egress hosts the network policy could not hold exactly', async () => {
    const err = await service
      .create({ name: 'a', image: { base: 'standard' }, egress: { allowHosts: ['github.com', '*.npmjs.org', '10.0.0.1'] } } as any, USER, ORG)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'EGRESS_HOST_INVALID' });
    expect(err.getResponse().message).toContain('*.npmjs.org, 10.0.0.1');
  });

  it('refuses the organization\'s own cluster until it is offered', async () => {
    await expect(
      service.create({ name: 'a', image: { base: 'standard' }, clusterConnectionId: '6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b' } as any, USER, ORG),
    ).rejects.toThrow(/not offered yet/);
  });

  it('bumps the version on a change a pod would run differently with, not on a description', async () => {
    const env = await create();
    expect((await service.update(env.id, { description: 'x' } as any, USER, ORG)).version).toBe(1);
    expect((await service.update(env.id, { setupScript: 'npm ci' } as any, USER, ORG)).version).toBe(2);
    expect((await service.update(env.id, { egress: { allowHosts: ['github.com'] } } as any, USER, ORG)).version).toBe(3);
  });
});
