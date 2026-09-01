import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AppBuild, BuildStatus } from '../../../entities/app-build.entity';
import { AppBuildsService, DOWNLOAD_URL_TTL_SECONDS } from '../app-builds.service';

/**
 * Handing back a link that actually resolves.
 *
 * This used to return `<base>/files/<storage-key>/download` on every
 * deployment, a route that takes a file record's id, so the link 404'd
 * for anyone not on object storage. These cover both storage shapes,
 * because the difference between them decides whether the download
 * works at all.
 */

const ORG = 'org-1';

function makeBuild(overrides: Partial<AppBuild> = {}): AppBuild {
  const build = Object.assign(new AppBuild(), {
    id: 'build-1',
    organizationId: ORG,
    appId: 'app-1',
    target: 'tui',
    platform: 'linux-x64',
    status: BuildStatus.SUCCEEDED,
    version: '1.2.0',
    artifactKey: `app-builds/${ORG}/app-1/build-1.AppImage`,
    artifactExpiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  });
  return build as AppBuild;
}

function makeService(opts: {
  build?: AppBuild | null;
  app?: { id: string; slug: string } | null;
  canPresign: boolean;
  bytes?: Buffer;
}) {
  const storage = {
    canPresign: opts.canPresign,
    getSignedUrl: jest.fn().mockResolvedValue('https://cdn.example/object?sig=abc'),
    download: jest.fn().mockResolvedValue(opts.bytes ?? Buffer.from('binary')),
  };

  const service = new AppBuildsService(
    { findOne: jest.fn().mockResolvedValue(opts.build ?? null) } as any,
    { findOne: jest.fn().mockResolvedValue(opts.app ?? { id: 'app-1', slug: 'acme-support' }) } as any,
    { findOne: jest.fn().mockResolvedValue(null) } as any,
    { add: jest.fn() } as any,
    storage as any,
  );

  return { service, storage };
}

