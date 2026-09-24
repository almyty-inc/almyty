import { NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';

import { AgentApp } from '../../../entities/agent-app.entity';
import { AppBuild, BuildStatus } from '../../../entities/app-build.entity';
import { AppBuildsService } from '../app-builds.service';

/**
 * A build belongs to one organization, and only that organization can
 * reach it.
 *
 * Every read on this service carries `organizationId` in its `where`,
 * and nothing proved it: the doubles in the download and signing specs
 * are `{ findOne: jest.fn().mockResolvedValue(build) }`, which hands the
 * row back whatever the predicate says. Deleting `organizationId` from
 * `AppBuildsService.findOne` left all 17 agent-apps suites green.
 *
 * What is behind that predicate is a signed, distributable binary and a
 * presigned storage URL for it, so the repositories below evaluate the
 * `where` the way Postgres would.
 */

const OWNER = 'org-1';
const OUTSIDER = 'org-2';

const matchesWhere = (row: any, where: any): boolean =>
  (Array.isArray(where) ? where : [where]).some((clause) =>
    Object.entries(clause ?? {}).every(([column, value]) => row[column] === value),
  );

/** Returns clones, so a caller mutating a result cannot edit the table. */
function scopedRepo<T extends { id: string }>(rows: T[]) {
  const clone = (row: T) => Object.assign(Object.create(Object.getPrototypeOf(row)), row);
  return {
    rows,
    findOne: jest.fn(async ({ where }: any) => {
      const hit = rows.find((row) => matchesWhere(row, where));
      return hit ? clone(hit) : null;
    }),
    find: jest.fn(async ({ where }: any) =>
      rows.filter((row) => matchesWhere(row, where)).map(clone),
    ),
  } as any;
}

function makeBuild(overrides: Partial<AppBuild> = {}): AppBuild {
  return Object.assign(new AppBuild(), {
    id: 'build-1',
    organizationId: OWNER,
    appId: 'app-1',
    target: 'tui',
    platform: 'linux-x64',
    status: BuildStatus.SUCCEEDED,
    version: '1.2.0',
    artifactKey: `app-builds/${OWNER}/app-1/build-1.AppImage`,
    artifactBytes: 1024,
    artifactExpiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
    ...overrides,
  }) as AppBuild;
}

function makeApp(): AgentApp {
  return Object.assign(new AgentApp(), {
    id: 'app-1',
    organizationId: OWNER,
    slug: 'acme-support',
  }) as AgentApp;
}

function makeService(opts: { canPresign: boolean }) {
  const builds = scopedRepo([makeBuild()]);
  const apps = scopedRepo([makeApp()]);
  const storage = {
    canPresign: opts.canPresign,
    getSignedUrl: jest.fn().mockResolvedValue('https://cdn.example/object?sig=abc'),
    downloadStream: jest.fn(async () => Readable.from([Buffer.from('binary')])),
  };
  const service = new AppBuildsService(
    builds,
    apps,
    scopedRepo([]),
    { add: jest.fn() } as any,
    storage as any,
  );
  return { service, storage, builds, apps };
}

describe('AppBuildsService is organization-scoped', () => {
  describe('findOne', () => {
    it('finds the build for the organization that owns it', async () => {
      const { service } = makeService({ canPresign: true });

      await expect(service.findOne(OWNER, 'build-1')).resolves.toMatchObject({
        id: 'build-1',
        organizationId: OWNER,
      });
    });

    it('is a 404 for another organization asking by the same id', async () => {
      const { service } = makeService({ canPresign: true });

      await expect(service.findOne(OUTSIDER, 'build-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('downloadUrl', () => {
    it('mints a storage link for the owning organization', async () => {
      const { service, storage } = makeService({ canPresign: true });

      await expect(service.downloadUrl(OWNER, 'build-1')).resolves.toBe(
        'https://cdn.example/object?sig=abc',
      );
      expect(storage.getSignedUrl).toHaveBeenCalled();
    });

    it('mints nothing for an outsider — the presign never happens', async () => {
      const { service, storage } = makeService({ canPresign: true });

      await expect(service.downloadUrl(OUTSIDER, 'build-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // The leak would be the URL itself: it outlives the failed request.
      expect(storage.getSignedUrl).not.toHaveBeenCalled();
    });

    it('refuses the API route for an outsider too, not only the presigned one', async () => {
      const { service } = makeService({ canPresign: false });

      await expect(service.downloadUrl(OWNER, 'build-1')).resolves.toBe(
        '/apps/acme-support/builds/build-1/artifact',
      );
      await expect(service.downloadUrl(OUTSIDER, 'build-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('artifact', () => {
    it('streams the bytes to the owning organization', async () => {
      const { service, storage } = makeService({ canPresign: false });

      const res = await service.artifact(OWNER, 'build-1');

      expect(res.filename).toContain('acme-support');
      expect(storage.downloadStream).toHaveBeenCalledWith(
        `app-builds/${OWNER}/app-1/build-1.AppImage`,
      );
    });

    it('never reaches storage for an outsider', async () => {
      const { service, storage } = makeService({ canPresign: false });

      await expect(service.artifact(OUTSIDER, 'build-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(storage.downloadStream).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('lists the builds of the app it was asked for', async () => {
      const { service } = makeService({ canPresign: true });

      await expect(service.list(OWNER, 'acme-support')).resolves.toHaveLength(1);
    });

    it('is a 404 for an outsider naming the same slug', async () => {
      const { service, builds } = makeService({ canPresign: true });

      await expect(service.list(OUTSIDER, 'acme-support')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // The app lookup is the gate; the build table is never read.
      expect(builds.find).not.toHaveBeenCalled();
    });
  });
});
