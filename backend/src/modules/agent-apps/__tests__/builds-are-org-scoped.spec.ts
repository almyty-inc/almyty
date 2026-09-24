import { NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';

import { AgentApp } from '../../../entities/agent-app.entity';
import { AppBuild, BuildStatus } from '../../../entities/app-build.entity';
import { AppBuildsService } from '../app-builds.service';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * A build, and the signed binary and presigned URL behind it, belongs to
 * one organization. The download and signing specs stub the build lookup
 * as `findOne: jest.fn().mockResolvedValue(build)`, which answers whatever
 * the `where` says, so nothing there proved the organization predicate.
 * Here the tables are real.
 */

const OWNER = 'org-1';
const OUTSIDER = 'org-2';

function makeService(opts: { canPresign: boolean }) {
  const builds = fakeRepository<any>({
    make: () => new AppBuild(),
    seed: [
      {
        id: 'build-1',
        organizationId: OWNER,
        appId: 'app-1',
        target: 'tui',
        platform: 'linux-x64',
        status: BuildStatus.SUCCEEDED,
        version: '1.2.0',
        artifactKey: `app-builds/${OWNER}/app-1/build-1.AppImage`,
        artifactBytes: '1024',
        artifactExpiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
      },
    ],
  });
  const apps = fakeRepository<any>({
    make: () => new AgentApp(),
    seed: [{ id: 'app-1', organizationId: OWNER, slug: 'acme-support' }],
  });
  const storage = {
    canPresign: opts.canPresign,
    getSignedUrl: jest.fn().mockResolvedValue('https://cdn.example/object?sig=abc'),
    downloadStream: jest.fn(async () => Readable.from([Buffer.from('binary')])),
  };
  const service = new AppBuildsService(
    builds as any,
    apps as any,
    fakeRepository<any>() as any,
    { add: jest.fn() } as any,
    storage as any,
  );
  return { service, storage };
}

describe('AppBuildsService is organization-scoped', () => {
  it('finds the build for the organization that owns it', async () => {
    const { service } = makeService({ canPresign: true });

    await expect(service.findOne(OWNER, 'build-1')).resolves.toMatchObject({ id: 'build-1' });
  });

  it('is a 404 for another organization asking by the same id', async () => {
    const { service } = makeService({ canPresign: true });

    await expect(service.findOne(OUTSIDER, 'build-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('mints a storage link for the owner and nothing for an outsider', async () => {
    const { service, storage } = makeService({ canPresign: true });

    await expect(service.downloadUrl(OUTSIDER, 'build-1')).rejects.toBeInstanceOf(NotFoundException);
    // The leak would be the URL itself: it outlives the failed request.
    expect(storage.getSignedUrl).not.toHaveBeenCalled();

    await expect(service.downloadUrl(OWNER, 'build-1')).resolves.toBe(
      'https://cdn.example/object?sig=abc',
    );
  });

  it('never streams the artifact to an outsider', async () => {
    const { service, storage } = makeService({ canPresign: false });

    await expect(service.artifact(OUTSIDER, 'build-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.downloadStream).not.toHaveBeenCalled();

    const res = await service.artifact(OWNER, 'build-1');
    expect(res.filename).toContain('acme-support');
  });

  it('lists builds for the owner and is a 404 for an outsider naming the same slug', async () => {
    const { service } = makeService({ canPresign: true });

    await expect(service.list(OWNER, 'acme-support')).resolves.toHaveLength(1);
    await expect(service.list(OUTSIDER, 'acme-support')).rejects.toBeInstanceOf(NotFoundException);
  });
});