describe('AppBuildsService download', () => {
  it('hands out a storage link when storage can mint one', async () => {
    const { service, storage } = makeService({ build: makeBuild(), canPresign: true });

    await expect(service.downloadUrl(ORG, 'build-1')).resolves.toBe(
      'https://cdn.example/object?sig=abc',
    );
    expect(storage.getSignedUrl).toHaveBeenCalledWith(
      `app-builds/${ORG}/app-1/build-1.AppImage`,
      DOWNLOAD_URL_TTL_SECONDS,
    );
  });

  it('points at the API when storage cannot mint one', async () => {
    // The bytes have to come from somewhere, and a local directory has
    // nothing to sign against.
    const { service, storage } = makeService({ build: makeBuild(), canPresign: false });

    await expect(service.downloadUrl(ORG, 'build-1')).resolves.toBe(
      '/apps/acme-support/builds/build-1/artifact',
    );
    expect(storage.getSignedUrl).not.toHaveBeenCalled();
  });

  it('addresses the API route by slug, not by app id', async () => {
    const { service } = makeService({
      build: makeBuild(),
      app: { id: 'app-1', slug: 'northwind-helpdesk' },
      canPresign: false,
    });

    await expect(service.downloadUrl(ORG, 'build-1')).resolves.toContain(
      '/apps/northwind-helpdesk/builds/',
    );
  });

  it('refuses a link for a build that has not finished', async () => {
    const { service } = makeService({
      build: makeBuild({ status: BuildStatus.RUNNING }),
      canPresign: true,
    });

    await expect(service.downloadUrl(ORG, 'build-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('says a failed build produced nothing rather than that it is unfinished', async () => {
    const { service } = makeService({
      build: makeBuild({ status: BuildStatus.FAILED }),
      canPresign: true,
    });

    await expect(service.downloadUrl(ORG, 'build-1')).rejects.toThrow(/failed/i);
  });

  it('refuses a link for an artifact that has expired', async () => {
    const { service } = makeService({
      build: makeBuild({ artifactExpiresAt: new Date(Date.now() - 1000) }),
      canPresign: true,
    });

    await expect(service.downloadUrl(ORG, 'build-1')).rejects.toThrow(/expired/i);
  });
});

describe('AppBuildsService artifact', () => {
  it('serves the stored bytes', async () => {
    const bytes = Buffer.from('ELF-ish');
    const { service, storage } = makeService({ build: makeBuild(), canPresign: false, bytes });

    const result = await service.artifact(ORG, 'build-1');

    expect(result.body).toBe(bytes);
    expect(storage.download).toHaveBeenCalledWith(`app-builds/${ORG}/app-1/build-1.AppImage`);
  });

  it('names the file after the product, not the row id', async () => {
    // This name lands in someone's Downloads folder next to everything
    // else they have ever downloaded.
    const { service } = makeService({ build: makeBuild(), canPresign: false });

    const { filename } = await service.artifact(ORG, 'build-1');

    expect(filename).toBe('acme-support-1.2.0-linux-x64.AppImage');
  });

  it('keeps the extension the build actually produced', async () => {
    const { service } = makeService({
      build: makeBuild({
        platform: 'macos-arm64',
        artifactKey: `app-builds/${ORG}/app-1/build-1.zip`,
      }),
      canPresign: false,
    });

    const { filename } = await service.artifact(ORG, 'build-1');

    expect(filename).toBe('acme-support-1.2.0-macos-arm64.zip');
  });

  it('falls back to a version rather than writing "null" into the name', async () => {
    const { service } = makeService({ build: makeBuild({ version: null }), canPresign: false });

    const { filename } = await service.artifact(ORG, 'build-1');

    expect(filename).toBe('acme-support-0.0.0-linux-x64.AppImage');
  });

  it('omits an extension when the key has none, rather than a bare dot', async () => {
    const { service } = makeService({
      build: makeBuild({ artifactKey: `app-builds/${ORG}/app-1/build-1` }),
      canPresign: false,
    });

    const { filename } = await service.artifact(ORG, 'build-1');

    expect(filename).toBe('acme-support-1.2.0-linux-x64');
  });

  it('enforces expiry on the bytes, not only on the link', async () => {
    // Otherwise the route is a way around the rule the link enforces.
    const { service, storage } = makeService({
      build: makeBuild({ artifactExpiresAt: new Date(Date.now() - 1000) }),
      canPresign: false,
    });

    await expect(service.artifact(ORG, 'build-1')).rejects.toThrow(/expired/i);
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('refuses to serve anything for a failed build', async () => {
    const { service, storage } = makeService({
      build: makeBuild({ status: BuildStatus.FAILED }),
      canPresign: false,
    });

    await expect(service.artifact(ORG, 'build-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('will not serve a build belonging to another organization', async () => {
    // findOne scopes by org and returns nothing, which must not become
    // a download.
    const { service } = makeService({ build: null, canPresign: false });

    await expect(service.artifact(ORG, 'build-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AppBuildsService capabilities', () => {
  /** A host where some tools are present and some are not. */
  function serviceWith(present: string[]) {
    const { service } = makeService({ canPresign: false });
    (service as any).toolchain = {
      available: jest.fn(async (tool: string) => present.includes(tool)),
      run: jest.fn(),
    };
    return service;
  }

  it('reports a host that can build and sign everything', async () => {
    const result = await serviceWith(['bun', 'npx', 'rcodesign', 'osslsigncode']).capabilities(
      'tui' as any,
    );

    expect(result.canBuild).toBe(true);
    expect(result.signing.every((s) => s.ready)).toBe(true);
  });

  it('names the tool a host is missing, before anyone presses Build', async () => {
    // The alternative is finding out from a failed build twenty minutes
    // later.
    const result = await serviceWith([]).capabilities('tui' as any);

    expect(result.canBuild).toBe(false);
    expect(result.buildReason).toContain('bun');
  });

  it('reports building and signing separately', async () => {
    // A host can compile perfectly well and still not be able to sign,
    // which is a different problem with a different fix.
    const result = await serviceWith(['bun']).capabilities('tui' as any);

    expect(result.canBuild).toBe(true);
    expect(result.signing.filter((s) => !s.ready).map((s) => s.kind).sort()).toEqual([
      'apple',
      'authenticode',
    ]);
  });

  it('answers per signing kind rather than per platform', async () => {
    // macos-arm64 and macos-x64 need the same tool; saying it twice
    // reads as two problems.
    const result = await serviceWith(['bun']).capabilities('tui' as any);

    expect(result.signing).toHaveLength(new Set(result.signing.map((s) => s.kind)).size);
  });

  it('says nothing about signing a target that needs none', async () => {
    const result = await serviceWith(['bun', 'npx']).capabilities('web' as any);
    expect(result.signing).toEqual([]);
  });

  it('refuses a target that produces no file at all', async () => {
    const result = await serviceWith(['bun', 'npx']).capabilities('slack' as any);
    expect(result.canBuild).toBe(false);
  });
});

describe('AppBuildsService capabilities in worker mode', () => {
  const orig = process.env.APP_BUILD_MODE;
  afterEach(() => { if (orig === undefined) delete process.env.APP_BUILD_MODE; else process.env.APP_BUILD_MODE = orig; });

  it('reports the worker toolchain, not this pod which has none', async () => {
    // An API pod delegating to a worker must not report "cannot build" —
    // it has no tools of its own to probe. The worker image carries the
    // full set.
    process.env.APP_BUILD_MODE = 'off';
    const { service } = makeService({ canPresign: false });
    (service as any).toolchain = { available: jest.fn(async () => false), run: jest.fn() };

    const desktop = await service.capabilities('desktop' as any);
    expect(desktop.canBuild).toBe(true);
    expect(desktop.signing.every((s) => s.ready)).toBe(true);
  });

  it('still says a web distribution builds nothing, even on a worker', async () => {
    process.env.APP_BUILD_MODE = 'worker';
    const { service } = makeService({ canPresign: false });
    (service as any).toolchain = { available: jest.fn(async () => true), run: jest.fn() };

    const web = await service.capabilities('web' as any);
    expect(web.canBuild).toBe(false);
  });
});
