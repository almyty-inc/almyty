import { AppBuildsService } from '../app-builds.service';
import { BuildStatus } from '../../../entities/app-build.entity';
import { DistributionTarget } from '../../../entities/agent-app-distribution.entity';

/**
 * A build row must not outlive its job.
 *
 * The row has to exist before the job, because the job is addressed by
 * its id — so an enqueue that throws used to leave the row QUEUED with
 * nothing to run it and nothing to reap it: the artifact sweep only
 * touches SUCCEEDED builds. The app then showed a build waiting
 * forever. `attempts: 1` on the queue is deliberate (a failed build is
 * rarely fixed by re-running it) and stays.
 */
describe('AppBuildsService.request - the row never outlives the job', () => {
  const build = () => ({ id: 'build-1', status: BuildStatus.QUEUED, error: null, finishedAt: null });

  const makeService = (add: jest.Mock) => {
    const saved: any[] = [];
    const buildRepository = {
      create: jest.fn((dto: any) => ({ ...build(), ...dto })),
      save: jest.fn(async (row: any) => {
        saved.push({ ...row });
        return row;
      }),
      findOne: jest.fn().mockResolvedValue(null),
      // No other builds in flight for this organization.
      count: jest.fn().mockResolvedValue(0),
    };
    const service = new AppBuildsService(
      buildRepository as any,
      { findOne: jest.fn().mockResolvedValue({ id: 'app-1', slug: 'acme-support', organizationId: 'org-1' }) } as any,
      { findOne: jest.fn().mockResolvedValue(null) } as any,
      { add } as any,
      { canPresign: false } as any,
    );
    // The service builds its own ProcessToolchainRunner, which shells out to
    // the real host looking for bun. These tests are about whether the build
    // ROW outlives its job, not about the machine they run on -- and probing
    // the host made them pass on a developer laptop with bun installed and
    // fail in CI without it. Stub the probe so the test asserts what it
    // claims to.
    (service as any).toolchain = {
      available: async () => true,
      version: async () => ({ ok: true, version: '1.2.0' }),
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    };
    return { service, buildRepository, saved };
  };

  const request = (service: AppBuildsService) =>
    service.request(
      'org-1',
      'acme-support',
      { target: DistributionTarget.TUI, platform: 'linux-x64' } as any,
      'user-1',
    );

  it('leaves a queued row behind when the job is accepted', async () => {
    const add = jest.fn().mockResolvedValue({ id: 'job-1' });
    const { service, saved } = makeService(add);

    const row = await request(service);

    expect(add).toHaveBeenCalled();
    expect(add.mock.calls[0][1]).toMatchObject({ attempts: 1 });
    expect(row.status).toBe(BuildStatus.QUEUED);
    expect(saved).toHaveLength(1);
  });

  it('fails the row, and still reports the error, when the job cannot be enqueued', async () => {
    const add = jest.fn().mockRejectedValue(new Error('queue unavailable'));
    const { service, saved } = makeService(add);

    await expect(request(service)).rejects.toThrow('queue unavailable');

    const last = saved[saved.length - 1];
    expect(last.status).toBe(BuildStatus.FAILED);
    expect(last.error).toMatch(/could not be queued/i);
    expect(last.finishedAt).toBeInstanceOf(Date);
  });
});
