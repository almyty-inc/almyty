import { NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';

import { AgentChannel } from '../../../entities/agent-channel.entity';
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
        channelId: 'channel-1',
        agentId: 'agent-1',
        target: 'tui',
        platform: 'linux-x64',
        status: BuildStatus.SUCCEEDED,
        version: '1.2.0',
        artifactKey: `app-builds/${OWNER}/channel-1/build-1.AppImage`,
        artifactBytes: '1024',
        artifactExpiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
      },
    ],
  });
  const channels = fakeRepository<any>({
    make: () => new AgentChannel(),
    seed: [{ id: 'channel-1', organizationId: OWNER, agentId: 'agent-1', slug: 'acme-support' }],
  });
  const storage = {
    canPresign: opts.canPresign,
    getSignedUrl: jest.fn().mockResolvedValue('https://cdn.example/object?sig=abc'),
    downloadStream: jest.fn(async () => Readable.from([Buffer.from('binary')])),
  };
  const service = new AppBuildsService(
    builds as any,
    channels as any,
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

  it('lists builds for the owner and nothing for an outsider naming the same channel', async () => {
    const { service } = makeService({ canPresign: true });

    await expect(service.list(OWNER, 'channel-1')).resolves.toHaveLength(1);
    await expect(service.list(OUTSIDER, 'channel-1')).resolves.toHaveLength(0);
  });
});
