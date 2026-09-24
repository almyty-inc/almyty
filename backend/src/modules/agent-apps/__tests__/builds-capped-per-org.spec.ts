import { HttpException } from '@nestjs/common';

import { AgentApp } from '../../../entities/agent-app.entity';
import { AppBuild, BuildStatus } from '../../../entities/app-build.entity';
import { DistributionTarget } from '../../../entities/agent-app-distribution.entity';
import { AppBuildsService, MAX_ACTIVE_BUILDS_PER_ORG } from '../app-builds.service';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * The build queue is shared by every tenant and runs one job at a time,
 * each allowed up to fifteen minutes per toolchain step. Nothing bounded
 * how many builds one organization could have waiting, so a script (or
 * an impatient double-click loop) could queue hundreds and hold every
 * other tenant's build behind them for days.
 */

const ORG = 'org-1';
const OTHER = 'org-2';

function makeService(seed: any[]) {
  const builds = fakeRepository<any>({ make: () => new AppBuild(), seed });
  const apps = fakeRepository<any>({
    make: () => new AgentApp(),
    seed: [
      { id: 'app-1', organizationId: ORG, slug: 'acme' },
      { id: 'app-2', organizationId: OTHER, slug: 'other' },
    ],
  });
  const queue = { add: jest.fn().mockResolvedValue({ id: 'job' }) };
  const service = new AppBuildsService(
    builds as any,
    apps as any,
    fakeRepository<any>() as any,
    queue as any,
    { canPresign: false } as any,
  );
  (service as any).toolchain = { available: async () => true, run: jest.fn() };
  return { service, builds, queue };
}

const active = (org: string, n: number, status = BuildStatus.QUEUED) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${org}-b${i}`,
    organizationId: org,
    appId: org === ORG ? 'app-1' : 'app-2',
    target: 'tui',
    platform: 'linux-x64',
    status,
    createdAt: new Date(),
  }));

const request = (service: AppBuildsService, org = ORG, slug = 'acme') =>
  service.request(org, slug, { target: DistributionTarget.TUI, platform: 'linux-x64' }, 'u');

describe('AppBuildsService.request - in-flight builds are capped per organization', () => {
  it('refuses a build once the organization has the maximum in flight', async () => {
    const { service, queue } = makeService(active(ORG, MAX_ACTIVE_BUILDS_PER_ORG));

    const error = await request(service).catch((e) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('counts running builds as well as queued ones', async () => {
    const { service } = makeService([
      ...active(ORG, MAX_ACTIVE_BUILDS_PER_ORG - 1),
      { ...active(ORG, 1, BuildStatus.RUNNING)[0], id: 'running' },
    ]);

    await expect(request(service)).rejects.toBeInstanceOf(HttpException);
  });

  it('does not count finished builds or another organization', async () => {
    const { service, queue } = makeService([
      ...active(ORG, 10, BuildStatus.SUCCEEDED).map((b) => ({ ...b, id: `${b.id}-done` })),
      ...active(ORG, 10, BuildStatus.FAILED).map((b) => ({ ...b, id: `${b.id}-failed` })),
      ...active(OTHER, MAX_ACTIVE_BUILDS_PER_ORG),
    ]);

    await expect(request(service)).resolves.toMatchObject({ status: BuildStatus.QUEUED });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
